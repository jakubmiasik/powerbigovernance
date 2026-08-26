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

// ── Rule groups ──
//
// The shape of a control, independent of which systems it happens to touch.
// Reconciliation practice names a small number of recurring patterns, and naming
// the pattern is what lets someone read a wall of rules and see coverage: an
// estate with forty Left-to-Right controls and no Right-to-Left one is checking
// that nothing was lost and not noticing what was invented.
const RULE_GROUP_DEFS = [
  {
    key: 'start_to_start', label: 'Start-to-Start',
    description: 'Two systems compared at the same point at the start of a process — both should have received the same feed.',
  },
  {
    key: 'start_to_end', label: 'Start-to-End',
    description: 'What entered the process against what came out of it, across every step in between.',
  },
  {
    key: 'end_to_end', label: 'End-to-End',
    description: 'The final state of two systems that must agree once all processing has settled.',
  },
  {
    key: 'point_to_point', label: 'Point-to-Point',
    description: 'Two adjacent hand-off points inside a longer chain, to locate where a break happened.',
  },
  {
    key: 'left_to_right', label: 'Left-to-Right',
    description: 'Completeness: everything present in the source has arrived in the target.',
  },
  {
    key: 'right_to_left', label: 'Right-to-Left',
    description: 'Existence: nothing sits in the target that did not come from the source.',
  },
  {
    key: 'aggregate_to_detail', label: 'Aggregate-to-Detail',
    description: 'A summarised or synthetic balance against the detailed records that make it up.',
  },
  {
    key: 'period_over_period', label: 'Period-over-Period',
    description: 'The same population in two periods, to show movement rather than a fixed expectation.',
  },
  {
    key: 'ungrouped', label: 'Ungrouped',
    description: 'No pattern chosen yet. Rules stay usable, but they do not roll up with anything.',
  },
];

const DEFAULT_RULE_GROUP = 'ungrouped';
const RULE_GROUP_BY_KEY = new Map(RULE_GROUP_DEFS.map(def => [def.key, def]));

function normalizeRuleGroup(value) {
  const key = String(value || '').trim().toLowerCase();
  return RULE_GROUP_BY_KEY.has(key) ? key : DEFAULT_RULE_GROUP;
}

function ruleGroupLabel(value) {
  return (RULE_GROUP_BY_KEY.get(normalizeRuleGroup(value)) || {}).label || 'Ungrouped';
}

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
//   aggregate   a function over the rows sharing a business key, e.g. SUM(Amount)
const OPERAND_KINDS = ['field', 'expression', 'constant', 'aggregate'];

// ── Aggregates ──
//
// The two systems often hold the same fact at different grains: an analytical
// ledger with one row per posting, and a synthetic balance with one row per
// account. Comparing them row by row is meaningless — the control is
// SUM(amount) per account on the left against amount on the right.
//
// The aggregation is pushed down to the source rather than done here: the
// database groups far better than this process can, and reading a million
// postings to add them up in JavaScript is exactly the cost the grouping exists
// to avoid. A side that aggregates is grouped by everything it selects that
// does not — which always includes the business key.
const AGGREGATE_DEFS = [
  { key: 'sum', label: 'Sum', sql: 'SUM', needsValue: true },
  { key: 'count', label: 'Count', sql: 'COUNT', needsValue: false },
  { key: 'count_distinct', label: 'Count distinct', sql: 'COUNT', distinct: true, needsValue: true },
  { key: 'avg', label: 'Average', sql: 'AVG', needsValue: true },
  { key: 'min', label: 'Minimum', sql: 'MIN', needsValue: true },
  { key: 'max', label: 'Maximum', sql: 'MAX', needsValue: true },
];

const AGGREGATE_BY_KEY = new Map(AGGREGATE_DEFS.map(def => [def.key, def]));

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
    const normalized = { kind: operand.kind, value: operand.value === undefined ? '' : operand.value };
    if (operand.kind === 'aggregate') {
      normalized.fn = String(operand.fn || 'sum').trim().toLowerCase();
      // What is inside the function can itself be a column or an expression —
      // SUM(Amount) and SUM(CASE WHEN Reversed = 0 THEN Amount ELSE 0 END) are
      // both things a control legitimately wants to say.
      normalized.valueKind = operand.valueKind === 'expression' ? 'expression' : 'field';
    }
    return normalized;
  }
  // Rules written before expressions and constants existed stored a plain column.
  return { kind: 'field', value: legacyField || '' };
}

/**
 * The SQL for one aggregate operand.
 *
 * The function itself comes from a fixed list rather than the rule text, so a
 * rule author choosing "sum" can never turn the projection into something else.
 */
function aggregateSql(operand) {
  const def = AGGREGATE_BY_KEY.get(operand.fn);
  if (!def) throw new Error('Unsupported aggregate function in rule definition: "' + operand.fn + '"');

  const inner = String(operand.value === undefined || operand.value === null ? '' : operand.value).trim();
  if (!inner) {
    // Counting nothing in particular means counting the rows in the group.
    if (def.needsValue) throw new Error(def.label + ' needs a field or expression to aggregate.');
    return 'COUNT(*)';
  }
  const target = operand.valueKind === 'expression' ? '(' + inner + ')' : quoteIdentifier(inner);
  return def.sql + '(' + (def.distinct ? 'DISTINCT ' : '') + target + ')';
}

