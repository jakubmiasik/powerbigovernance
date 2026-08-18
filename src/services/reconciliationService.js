// Reconciliation engine.
//
// Given the rows read from two business systems and a rule describing how they
// correspond, this decides which records agree, which do not, and why. It is pure:
// no database, no API, no clock — so the business logic that decides whether a
// finance control passed can be tested directly.

const OUTCOME = {
  MATCH: 'match',
  MISSING_FROM_A: 'missing_from_a',
  MISSING_FROM_B: 'missing_from_b',
  VALUE_MISMATCH: 'value_mismatch',
  DUPLICATE: 'duplicate',
  INVALID_KEY: 'invalid_key',
};

// Business meaning of each outcome, shown wherever exceptions are listed.
const OUTCOME_DEFS = [
  { key: OUTCOME.MATCH, label: 'Match', severity: 'none', description: 'The record exists in both systems and all required values are aligned.' },
  { key: OUTCOME.MISSING_FROM_A, label: 'Missing from source A', severity: 'high', description: 'The record exists in the second system but is absent from the first.' },
  { key: OUTCOME.MISSING_FROM_B, label: 'Missing from source B', severity: 'high', description: 'The record exists in the first system but is absent from the second.' },
  { key: OUTCOME.VALUE_MISMATCH, label: 'Value mismatch', severity: 'medium', description: 'The record exists in both systems, but one or more selected values differ.' },
  { key: OUTCOME.DUPLICATE, label: 'Duplicate record', severity: 'medium', description: 'More than one record uses the same business identifier in one or both systems.' },
  { key: OUTCOME.INVALID_KEY, label: 'Invalid or incomplete key', severity: 'low', description: 'A record cannot be matched reliably because its business identifier is missing or invalid.' },
];

const OUTCOME_BY_KEY = new Map(OUTCOME_DEFS.map(def => [def.key, def]));

const EXCEPTION_STATUS = {
  OPEN: 'open',
  ACKNOWLEDGED: 'acknowledged',
  INVESTIGATING: 'investigating',
  RESOLVED: 'resolved',
  ACCEPTED: 'accepted',
};

// The controlled lifecycle an exception may follow. Anything not listed here is
// refused, so the audit trail cannot contain a transition the process disallows.
const STATUS_DEFS = [
  { key: EXCEPTION_STATUS.OPEN, label: 'Open', color: 'danger', description: 'Newly identified and awaiting review.', next: [EXCEPTION_STATUS.ACKNOWLEDGED, EXCEPTION_STATUS.INVESTIGATING, EXCEPTION_STATUS.RESOLVED, EXCEPTION_STATUS.ACCEPTED] },
  { key: EXCEPTION_STATUS.ACKNOWLEDGED, label: 'Acknowledged', color: 'warning', description: 'Accepted by an assigned owner.', next: [EXCEPTION_STATUS.INVESTIGATING, EXCEPTION_STATUS.RESOLVED, EXCEPTION_STATUS.ACCEPTED, EXCEPTION_STATUS.OPEN] },
  { key: EXCEPTION_STATUS.INVESTIGATING, label: 'In investigation', color: 'info', description: 'Being analysed or corrected.', next: [EXCEPTION_STATUS.RESOLVED, EXCEPTION_STATUS.ACCEPTED, EXCEPTION_STATUS.OPEN] },
  { key: EXCEPTION_STATUS.RESOLVED, label: 'Resolved', color: 'success', description: 'The cause has been addressed or confirmed as no longer relevant.', next: [EXCEPTION_STATUS.OPEN] },
  { key: EXCEPTION_STATUS.ACCEPTED, label: 'Ignored / accepted', color: 'secondary', description: 'A valid, documented business reason exists for the difference.', next: [EXCEPTION_STATUS.OPEN] },
];

const STATUS_BY_KEY = new Map(STATUS_DEFS.map(def => [def.key, def]));
const CLOSED_STATUSES = new Set([EXCEPTION_STATUS.RESOLVED, EXCEPTION_STATUS.ACCEPTED]);

const RULE_STATUS = { DRAFT: 'draft', ACTIVE: 'active', RETIRED: 'retired' };

function isStatusTransitionAllowed(from, to) {
  if (from === to) return false;
  const def = STATUS_BY_KEY.get(from);
  return !!def && def.next.includes(to);
}

