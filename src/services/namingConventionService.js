/**
 * Naming conventions for Fabric artifacts.
 *
 * Fabric imposes no naming rules of its own. Everything lands in the same
 * workspace, so without a convention a tenant becomes a list of names that only
 * their authors can interpret — and the cost is not aesthetic: nobody can tell
 * which lakehouse holds bronze data, or which pipeline feeds which layer, without
 * opening each one.
 *
 * The default below is the convention from the attached document:
 *
 *     EXPERIENCE _ ARTIFACT _ INDEX _ STAGE _ DESCRIPTION
 *     DE_LH_100_BRONZE_SALES
 *
 * but every part of it is configurable, because a convention nobody chose is one
 * nobody follows. This module holds the shape, the checking and the suggesting.
 * Pure: no database, no API, no clock.
 */

// The segments a name can be built from, in the order the default uses them.
// `key` is what the stored convention refers to; the rest is how it is explained.
const SEGMENT_DEFS = [
  {
    key: 'experience',
    label: 'Experience',
    description: 'Which Fabric experience the artifact belongs to — PBI, DE, DW.',
  },
  {
    key: 'artifact',
    label: 'Artifact',
    description: 'What kind of thing it is — LH for a lakehouse, PL for a pipeline.',
  },
  {
    key: 'index',
    label: 'Index',
    description: 'An ordering number, usually 100 to 900, so related items sort together.',
  },
  {
    key: 'stage',
    label: 'Stage',
    description: 'Which layer of the medallion architecture it serves — BRONZE, SILVER, GOLD.',
  },
  {
    key: 'description',
    label: 'Description',
    description: 'What it is for, in business terms — SALES, FINANCE, SOURCE_TO_BRONZE.',
  },
];

const SEGMENT_BY_KEY = new Map(SEGMENT_DEFS.map(def => [def.key, def]));

// The experiences from the document. Codes, not names, because the code is what
// goes in the artifact name.
const DEFAULT_EXPERIENCES = [
  { code: 'PBI', label: 'Power BI' },
  { code: 'DF', label: 'Data Factory' },
  { code: 'DE', label: 'Synapse Data Engineering' },
  { code: 'DS', label: 'Synapse Data Science' },
  { code: 'DW', label: 'Synapse Data Warehouse' },
  { code: 'RTA', label: 'Synapse Real-Time Analytics' },
  { code: 'DA', label: 'Data Activator' },
];

/**
 * Artifact codes, and which Fabric item types each covers.
 *
 * `itemTypes` is what makes a suggestion possible: the scan knows an item is a
 * Lakehouse, so the convention can say the name should start `DE_LH`. Without it
 * a checker could only say a name is wrong, never what it should be.
 *
 * Reports and dashboards are not in the source document, which lists only DS, DFL
 * and DM under Power BI. They are included here because a convention that cannot
 * name a report is unusable in a Power BI tenant — and like everything else, they
 * can be edited or removed.
 */
const DEFAULT_ARTIFACTS = [
  { code: 'DS', label: 'Semantic model', experience: 'PBI', itemTypes: ['SemanticModel', 'Dataset'] },
  { code: 'RPT', label: 'Report', experience: 'PBI', itemTypes: ['Report', 'PaginatedReport'] },
  { code: 'DSH', label: 'Dashboard', experience: 'PBI', itemTypes: ['Dashboard'] },
  { code: 'DFL', label: 'Data flow', experience: 'DF', itemTypes: ['Dataflow', 'DataflowGen2', 'Datagen2'] },
  { code: 'DM', label: 'Data mart', experience: 'PBI', itemTypes: ['Datamart'] },
  { code: 'PL', label: 'Pipeline', experience: 'DF', itemTypes: ['DataPipeline'] },
  { code: 'CJ', label: 'Copy job', experience: 'DF', itemTypes: ['CopyJob'] },
  { code: 'LH', label: 'Lakehouse', experience: 'DE', itemTypes: ['Lakehouse'] },
  { code: 'NB', label: 'Notebook', experience: 'DE', itemTypes: ['Notebook'] },
  { code: 'SJ', label: 'Spark job', experience: 'DE', itemTypes: ['SparkJobDefinition'] },
  { code: 'ENV', label: 'Environment', experience: 'DE', itemTypes: ['Environment'] },
  { code: 'WH', label: 'Warehouse', experience: 'DW', itemTypes: ['Warehouse', 'SQLDatabase'] },
  { code: 'EXP', label: 'Experiment', experience: 'DS', itemTypes: ['MLExperiment'] },
  { code: 'MDL', label: 'Model', experience: 'DS', itemTypes: ['MLModel'] },
  { code: 'KDB', label: 'KQL database', experience: 'RTA', itemTypes: ['KQLDatabase'] },
  { code: 'QS', label: 'Query set', experience: 'RTA', itemTypes: ['KQLQueryset'] },
  { code: 'ES', label: 'Event stream', experience: 'RTA', itemTypes: ['Eventstream'] },
  { code: 'RX', label: 'Reflex', experience: 'DA', itemTypes: ['Reflex'] },
];