function describeAggregate(operand) {
  const def = AGGREGATE_BY_KEY.get(operand.fn);
  const name = def ? def.label.toLowerCase() : String(operand.fn || 'aggregate');
  const inner = String(operand.value || '').trim();
  return name + '(' + (inner || '*') + ') per business key';
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
  if (operand.kind === 'aggregate') return describeAggregate(operand);
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

  // Everything selected that is not itself an aggregate has to be grouped by, or
  // the database rejects the query. Collected here so the GROUP BY is derived from
  // the projection rather than restated — the two cannot drift apart.
  const grouped = [];
  let aggregates = false;

  const projection = list.map(selection => {
    const alias = quoteIdentifier(selection.alias || selection.value);
    if (selection.kind === 'aggregate') {
      aggregates = true;
      return aggregateSql(selection) + ' AS ' + alias;
    }
    // Expressions are validated by validateSqlExpression when the rule is saved;
    // wrapping keeps each one a single value within the SELECT list.
    const term = selection.kind === 'expression'
      ? '(' + String(selection.value).trim() + ')'
      : quoteIdentifier(selection.value);
    grouped.push(term);
    return term + ' AS ' + alias;
  });

  const top = Number.parseInt(rowLimit, 10);
  const topClause = Number.isFinite(top) && top > 0 ? 'TOP (' + Math.min(top, 200000) + ') ' : '';
  let sql = 'SELECT ' + topClause + projection.join(', ') + ' FROM ' + quoteIdentifier(dataset);
  if (aggregates && grouped.length) sql += ' GROUP BY ' + grouped.join(', ');
  return sql;
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
    if (field.a.kind !== 'constant') selectionsA.push({ alias: aliasA, ...field.a });
    if (field.b.kind !== 'constant') selectionsB.push({ alias: aliasB, ...field.b });

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

  // A side that aggregates returns one row per business key by construction, so
  // duplicates on that side cannot occur — the rule's duplicate handling has
  // nothing left to act on there, and the run should be able to say so.
  const aggregatedA = selectionsA.some(selection => selection.kind === 'aggregate');
  const aggregatedB = selectionsB.some(selection => selection.kind === 'aggregate');

  return {
    selectionsA,
    selectionsB,
    aggregatedA,
    aggregatedB,
    engineRule: {
      ...rule,
      keyFieldA: KEY_ALIAS,
      keyFieldB: KEY_ALIAS,
      compareFields: engineFields,
      aggregatedA,
      aggregatedB,
    },
  };
}

// Every problem with a rule's comparison definition, so the author sees them all
// at once rather than one per save.
function validateCompareFields(compareFields) {
  const problems = [];
  const fields = (compareFields || []).map(normalizeCompareField);

  fields.forEach((field, index) => {
    const position = 'Value ' + (index + 1) + ' (' + field.label + ')';
    ['a', 'b'].forEach(side => {
      const operand = field[side];
      const label = position + ' — source ' + side.toUpperCase();

      if (operand.kind === 'aggregate') {
        const def = AGGREGATE_BY_KEY.get(operand.fn);
        if (!def) {
          problems.push(label + ': "' + operand.fn + '" is not an aggregate this engine can use.');
          return;
        }
        const inner = String(operand.value || '').trim();
        if (!inner) {
          if (def.needsValue) problems.push(label + ': ' + def.label + ' needs a field or expression to aggregate.');
          return; // COUNT(*) is complete on its own.
        }
        if (operand.valueKind === 'expression') {
          const problem = validateSqlExpression(inner);
          if (problem) problems.push(label + ': ' + problem);
        } else {
          try { quoteIdentifier(inner); } catch (err) { problems.push(label + ': ' + err.message); }
        }
        return;
      }

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

  // Aggregating anything on one side groups that whole side by the business key,
  // so a plain column read alongside it would silently be added to the grouping —
  // splitting one business key into several rows and raising duplicates that only
  // exist because of how the rule was written. Refuse it and say why.
  ['a', 'b'].forEach(side => {
    const readsSource = fields.filter(field => field[side].kind !== 'constant');
    const aggregated = readsSource.filter(field => field[side].kind === 'aggregate');
    if (!aggregated.length || aggregated.length === readsSource.length) return;

    const plain = readsSource
      .filter(field => field[side].kind !== 'aggregate')
      .map(field => field.label)
      .join(', ');
    problems.push('Source ' + side.toUpperCase() + ' is grouped by the business key because '
      + aggregated.length + ' value(s) use an aggregate, so every other value read from it must aggregate too '
      + '(or be a fixed value). Not aggregated: ' + plain + '.');
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
  AGGREGATE_DEFS,
  AGGREGATE_BY_KEY,
  aggregateSql,
  describeOperand,
  RULE_GROUP_DEFS,
  RULE_GROUP_BY_KEY,
  DEFAULT_RULE_GROUP,
  normalizeRuleGroup,
  ruleGroupLabel,
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