// ── Comparison operands ──
//
// Each side of a comparison is one of:
//   field       a column in that source
//   expression  raw SQL evaluated by the source, e.g. TRIM(Customer) or CASE WHEN…
//   constant    a fixed value, for checking a column against an expected value
const OPERAND_KINDS = ['field', 'expression', 'constant'];

// Statement terminators, comment markers and anything that writes. A rule author
// is trusted to write SQL, but a single expression should not be able to become
// several statements or modify data — this is a guardrail on an intentionally
// powerful feature, not a sandbox.
const FORBIDDEN_EXPRESSION_PATTERNS = [
  { pattern: /;/, reason: 'statement separators are not allowed' },
  { pattern: /--/, reason: 'SQL comments are not allowed' },
  { pattern: /\/\*|\*\//, reason: 'block comments are not allowed' },
  { pattern: /\b(insert|update|delete|drop|alter|create|truncate|merge|exec|execute|grant|revoke|backup|shutdown|waitfor|openrowset|openquery|xp_\w+|sp_\w+)\b/i, reason: 'only read-only expressions are allowed' },
];

function validateSqlExpression(expression) {
  const text = String(expression || '').trim();
  if (!text) return 'The expression is empty.';
  if (text.length > 1000) return 'The expression is too long (limit 1000 characters).';
  for (const rule of FORBIDDEN_EXPRESSION_PATTERNS) {
    if (rule.pattern.test(text)) return 'Cannot use this expression: ' + rule.reason + '.';
  }
  // Unbalanced brackets would break the surrounding SELECT.
  let depth = 0;
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth < 0) return 'The expression has unbalanced parentheses.';
  }
  if (depth !== 0) return 'The expression has unbalanced parentheses.';
  return null;
}

function normalizeOperand(operand, legacyField) {
  if (operand && OPERAND_KINDS.includes(operand.kind)) {
    return { kind: operand.kind, value: operand.value === undefined ? '' : operand.value };
  }
  // Rules written before expressions and constants existed stored a plain column.
  return { kind: 'field', value: legacyField || '' };
}

function normalizeCompareField(field, index) {
  const a = normalizeOperand(field.a, field.fieldA);
  const b = normalizeOperand(field.b, field.fieldB);
  return {
    label: field.label || a.value || b.value || ('Value ' + (index + 1)),
    a,
    b,
    type: field.type || 'string',
    tolerance: field.tolerance || null,
    caseInsensitive: field.caseInsensitive,
    trim: field.trim,
  };
}

function describeOperand(operand) {
  if (operand.kind === 'constant') return 'constant "' + operand.value + '"';
  if (operand.kind === 'expression') return 'expression ' + operand.value;
  return operand.value;
}

const KEY_ALIAS = 'recon_key';
function compareAlias(index, side) { return 'recon_c' + index + side; }