const DEFAULT_CONVENTION = {
  enabled: false,
  separator: '_',
  letterCase: 'upper',
  // Which segments are used, and which of them a name must have. Index and stage
  // are optional in the source document: not every artifact belongs to a
  // medallion layer, and not everything needs ordering.
  segments: [
    { key: 'experience', required: true },
    { key: 'artifact', required: true },
    { key: 'index', required: false },
    { key: 'stage', required: false },
    { key: 'description', required: true },
  ],
  experiences: DEFAULT_EXPERIENCES,
  artifacts: DEFAULT_ARTIFACTS,
  stages: ['BRONZE', 'SILVER', 'GOLD'],
  indexPattern: '^[1-9]00$',
  // Types nobody names by hand. A semantic model created automatically alongside a
  // report carries the report's name and cannot be renamed independently, so
  // holding it to the convention would report a problem nobody can fix.
  ignoredItemTypes: [],
};

const LETTER_CASES = [
  { key: 'upper', label: 'UPPERCASE' },
  { key: 'lower', label: 'lowercase' },
  { key: 'any', label: 'Any case' },
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanCode(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

/**
 * A stored or submitted convention, filled in and made safe to use.
 *
 * Anything missing falls back to the default rather than to nothing: a
 * half-written convention that silently checked against no rules would report
 * every name as fine.
 */
function normalizeConvention(input) {
  const source = input && typeof input === 'object' ? input : {};

  const separator = String(source.separator || DEFAULT_CONVENTION.separator).slice(0, 3) || '_';
  const letterCase = LETTER_CASES.some(c => c.key === source.letterCase)
    ? source.letterCase
    : DEFAULT_CONVENTION.letterCase;

  const segments = asArray(source.segments)
    .filter(segment => segment && SEGMENT_BY_KEY.has(segment.key))
    .map(segment => ({ key: segment.key, required: segment.required !== false }));

  const experiences = asArray(source.experiences)
    .map(entry => ({ code: cleanCode(entry.code), label: String(entry.label || '').trim() }))
    .filter(entry => entry.code);

  const artifacts = asArray(source.artifacts)
    .map(entry => ({
      code: cleanCode(entry.code),
      label: String(entry.label || '').trim(),
      experience: cleanCode(entry.experience),
      itemTypes: asArray(entry.itemTypes).map(type => String(type).trim()).filter(Boolean),
    }))
    .filter(entry => entry.code);

  return {
    enabled: source.enabled === true || source.enabled === 'true',
    separator,
    letterCase,
    segments: segments.length ? segments : DEFAULT_CONVENTION.segments,
    experiences: experiences.length ? experiences : DEFAULT_CONVENTION.experiences,
    artifacts: artifacts.length ? artifacts : DEFAULT_CONVENTION.artifacts,
    stages: asArray(source.stages).map(cleanCode).filter(Boolean),
    indexPattern: String(source.indexPattern || DEFAULT_CONVENTION.indexPattern).trim(),
    ignoredItemTypes: asArray(source.ignoredItemTypes).map(type => String(type).trim().toLowerCase()).filter(Boolean),
  };
}

/**
 * The index pattern, compiled, or null when the author wrote something invalid.
 *
 * A broken pattern must not throw in the middle of checking a tenant, and must
 * not silently pass everything either — the caller reports it as unusable.
 */
function compileIndexPattern(convention) {
  if (!convention.indexPattern) return null;
  try {
    return new RegExp(convention.indexPattern);
  } catch {
    return null;
  }
}

/** How the convention reads as a pattern, e.g. EXPERIENCE_ARTIFACT_[INDEX]_DESCRIPTION. */
function describeConvention(convention) {
  const normalized = normalizeConvention(convention);
  return normalized.segments
    .map(segment => {
      const label = (SEGMENT_BY_KEY.get(segment.key) || {}).label || segment.key;
      return segment.required ? label.toUpperCase() : '[' + label.toUpperCase() + ']';
    })
    .join(normalized.separator);
}

/** An example name built from the convention, so the settings page can show one. */
function exampleName(convention) {
  const normalized = normalizeConvention(convention);
  const artifact = normalized.artifacts.find(entry => entry.code === 'LH') || normalized.artifacts[0];
  const experience = artifact
    ? (normalized.experiences.find(entry => entry.code === artifact.experience) || normalized.experiences[0])
    : normalized.experiences[0];

  const values = {
    experience: experience ? experience.code : 'DE',
    artifact: artifact ? artifact.code : 'LH',
    index: '100',
    stage: normalized.stages[0] || 'BRONZE',
    description: 'SALES',
  };
  return applyCase(normalized.segments.map(segment => values[segment.key]).filter(Boolean).join(normalized.separator), normalized);
}

function applyCase(text, convention) {
  if (convention.letterCase === 'upper') return text.toUpperCase();
  if (convention.letterCase === 'lower') return text.toLowerCase();
  return text;
}

function matchesCase(text, convention) {
  if (convention.letterCase === 'upper') return text === text.toUpperCase();
  if (convention.letterCase === 'lower') return text === text.toLowerCase();
  return true;
}

function artifactForItemType(convention, itemType) {
  const wanted = String(itemType || '').trim().toLowerCase();
  if (!wanted) return null;
  return convention.artifacts.find(entry =>
    entry.itemTypes.some(type => type.toLowerCase() === wanted)) || null;
}

function isIgnoredType(convention, itemType) {
  return convention.ignoredItemTypes.includes(String(itemType || '').trim().toLowerCase());
}

/**
 * Checks one artifact's name against the convention.
 *
 * Returns `{ ok, problems, tokens }`. The problems name the segment at fault
 * rather than saying "does not match", because "the second part should be an
 * artifact code such as LH" is actionable and "invalid name" is not.
 */
function checkName(name, itemType, convention) {
  const rules = normalizeConvention(convention);
  const text = String(name || '').trim();
  const indexPattern = compileIndexPattern(rules);
  const problems = [];

  if (!text) return { ok: false, problems: ['The item has no name.'], tokens: [] };

  const tokens = text.split(rules.separator).filter(part => part !== '');
  const required = rules.segments.filter(segment => segment.required);

  if (!matchesCase(text, rules)) {
    problems.push('Should be ' + (rules.letterCase === 'upper' ? 'upper case' : 'lower case') + '.');
  }

  // A name with too few parts is not in the convention's shape at all. Walking the
  // segments anyway would derive "Experience should be one of…", "Artifact is
  // missing", "Description is missing" — five restatements of one fact, which is a
  // wall of text rather than something to act on. Say the one thing and stop; the
  // suggested name is what the reader actually needs next.
  if (tokens.length < required.length) {
    problems.push('Not in the form ' + describeConvention(rules) + ' — expected at least '
      + required.length + ' part(s) separated by "' + rules.separator + '", found ' + tokens.length + '.');
    return { ok: false, problems, tokens, matched: {} };
  }

  // The segments are walked in order against the tokens. Optional segments may be
  // absent, so a token that does not fit one is offered to the next — which is
  // what lets DE_LH_SALES and DE_LH_100_BRONZE_SALES both be correct.
  let cursor = 0;
  const matched = {};
  for (let i = 0; i < rules.segments.length; i += 1) {
    const segment = rules.segments[i];
    const isLast = i === rules.segments.length - 1;
    const token = tokens[cursor];

    if (token === undefined) {
      if (segment.required) problems.push(labelFor(segment) + ' is missing.');
      continue;
    }

    // The description is whatever is left: business text legitimately contains the
    // separator (SOURCE_TO_BRONZE), so it cannot be one token.
    if (segment.key === 'description' && isLast) {
      matched.description = tokens.slice(cursor).join(rules.separator);
      cursor = tokens.length;
      continue;
    }

    const fits = tokenFitsSegment(token, segment.key, rules, indexPattern);
    if (fits) {
      matched[segment.key] = token;
      cursor += 1;
    } else if (segment.required) {
      problems.push(labelFor(segment) + ' should be ' + expectationFor(segment.key, rules, indexPattern)
        + ', found "' + token + '".');
      cursor += 1;
    }
    // An optional segment that does not fit is simply absent; the token is left
    // for the next segment.
  }

  if (rules.indexPattern && !indexPattern) {
    problems.push('The index pattern in the convention is not a valid regular expression, so the index was not checked.');
  }

  // The artifact code has to agree with what the item actually is, or a lakehouse
  // named DE_PL_100_SALES passes a check that means nothing.
  const expected = artifactForItemType(rules, itemType);
  if (expected && matched.artifact && matched.artifact.toUpperCase() !== expected.code.toUpperCase()) {
    problems.push('This is a ' + (expected.label || itemType) + ', so the artifact code should be "'
      + expected.code + '", not "' + matched.artifact + '".');
  }

  return { ok: problems.length === 0, problems, tokens, matched };
}

function labelFor(segment) {
  return (SEGMENT_BY_KEY.get(segment.key) || {}).label || segment.key;
}

function tokenFitsSegment(token, key, convention, indexPattern) {
  const value = token.toUpperCase();
  if (key === 'experience') return convention.experiences.some(entry => entry.code.toUpperCase() === value);
  if (key === 'artifact') return convention.artifacts.some(entry => entry.code.toUpperCase() === value);
  if (key === 'stage') return convention.stages.some(stage => stage.toUpperCase() === value);
  if (key === 'index') return indexPattern ? indexPattern.test(token) : /^\d+$/.test(token);
  return token.length > 0;
}

function expectationFor(key, convention, indexPattern) {
  if (key === 'experience') return 'one of ' + convention.experiences.map(e => e.code).join(', ');
  if (key === 'artifact') return 'one of ' + convention.artifacts.map(a => a.code).join(', ');
  if (key === 'stage') return 'one of ' + convention.stages.join(', ');
  if (key === 'index') return 'a number matching ' + (indexPattern ? indexPattern.source : 'the index pattern');
  return 'present';
}

/**
 * A name this item could be renamed to.
 *
 * Built from what is already known rather than invented: the item's type gives
 * the artifact and experience codes, and anything in the current name that looks
 * like a stage or an index is reused. Whatever is left becomes the description,
 * so the business meaning someone chose is kept rather than replaced with a
 * placeholder.
 *
 * Returns null when the type is not one the convention covers — a suggestion
 * nobody could act on is worse than none.
 */
function suggestName(item, convention) {
  const rules = normalizeConvention(convention);
  const itemType = (item && item.type) || '';
  const artifact = artifactForItemType(rules, itemType);
  if (!artifact) return null;

  const experience = rules.experiences.find(entry =>
    entry.code.toUpperCase() === String(artifact.experience || '').toUpperCase());

  const raw = String((item && (item.name || item.displayName)) || '').trim();
  // Split on anything that is not a letter or a digit, so "Sales-Bronze Lakehouse"
  // and "Sales_Bronze_Lakehouse" reduce to the same words.
  let words = raw.split(/[^A-Za-z0-9]+/).filter(Boolean);

  const indexPattern = compileIndexPattern(rules);
  const take = predicate => {
    const found = words.find(predicate);
    if (found) words = words.filter(word => word !== found);
    return found || null;
  };

  const stage = take(word => rules.stages.some(s => s.toUpperCase() === word.toUpperCase()));
  const index = take(word => (indexPattern ? indexPattern.test(word) : false));

  // Codes and type names already in the name are dropped, so "Sales Lakehouse"
  // does not become DE_LH_SALES_LAKEHOUSE.
  //
  // *Every* configured code counts as noise, not only the ones this item maps to.
  // A pipeline named DE_PL_100_LOAD_ALL_TABLES carries the wrong experience code —
  // the fix is DF, not keeping DE as part of the description, which is what
  // stripping only the expected code produced: DF_PL_100_DE_LOAD_ALL_TABLES. A
  // token that is a code in this convention belongs to a segment of its own, so
  // finding one among the leftovers means it was meant as a code, not as prose.
  const noise = new Set([
    ...rules.experiences.map(entry => entry.code.toUpperCase()),
    ...rules.artifacts.map(entry => entry.code.toUpperCase()),
    (artifact.label || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
    String(itemType).toUpperCase(),
  ].filter(Boolean));
  words = words.filter(word => !noise.has(word.toUpperCase()));

  const values = {
    experience: experience ? experience.code : null,
    artifact: artifact.code,
    index,
    stage,
    description: words.length ? words.join(rules.separator) : 'RENAME_ME',
  };

  const parts = rules.segments
    .map(segment => values[segment.key])
    .filter(value => value !== null && value !== undefined && value !== '');

  return applyCase(parts.join(rules.separator), rules);
}

/**
 * Every item in a workspace that does not follow the convention, with what it
 * should be called instead.
 */
function checkWorkspace(workspace, convention) {
  const rules = normalizeConvention(convention);
  const offenders = [];
  let checked = 0;

  for (const item of (workspace && workspace.items) || []) {
    const itemType = item.type || '';
    if (isIgnoredType(rules, itemType)) continue;
    // An item of a type the convention says nothing about cannot be judged by it.
    if (!artifactForItemType(rules, itemType)) continue;

    checked += 1;
    const name = item.name || item.displayName || '';
    const result = checkName(name, itemType, rules);
    if (result.ok) continue;

    offenders.push({
      id: item.id,
      name,
      type: itemType,
      problems: result.problems,
      suggestion: suggestName(item, rules),
    });
  }

  return { checked, offenders };
}

// ── Reading the settings form ──
//
// The code lists are edited as text areas rather than as rows of inputs: a
// convention has twenty-odd artifact codes, and twenty rows of four inputs is a
// form nobody will edit. Parsing lives here, with the rest of the rules, so the
// route stays thin and the parsing is testable without an HTTP request.

function parseLines(text) {
  return String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

/** `CODE = label` per line. A line with no `=` is a code with no label. */
function parseCodeList(text) {
  return parseLines(text).map(line => {
    const at = line.indexOf('=');
    if (at === -1) return { code: line.trim(), label: '' };
    return { code: line.slice(0, at).trim(), label: line.slice(at + 1).trim() };
  }).filter(entry => entry.code);
}

/** `CODE = label | EXPERIENCE | Type, Type` per line. */
function parseArtifactList(text) {
  return parseLines(text).map(line => {
    const at = line.indexOf('=');
    const code = (at === -1 ? line : line.slice(0, at)).trim();
    const rest = at === -1 ? '' : line.slice(at + 1);
    const [label = '', experience = '', types = ''] = rest.split('|').map(part => part.trim());
    return {
      code,
      label,
      experience,
      itemTypes: types.split(',').map(type => type.trim()).filter(Boolean),
    };
  }).filter(entry => entry.code);
}

/**
 * A submitted settings form into a convention.
 *
 * Segments keep the order the definitions declare rather than the order the
 * checkboxes arrive in: a browser posts them in document order anyway, and
 * depending on that would make the convention's meaning depend on markup.
 */
function conventionFromForm(body) {
  const source = body || {};
  const chosen = new Set([].concat(source.segment || []));

  return normalizeConvention({
    enabled: source.enabled === 'true' || source.enabled === true || source.enabled === 'on',
    separator: source.separator,
    letterCase: source.letterCase,
    indexPattern: source.indexPattern,
    segments: SEGMENT_DEFS
      .filter(def => chosen.has(def.key))
      .map(def => ({ key: def.key, required: source['required_' + def.key] !== 'false' })),
    experiences: parseCodeList(source.experiences),
    artifacts: parseArtifactList(source.artifacts),
    stages: parseLines(source.stages),
    ignoredItemTypes: parseLines(source.ignoredItemTypes),
  });
}

/**
 * Problems that would make a convention unusable, so a bad one is refused at the
 * form rather than quietly passing or failing every name in the tenant.
 */
function validateConvention(convention) {
  const rules = normalizeConvention(convention);
  const problems = [];

  if (!rules.separator) problems.push('A separator is required.');
  if (!rules.segments.some(segment => segment.required)) {
    problems.push('At least one part of the name must be required, or every name would pass.');
  }
  if (rules.indexPattern && !compileIndexPattern(rules)) {
    problems.push('The index pattern is not a valid regular expression.');
  }
  if (rules.segments.some(segment => segment.key === 'stage') && !rules.stages.length) {
    problems.push('Stage is part of the name, but no stages are listed.');
  }

  // An artifact naming an experience that does not exist can never be satisfied.
  const codes = new Set(rules.experiences.map(entry => entry.code.toUpperCase()));
  for (const artifact of rules.artifacts) {
    if (artifact.experience && !codes.has(artifact.experience.toUpperCase())) {
      problems.push('Artifact "' + artifact.code + '" refers to experience "' + artifact.experience + '", which is not in the list.');
    }
  }

  // The same item type under two artifact codes makes the suggestion arbitrary.
  const seen = new Map();
  for (const artifact of rules.artifacts) {
    for (const type of artifact.itemTypes) {
      const key = type.toLowerCase();
      if (seen.has(key)) {
        problems.push('Item type "' + type + '" is claimed by both "' + seen.get(key) + '" and "' + artifact.code + '".');
      } else {
        seen.set(key, artifact.code);
      }
    }
  }

  return problems;
}

module.exports = {
  parseCodeList,
  parseArtifactList,
  conventionFromForm,
  validateConvention,
  SEGMENT_DEFS,
  SEGMENT_BY_KEY,
  LETTER_CASES,
  DEFAULT_CONVENTION,
  DEFAULT_EXPERIENCES,
  DEFAULT_ARTIFACTS,
  normalizeConvention,
  describeConvention,
  exampleName,
  artifactForItemType,
  checkName,
  suggestName,
  checkWorkspace,
};