// Identifiers reach the query as text, so they are checked against a conservative
// pattern and bracket-quoted rather than concatenated in raw.
function quoteIdentifier(identifier) {
  const text = String(identifier || '').trim();
  if (!text || !/^[A-Za-z0-9_ .$#@-]+$/.test(text)) {
    throw new Error('Unsupported identifier in rule definition: "' + identifier + '"');
  }
  return text.split('.').map(part => '[' + part.trim() + ']').join('.');
}

/**
 * The SELECT a planned rule needs from one source.
 *
 * Shared by every kind of source — a Fabric SQL analytics endpoint and a registered
 * external database must read the same shape, or the two sides of a comparison
 * would not line up. Pure text, so it can be asserted on directly.
 */
function buildSelectSql({ dataset, selections, columns, rowLimit }) {
  const list = selections && selections.length
    ? selections
    : (columns || []).filter(Boolean).map(name => ({ alias: name, kind: 'field', value: name }));
  if (!list.length) throw new Error('No columns selected to read.');

  const projection = list.map(selection => {
    const alias = quoteIdentifier(selection.alias || selection.value);
    if (selection.kind === 'expression') {
      // Validated by validateSqlExpression when the rule was saved; wrapping keeps
      // it a single value within the SELECT list.
      return '(' + String(selection.value).trim() + ') AS ' + alias;
    }
    return quoteIdentifier(selection.value) + ' AS ' + alias;
  });

  const top = Number.parseInt(rowLimit, 10);
  const topClause = Number.isFinite(top) && top > 0 ? 'TOP (' + Math.min(top, 200000) + ') ' : '';
  return 'SELECT ' + topClause + projection.join(', ') + ' FROM ' + quoteIdentifier(dataset);
}

/**
 * Work out what each source must return, and rewrite the rule to read those
 * results by alias.
 *
 * Aliasing matters for more than tidiness: the two systems name the same business
 * value differently, expressions have no natural name at all, and a constant is
 * never selected. Planning it once here keeps the engine reading plain row keys.
 */
function planRule(rule) {
  const fields = (rule.compareFields || []).map(normalizeCompareField);
  const selectionsA = [{ alias: KEY_ALIAS, kind: 'field', value: rule.keyFieldA || rule.keyField }];
  const selectionsB = [{ alias: KEY_ALIAS, kind: 'field', value: rule.keyFieldB || rule.keyField }];

  const engineFields = fields.map((field, index) => {
    const aliasA = compareAlias(index, 'a');
    const aliasB = compareAlias(index, 'b');
    if (field.a.kind !== 'constant') selectionsA.push({ alias: aliasA, kind: field.a.kind, value: field.a.value });
    if (field.b.kind !== 'constant') selectionsB.push({ alias: aliasB, kind: field.b.kind, value: field.b.value });

    const planned = {
      label: field.label,
      type: field.type,
      tolerance: field.tolerance,
      caseInsensitive: field.caseInsensitive,
      trim: field.trim,
      fieldA: aliasA,
      fieldB: aliasB,
      describeA: describeOperand(field.a),
      describeB: describeOperand(field.b),
    };
    if (field.a.kind === 'constant') planned.constantA = field.a.value;
    if (field.b.kind === 'constant') planned.constantB = field.b.value;
    return planned;
  });

  return {
    selectionsA,
    selectionsB,
    engineRule: { ...rule, keyFieldA: KEY_ALIAS, keyFieldB: KEY_ALIAS, compareFields: engineFields },
  };
}

// Every problem with a rule's comparison definition, so the author sees them all
// at once rather than one per save.
function validateCompareFields(compareFields) {
  const problems = [];
  (compareFields || []).forEach((raw, index) => {
    const field = normalizeCompareField(raw, index);
    const position = 'Value ' + (index + 1) + ' (' + field.label + ')';
    ['a', 'b'].forEach(side => {
      const operand = field[side];
      const label = position + ' — source ' + side.toUpperCase();
      if (!String(operand.value || '').trim() && operand.kind !== 'constant') {
        problems.push(label + ': choose a field or write an expression.');
        return;
      }
      if (operand.kind === 'expression') {
        const problem = validateSqlExpression(operand.value);
        if (problem) problems.push(label + ': ' + problem);
      }
    });
    // Comparing one fixed value with another proves nothing about the data.
    if (field.a.kind === 'constant' && field.b.kind === 'constant') {
      problems.push(position + ': both sides are constants, so nothing from either system is checked.');
    }
  });
  return problems;
}

function normalizeKey(value, options = {}) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (options.trim !== false) text = text.trim();
  if (options.caseInsensitive !== false) text = text.toLowerCase();
  return text;
}

function isBlankKey(value) {
  return normalizeKey(value) === '';
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value).replace(/[\s,]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function toDateValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/**
 * Compare one field across the two systems.
 *
 * Tolerance lets a control accept differences the business has agreed are
 * immaterial — a rounding difference on tax, say — without hiding the fact that
 * the values are not identical.
 */
function compareValues(valueA, valueB, field) {
  const type = field.type || 'string';
  const bothMissing = (valueA === null || valueA === undefined || valueA === '')
    && (valueB === null || valueB === undefined || valueB === '');
  if (bothMissing) return { equal: true, difference: null };

  if (type === 'number') {
    const numberA = toNumber(valueA);
    const numberB = toNumber(valueB);
    if (numberA === null || numberB === null) {
      return { equal: false, difference: null, reason: 'One side is not a usable number' };
    }
    const difference = numberB - numberA;
    const tolerance = field.tolerance || null;
    if (tolerance && Number.isFinite(Number(tolerance.value))) {
      const limit = Number(tolerance.value);
      if (tolerance.type === 'percent') {
        const base = Math.abs(numberA);
        // A percentage tolerance against zero has no meaning; fall back to exact.
        const allowed = base === 0 ? 0 : (base * limit) / 100;
        if (Math.abs(difference) <= allowed) return { equal: true, difference, withinTolerance: true };
      } else if (Math.abs(difference) <= limit) {
        return { equal: true, difference, withinTolerance: true };
      }
    }
    return { equal: difference === 0, difference };
  }

  if (type === 'date') {
    const dateA = toDateValue(valueA);
    const dateB = toDateValue(valueB);
    if (dateA === null || dateB === null) {
      return { equal: false, difference: null, reason: 'One side is not a usable date' };
    }
    const days = Math.round((dateB - dateA) / (24 * 60 * 60 * 1000));
    const tolerance = field.tolerance || null;
    if (tolerance && Number.isFinite(Number(tolerance.value)) && Math.abs(days) <= Number(tolerance.value)) {
      return { equal: true, difference: days, withinTolerance: true };
    }
    return { equal: days === 0, difference: days };
  }

  const textA = normalizeKey(valueA, field);
  const textB = normalizeKey(valueB, field);
  return { equal: textA === textB, difference: null };
}

function indexRows(rows, keyField, keyOptions) {
  const byKey = new Map();
  const invalid = [];
  rows.forEach((row, position) => {
    const rawKey = row ? row[keyField] : undefined;
    if (isBlankKey(rawKey)) {
      invalid.push({ position, row });
      return;
    }
    const key = normalizeKey(rawKey, keyOptions);
    if (!byKey.has(key)) byKey.set(key, { key, displayKey: String(rawKey).trim(), rows: [] });
    byKey.get(key).rows.push(row);
  });
  return { byKey, invalid };
}

// A constant operand has no column to read: its value is the same for every row.
function operandValueOf(row, field, side) {
  const constant = side === 'a' ? field.constantA : field.constantB;
  if (constant !== undefined) return constant;
  const name = side === 'a' ? field.fieldA : field.fieldB;
  return row ? row[name] : null;
}

function pickFields(row, fields, side) {
  const picked = {};
  for (const field of fields) {
    const name = side === 'a' ? field.fieldA : field.fieldB;
    picked[field.label || name] = operandValueOf(row, field, side);
  }
  return picked;
}

function severityFor(outcome, rule) {
  const base = (OUTCOME_BY_KEY.get(outcome) || {}).severity || 'medium';
  // A high-priority control raises the stakes of everything it finds.
  if ((rule.priority || '').toLowerCase() === 'high' && base === 'medium') return 'high';
  if ((rule.priority || '').toLowerCase() === 'low' && base === 'high') return 'medium';
  return base;
}

/**
 * Reconcile two sets of rows under one rule.
 *
 * Returns a summary suitable for the run record plus one exception per business
 * item needing attention. Matches are counted, never listed: the point is to give
 * people the items that need work, not everything that was checked.
 */
function reconcile({ rowsA = [], rowsB = [], rule = {} }) {
  const keyFieldA = rule.keyFieldA || rule.keyField;
  const keyFieldB = rule.keyFieldB || rule.keyField;
  const compareFields = rule.compareFields || [];
  const duplicateHandling = rule.duplicateHandling || 'exception';
  const incompleteKeyHandling = rule.incompleteKeyHandling || 'exception';
  const keyOptions = { caseInsensitive: rule.keyCaseInsensitive !== false, trim: true };

  if (!keyFieldA || !keyFieldB) {
    throw new Error('The rule must name the business key field in both sources.');
  }

  const indexA = indexRows(rowsA, keyFieldA, keyOptions);
  const indexB = indexRows(rowsB, keyFieldB, keyOptions);

  const exceptions = [];
  const counts = {
    [OUTCOME.MATCH]: 0,
    [OUTCOME.MISSING_FROM_A]: 0,
    [OUTCOME.MISSING_FROM_B]: 0,
    [OUTCOME.VALUE_MISMATCH]: 0,
    [OUTCOME.DUPLICATE]: 0,
    [OUTCOME.INVALID_KEY]: 0,
  };

  const addException = (outcome, businessKey, detail) => {
    counts[outcome] += 1;
    exceptions.push({
      outcome,
      businessKey,
      severity: severityFor(outcome, rule),
      ...detail,
    });
  };

  // Records whose identifier cannot be trusted are reported separately: matching
  // them on a blank key would invent relationships that do not exist.
  if (incompleteKeyHandling !== 'ignore') {
    for (const entry of indexA.invalid) {
      addException(OUTCOME.INVALID_KEY, '(missing key)', {
        side: 'A',
        valuesA: pickFields(entry.row, compareFields, 'a'),
        valuesB: null,
        differences: [{ field: keyFieldA, reason: 'Business key is missing or blank in source A' }],
      });
    }
    for (const entry of indexB.invalid) {
      addException(OUTCOME.INVALID_KEY, '(missing key)', {
        side: 'B',
        valuesA: null,
        valuesB: pickFields(entry.row, compareFields, 'b'),
        differences: [{ field: keyFieldB, reason: 'Business key is missing or blank in source B' }],
      });
    }
  }

  const allKeys = new Set([...indexA.byKey.keys(), ...indexB.byKey.keys()]);
  for (const key of allKeys) {
    const groupA = indexA.byKey.get(key);
    const groupB = indexB.byKey.get(key);
    const displayKey = (groupA && groupA.displayKey) || (groupB && groupB.displayKey) || key;

    const duplicatedA = groupA && groupA.rows.length > 1;
    const duplicatedB = groupB && groupB.rows.length > 1;
    if ((duplicatedA || duplicatedB) && duplicateHandling === 'exception') {
      addException(OUTCOME.DUPLICATE, displayKey, {
        valuesA: groupA ? pickFields(groupA.rows[0], compareFields, 'a') : null,
        valuesB: groupB ? pickFields(groupB.rows[0], compareFields, 'b') : null,
        differences: [{
          field: 'business key',
          reason: 'Found ' + (groupA ? groupA.rows.length : 0) + ' record(s) in source A and '
            + (groupB ? groupB.rows.length : 0) + ' in source B for this identifier',
        }],
        countA: groupA ? groupA.rows.length : 0,
        countB: groupB ? groupB.rows.length : 0,
      });
      continue;
    }
    if ((duplicatedA || duplicatedB) && duplicateHandling === 'ignore') continue;

    if (!groupA) {
      addException(OUTCOME.MISSING_FROM_A, displayKey, {
        valuesA: null,
        valuesB: pickFields(groupB.rows[0], compareFields, 'b'),
        differences: [{ field: 'record', reason: 'Present in source B, absent from source A' }],
      });
      continue;
    }
    if (!groupB) {
      addException(OUTCOME.MISSING_FROM_B, displayKey, {
        valuesA: pickFields(groupA.rows[0], compareFields, 'a'),
        valuesB: null,
        differences: [{ field: 'record', reason: 'Present in source A, absent from source B' }],
      });
      continue;
    }

    // 'first' duplicate handling compares the first row on each side.
    const rowA = groupA.rows[0];
    const rowB = groupB.rows[0];
    const differences = [];
    for (const field of compareFields) {
      const valueA = operandValueOf(rowA, field, 'a');
      const valueB = operandValueOf(rowB, field, 'b');
      const result = compareValues(valueA, valueB, field);
      if (!result.equal) {
        differences.push({
          field: field.label || field.fieldA,
          valueA,
          valueB,
          difference: result.difference,
          reason: result.reason || null,
        });
      }
    }

    if (differences.length) {
      addException(OUTCOME.VALUE_MISMATCH, displayKey, {
        valuesA: pickFields(rowA, compareFields, 'a'),
        valuesB: pickFields(rowB, compareFields, 'b'),
        differences,
      });
    } else {
      counts[OUTCOME.MATCH] += 1;
    }
  }

  exceptions.sort((a, b) => String(a.businessKey).localeCompare(String(b.businessKey)));

  return {
    summary: {
      recordsA: rowsA.length,
      recordsB: rowsB.length,
      keysCompared: allKeys.size,
      matched: counts[OUTCOME.MATCH],
      exceptions: exceptions.length,
      counts,
      // A control is only "passed" when nothing needs attention.
      passed: exceptions.length === 0,
    },
    exceptions,
  };
}

// A stable identity for an exception across runs, so the same unresolved item is
// recognised next time rather than being raised again as new.
function exceptionFingerprint(ruleId, exception) {
  return [ruleId, exception.outcome, String(exception.businessKey).toLowerCase(), exception.side || ''].join('|');
}

module.exports = {
  OPERAND_KINDS,
  KEY_ALIAS,
  quoteIdentifier,
  buildSelectSql,
  validateSqlExpression,
  normalizeCompareField,
  validateCompareFields,
  planRule,
  OUTCOME,
  OUTCOME_DEFS,
  OUTCOME_BY_KEY,
  EXCEPTION_STATUS,
  STATUS_DEFS,
  STATUS_BY_KEY,
  CLOSED_STATUSES,
  RULE_STATUS,
  isStatusTransitionAllowed,
  compareValues,
  reconcile,
  exceptionFingerprint,
};
