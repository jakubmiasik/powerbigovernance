/**
 * Master data management engine.
 *
 * Takes raw records that arrived from several source systems and works out which
 * of them describe the same real-world thing, then builds one agreed version — the
 * golden record — from the best available value for each field.
 *
 * Four stages, in order:
 *
 *   1. Standardise  — make values comparable without changing their meaning
 *   2. Block        — propose candidate pairs without comparing every record to
 *                     every other, which is quadratic and unusable past a few
 *                     thousand rows
 *   3. Match        — score each candidate pair per field, then decide
 *   4. Survive      — group matched records and pick the surviving value per field
 *
 * Pure: no database, no API, no clock. The decisions that determine what a business
 * treats as its single version of a customer are testable directly, and every
 * golden value carries provenance saying which source record it came from.
 */

// ── Stage 1: standardisation ──
// Values differ between systems in ways that carry no meaning — case, padding,
// punctuation, "N/A" for absent. Comparing them raw produces false negatives, so
// each rule removes one class of meaningless difference. Rules are applied in the
// order listed on the field, and the original value is never overwritten.

const DEFAULT_NULL_TOKENS = ['', '-', '--', 'n/a', 'na', 'null', 'none', 'unknown', 'not known', '?', '.'];

const STANDARDISERS = {
  trim: value => value.trim(),
  collapse_whitespace: value => value.replace(/\s+/g, ' '),
  upper: value => value.toUpperCase(),
  lower: value => value.toLowerCase(),
  strip_punctuation: value => value.replace(/[.,/#!$%^&*;:{}=\-_`~()'"\[\]]/g, ' ').replace(/\s+/g, ' ').trim(),
  strip_diacritics: value => value.normalize('NFD').replace(/[̀-ͯ]/g, ''),
  digits_only: value => value.replace(/\D/g, ''),
  alnum_only: value => value.replace(/[^A-Za-z0-9]/g, ''),
  sort_tokens: value => value.split(/\s+/).filter(Boolean).sort().join(' '),
};

const STANDARDISER_DEFS = [
  { key: 'trim', label: 'Trim', description: 'Remove leading and trailing whitespace.' },
  { key: 'collapse_whitespace', label: 'Collapse spaces', description: 'Reduce runs of whitespace to a single space.' },
  { key: 'lower', label: 'Lowercase', description: 'Case is almost never meaningful for matching.' },
  { key: 'upper', label: 'Uppercase', description: 'Alternative to lowercase where downstream systems expect it.' },
  { key: 'strip_punctuation', label: 'Strip punctuation', description: 'For company names and addresses, where punctuation is inconsistent.' },
  { key: 'strip_diacritics', label: 'Fold accents', description: 'Müller and Muller become comparable.' },
  { key: 'digits_only', label: 'Digits only', description: 'For phone numbers, tax IDs and account numbers written with separators.' },
  { key: 'alnum_only', label: 'Letters and digits only', description: 'For codes and references written inconsistently.' },
  { key: 'sort_tokens', label: 'Sort words', description: 'Makes "Smith John" comparable with "John Smith". Use with care on addresses.' },
  { key: 'expand_abbreviations', label: 'Expand abbreviations', description: 'Applies the model\'s abbreviation map, e.g. ST → STREET, LTD → LIMITED.' },
];

// Abbreviations are domain-specific, so this is only a starting point a model can
// replace. Expanding rather than contracting keeps the map unambiguous.
const DEFAULT_ABBREVIATIONS = {
  st: 'street', str: 'street', rd: 'road', ave: 'avenue', av: 'avenue', blvd: 'boulevard',
  ln: 'lane', dr: 'drive', ct: 'court', sq: 'square', apt: 'apartment', ste: 'suite',
  ltd: 'limited', llc: 'limited', inc: 'incorporated', co: 'company', corp: 'corporation',
  intl: 'international', mfg: 'manufacturing', assoc: 'associates', bros: 'brothers',
  n: 'north', s: 'south', e: 'east', w: 'west',
};

function isNullish(value, nullTokens) {
  if (value === null || value === undefined) return true;
  const text = String(value).trim().toLowerCase();
  return (nullTokens || DEFAULT_NULL_TOKENS).includes(text);
}

function expandAbbreviations(value, map) {
  const abbreviations = map || DEFAULT_ABBREVIATIONS;
  return value.split(/\s+/).map(token => {
    const key = token.toLowerCase().replace(/[.]/g, '');
    return Object.prototype.hasOwnProperty.call(abbreviations, key) ? abbreviations[key] : token;
  }).join(' ');
}

/**
 * Applies a field's standardisation rules. Returns null for a value the model
 * treats as absent, so "N/A" and an empty string are not compared as if they were
 * data — matching two records because both say "UNKNOWN" is a classic false merge.
 */
function standardiseValue(value, { rules = [], nullTokens, abbreviations } = {}) {
  if (isNullish(value, nullTokens)) return null;
  let text = String(value);
  for (const rule of rules) {
    if (rule === 'expand_abbreviations') {
      text = expandAbbreviations(text, abbreviations);
      continue;
    }
    const fn = STANDARDISERS[rule];
    if (fn) text = fn(text);
  }
  text = text.trim();
  return text === '' ? null : text;
}

/** A record's standardised view, kept alongside the original rather than replacing it. */
function standardiseRecord(record, fields, model = {}) {
  const standardised = {};
  for (const field of fields) {
    standardised[field.key] = standardiseValue(record[field.column], {
      rules: field.standardisers,
      nullTokens: model.nullTokens,
      abbreviations: model.abbreviations,
    });
  }
  return standardised;
}

// ── Stage 2: blocking ──
// Comparing every record with every other is O(n²) — a million rows is half a
// trillion comparisons. Blocking groups records that share a cheap key and only
// compares within a group. Several keys are used together and a pair is a candidate
// if it shares ANY of them, which recovers the recall a single key would lose.

const SOUNDEX_CODES = { b: 1, f: 1, p: 1, v: 1, c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2, d: 3, t: 3, l: 4, m: 5, n: 5, r: 6 };

/**
 * Soundex: names that sound alike share a code. Cheap, well understood, and good
 * at the errors that actually occur in manually keyed names — Smith/Smyth,
 * Robertson/Robinson. Weak on non-English names, which is why it is a blocking key
 * that proposes candidates rather than a decision on its own.
 */
function soundex(value) {
  const text = String(value || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!text) return '';
  const first = text[0];
  let previous = SOUNDEX_CODES[first] || 0;
  let code = '';
  for (const letter of text.slice(1)) {
    const digit = SOUNDEX_CODES[letter] || 0;
    // h and w are transparent: letters either side of them still count as adjacent.
    if (letter === 'h' || letter === 'w') continue;
    if (digit && digit !== previous) code += digit;
    if (letter !== 'h' && letter !== 'w') previous = digit;
    if (code.length === 3) break;
  }
  return (first + code + '000').slice(0, 4).toUpperCase();
}

const BLOCKING_DEFS = [
  { key: 'exact', label: 'Exact value', description: 'Records sharing the standardised value. Cheap and precise; use for identifiers.' },
  { key: 'prefix', label: 'First N characters', description: 'Tolerates differences later in the value. Set N in the block\'s size.' },
  { key: 'phonetic', label: 'Sounds like (Soundex)', description: 'Groups names that sound alike. Good for manually keyed person and company names.' },
  { key: 'sorted_tokens', label: 'Same words, any order', description: 'Groups "John Smith" with "Smith John".' },
  { key: 'ngram', label: 'Shares an N-gram', description: 'Highest recall and the most expensive — a record joins many blocks. Use on short fields only.' },
];

function blockKeysFor(standardised, block) {
  const value = standardised[block.field];
  if (value === null || value === undefined || value === '') return [];
  const text = String(value);

  switch (block.strategy) {
    case 'exact':
      return [block.field + ':' + text];
    case 'prefix': {
      const size = Math.max(1, Number(block.size) || 4);
      return [block.field + ':' + text.slice(0, size)];
    }
    case 'phonetic':
      return [block.field + ':' + soundex(text)];
    case 'sorted_tokens':
      return [block.field + ':' + text.split(/\s+/).filter(Boolean).sort().join(' ')];
    case 'ngram': {
      const size = Math.max(2, Number(block.size) || 3);
      const grams = new Set();
      for (let i = 0; i + size <= text.length; i += 1) grams.add(block.field + ':' + text.slice(i, i + size));
      return [...grams];
    }
    default:
      return [];
  }
}

/**
 * Candidate pairs, and the cost of producing them.
 *
 * `blocksExamined` and the largest block size are reported because blocking is
 * where an MDM model silently becomes unusable: one key that lands most records in
 * the same block gives back the quadratic comparison it was meant to avoid, and the
 * only symptom is a run that never finishes.
 */
function generateCandidatePairs(records, blocks, { maxPairs = 500000 } = {}) {
  const buckets = new Map();
  for (let index = 0; index < records.length; index += 1) {
    for (const block of blocks || []) {
      for (const key of blockKeysFor(records[index].standardised, block)) {
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(index);
      }
    }
  }

  const pairs = new Set();
  let largestBlock = 0;
  let truncated = false;
  for (const members of buckets.values()) {
    largestBlock = Math.max(largestBlock, members.length);
    for (let i = 0; i < members.length && !truncated; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const a = Math.min(members[i], members[j]);
        const b = Math.max(members[i], members[j]);
        pairs.add(a * records.length + b);
        if (pairs.size >= maxPairs) { truncated = true; break; }
      }
    }
  }

  const list = [...pairs].map(encoded => [Math.floor(encoded / records.length), encoded % records.length]);
  return { pairs: list, blocksExamined: buckets.size, largestBlock, truncated };
}

// ── Stage 3: matching ──
// Each candidate pair is scored field by field, then combined into one score. The
// comparator suits the kind of error the field actually suffers from: transposed
// characters in a keyed reference are not the same problem as a company that
// appears with and without "Limited".

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function editSimilarity(a, b) {
  const longest = Math.max(a.length, b.length);
  if (!longest) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/**
 * Jaro-Winkler. Favours strings agreeing at the start, which matches how names are
 * mistyped and truncated, and is the standard choice for person names.
 */
function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array(a.length).fill(false);
  const bMatched = new Array(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i += 1) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, b.length);
    for (let j = start; j < end; j += 1) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (!matches) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  transpositions /= 2;

  const jaro = (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

function tokenSetSimilarity(a, b) {
  const setA = new Set(a.split(/\s+/).filter(Boolean));
  const setB = new Set(b.split(/\s+/).filter(Boolean));
  if (!setA.size && !setB.size) return 1;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

const COMPARATOR_DEFS = [
  { key: 'exact', label: 'Exact', description: 'Equal after standardisation, or not. Use for identifiers where partial agreement means nothing.' },
  { key: 'edit', label: 'Edit distance', description: 'Tolerates typos in proportion to length. Good for references and short codes.' },
  { key: 'jaro_winkler', label: 'Jaro-Winkler', description: 'Favours agreement at the start of the value. The usual choice for person names.' },
  { key: 'token_set', label: 'Shared words', description: 'Order-independent overlap. The usual choice for company names and addresses.' },
  { key: 'numeric', label: 'Numeric tolerance', description: 'Within an absolute or relative tolerance. For amounts and quantities.' },
  { key: 'date', label: 'Date tolerance', description: 'Within a number of days. For dates recorded with different precision.' },
  { key: 'phonetic', label: 'Sounds alike', description: 'Soundex equality. A blunt instrument; give it less weight than a string comparator.' },
];

function compareValues(a, b, field) {
  const type = field.comparator || 'exact';
  const textA = String(a);
  const textB = String(b);

  switch (type) {
    case 'exact':
      return textA === textB ? 1 : 0;
    case 'edit':
      return editSimilarity(textA, textB);
    case 'jaro_winkler':
      return jaroWinkler(textA, textB);
    case 'token_set':
      return tokenSetSimilarity(textA, textB);
    case 'phonetic':
      return soundex(textA) === soundex(textB) ? 1 : 0;
    case 'numeric': {
      const numA = Number(textA);
      const numB = Number(textB);
      if (!Number.isFinite(numA) || !Number.isFinite(numB)) return 0;
      const difference = Math.abs(numA - numB);
      const absolute = Number(field.tolerance) || 0;
      const relative = Number(field.relativeTolerance) || 0;
      const allowed = Math.max(absolute, relative * Math.max(Math.abs(numA), Math.abs(numB)));
      if (difference <= allowed) return 1;
      // Degrade rather than cliff-edge, so a near miss still contributes.
      return allowed > 0 ? Math.max(0, 1 - (difference - allowed) / (allowed * 4)) : 0;
    }
    case 'date': {
      const dateA = new Date(textA);
      const dateB = new Date(textB);
      if (Number.isNaN(dateA.getTime()) || Number.isNaN(dateB.getTime())) return 0;
      const days = Math.abs(dateA - dateB) / 86400000;
      const allowed = Number(field.toleranceDays) || 0;
      return days <= allowed ? 1 : 0;
    }
    default:
      return textA === textB ? 1 : 0;
  }
}

const NULL_POLICY_DEFS = [
  { key: 'skip', label: 'Ignore the field', description: 'The field drops out and its weight is shared among the fields that could be compared. The safe default: a missing value is not evidence either way.' },
  { key: 'disagree', label: 'Count as a mismatch', description: 'Treat absence as disagreement. Use where a field is mandatory and its absence is itself a signal.' },
  { key: 'neutral', label: 'Score as half', description: 'Keeps the field\'s weight but stays uncommitted.' },
];

/**
 * Scores one candidate pair.
 *
 * Weights are normalised across the fields that could actually be compared, so a
 * pair where half the fields are empty is not quietly penalised for it. That
 * matters more than it sounds: without it, sparse records never reach the
 * threshold and the records most in need of mastering are the ones that never
 * merge.
 *
 * Two rule kinds override the score outright, because some questions are not
 * matters of degree:
 *   - `required`  — a field that must agree, or the pair is rejected whatever else
 *                   matches. A shared tax ID is decisive; so is its absence.
 *   - `blocker`   — a field that must not disagree. Different country, different
 *                   legal entity: no amount of name similarity should merge them.
 */
function scorePair(recordA, recordB, fields, options = {}) {
  const contributions = [];
  let weighted = 0;
  let usedWeight = 0;
  let rejectedBy = null;

  for (const field of fields) {
    const weight = Number(field.weight) > 0 ? Number(field.weight) : 1;
    const valueA = recordA.standardised[field.key];
    const valueB = recordB.standardised[field.key];
    const missing = valueA === null || valueA === undefined || valueB === null || valueB === undefined;

    if (missing) {
      const policy = field.nullPolicy || 'skip';
      if (field.required) rejectedBy = rejectedBy || { field: field.key, reason: 'required field is missing on one side' };
      if (policy === 'skip') {
        contributions.push({ field: field.key, score: null, weight, skipped: true });
        continue;
      }
      const score = policy === 'neutral' ? 0.5 : 0;
      weighted += score * weight;
      usedWeight += weight;
      contributions.push({ field: field.key, score, weight, nullPolicy: policy });
      continue;
    }

    const score = compareValues(valueA, valueB, field);
    weighted += score * weight;
    usedWeight += weight;
    contributions.push({ field: field.key, score: Math.round(score * 1000) / 1000, weight });

    const threshold = field.minScore === undefined || field.minScore === null ? 1 : Number(field.minScore);
    if (field.required && score < threshold) {
      rejectedBy = rejectedBy || { field: field.key, reason: 'required field does not agree' };
    }
    if (field.blocker && score < threshold) {
      rejectedBy = rejectedBy || { field: field.key, reason: 'values conflict on a field that must not disagree' };
    }
  }

  const score = usedWeight ? weighted / usedWeight : 0;
  const autoThreshold = options.autoMatchThreshold === undefined ? 0.9 : Number(options.autoMatchThreshold);
  const reviewThreshold = options.reviewThreshold === undefined ? 0.75 : Number(options.reviewThreshold);

  let decision;
  if (rejectedBy) decision = 'no_match';
  else if (score >= autoThreshold) decision = 'match';
  else if (score >= reviewThreshold) decision = 'review';
  else decision = 'no_match';

  return {
    score: Math.round(score * 1000) / 1000,
    decision,
    rejectedBy,
    comparedFields: contributions.filter(c => !c.skipped).length,
    contributions,
  };
}

// ── Stage 4: clustering ──
// Pairwise matches have to become groups. Union-find gives transitive closure
// cheaply, but transitivity is also how MDM over-merges: A matches B, B matches C,
// and A and C are unrelated. Strict mode refuses to merge a group unless every pair
// within it matched, which trades recall for a guarantee.

function createUnionFind(size) {
  const parent = Array.from({ length: size }, (_, i) => i);
  function find(node) {
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]];
      node = parent[node];
    }
    return node;
  }
  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  }
  return { find, union };
}

function clusterRecords(recordCount, matchedPairs, { strict = false } = {}) {
  const unionFind = createUnionFind(recordCount);
  const matchedSet = new Set(matchedPairs.map(([a, b]) => a + ':' + b));
  for (const [a, b] of matchedPairs) unionFind.union(a, b);

  const groups = new Map();
  for (let index = 0; index < recordCount; index += 1) {
    const root = unionFind.find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(index);
  }

  const clusters = [];
  for (const members of groups.values()) {
    if (!strict || members.length <= 2) { clusters.push(members); continue; }

    // Strict: keep the group only if it is a clique. Otherwise fall back to the
    // pairs themselves, so a chain of weak links does not become one entity.
    let complete = true;
    for (let i = 0; i < members.length && complete; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const a = Math.min(members[i], members[j]);
        const b = Math.max(members[i], members[j]);
        if (!matchedSet.has(a + ':' + b)) { complete = false; break; }
      }
    }
    if (complete) { clusters.push(members); continue; }
    for (const member of members) clusters.push([member]);
  }

  return clusters.sort((a, b) => b.length - a.length || a[0] - b[0]);
}

// ── Stage 5: survivorship ──
// The rule that decides which value survives is a business decision, not a
// technical one, so each field carries its own and every surviving value records
// where it came from.

const SURVIVORSHIP_DEFS = [
  { key: 'most_recent', label: 'Most recent', description: 'The value from the most recently updated record. Needs a timestamp field on the model.' },
  { key: 'source_priority', label: 'Most trusted source', description: 'The value from the highest-ranked source system. The usual choice where one system is the book of record for a field.' },
  { key: 'most_frequent', label: 'Most agreed', description: 'The value most sources carry. Ties break on source priority, then recency.' },
  { key: 'longest', label: 'Longest value', description: 'A crude proxy for completeness — "Robert J. Smith" over "R Smith". Good for names and addresses, wrong for codes.' },
  { key: 'most_complete', label: 'First non-empty', description: 'The first value present, in source-priority order. The safe default.' },
  { key: 'max', label: 'Highest', description: 'For numbers and dates.' },
  { key: 'min', label: 'Lowest', description: 'For numbers and dates.' },
  { key: 'sum', label: 'Total', description: 'Adds the values across the cluster. For measures that accumulate, not for attributes.' },
  { key: 'manual', label: 'Leave for a steward', description: 'No value is chosen automatically; the cluster is flagged for a person to decide.' },
];

function sourceRank(record, model) {
  const priority = model.sourcePriority || [];
  const system = record.raw[model.sourceField];
  const index = priority.indexOf(system === null || system === undefined ? '' : String(system));
  // Unranked sources sort last rather than first, so an unexpected new system does
  // not silently outrank the book of record.
  return index === -1 ? priority.length : index;
}

function recordTimestamp(record, model) {
  if (!model.timestampField) return null;
  const value = record.raw[model.timestampField];
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

/** Cluster members ordered by trust: source priority, then recency, then stable. */
function orderByTrust(members, model) {
  return members.slice().sort((a, b) => {
    const rankDelta = sourceRank(a, model) - sourceRank(b, model);
    if (rankDelta !== 0) return rankDelta;
    const timeA = recordTimestamp(a, model);
    const timeB = recordTimestamp(b, model);
    if (timeA !== null && timeB !== null && timeA !== timeB) return timeB - timeA;
    return 0;
  });
}

function pickSurvivor(members, field, model) {
  const strategy = field.survivorship || 'most_complete';
  const candidates = members
    .map(record => ({ record, value: record.standardised[field.key], raw: record.raw[field.column] }))
    .filter(entry => entry.value !== null && entry.value !== undefined);

  if (!candidates.length) return { value: null, from: null, strategy, reason: 'no source carried a value' };
  if (strategy === 'manual') return { value: null, from: null, strategy, reason: 'reserved for a steward' };

  const trusted = orderByTrust(candidates.map(c => c.record), model);
  const byRecord = new Map(candidates.map(entry => [entry.record, entry]));

  switch (strategy) {
    case 'source_priority':
    case 'most_complete': {
      const winner = trusted.find(record => byRecord.has(record));
      const entry = byRecord.get(winner);
      return { value: entry.raw, from: winner, strategy, reason: 'highest-ranked source carrying a value' };
    }
    case 'most_recent': {
      const dated = candidates.filter(entry => recordTimestamp(entry.record, model) !== null);
      if (!dated.length) {
        const entry = byRecord.get(trusted[0]);
        return { value: entry.raw, from: trusted[0], strategy, reason: 'no timestamps available, fell back to source priority' };
      }
      const winner = dated.reduce((best, entry) =>
        recordTimestamp(entry.record, model) > recordTimestamp(best.record, model) ? entry : best);
      return { value: winner.raw, from: winner.record, strategy, reason: 'most recently updated record' };
    }
    case 'most_frequent': {
      const counts = new Map();
      for (const entry of candidates) {
        counts.set(entry.value, (counts.get(entry.value) || 0) + 1);
      }
      const best = Math.max(...counts.values());
      const tied = new Set([...counts.entries()].filter(([, count]) => count === best).map(([value]) => value));
      // Ties break the same way trust does, so the outcome is never arbitrary.
      const winner = trusted.find(record => byRecord.has(record) && tied.has(byRecord.get(record).value));
      const entry = byRecord.get(winner);
      return { value: entry.raw, from: winner, strategy, reason: best + ' of ' + candidates.length + ' sources agree' };
    }
    case 'longest': {
      const winner = candidates.reduce((best, entry) =>
        String(entry.value).length > String(best.value).length ? entry : best);
      return { value: winner.raw, from: winner.record, strategy, reason: 'longest value, as a proxy for completeness' };
    }
    case 'max':
    case 'min': {
      const numeric = candidates
        .map(entry => ({ entry, number: Number(entry.value) }))
        .filter(item => Number.isFinite(item.number));
      if (!numeric.length) {
        const entry = byRecord.get(trusted[0]);
        return { value: entry.raw, from: trusted[0], strategy, reason: 'values are not numeric, fell back to source priority' };
      }
      const winner = numeric.reduce((best, item) =>
        (strategy === 'max' ? item.number > best.number : item.number < best.number) ? item : best);
      return { value: winner.entry.raw, from: winner.entry.record, strategy, reason: strategy === 'max' ? 'highest value' : 'lowest value' };
    }
    case 'sum': {
      const numbers = candidates.map(entry => Number(entry.value)).filter(Number.isFinite);
      if (!numbers.length) return { value: null, from: null, strategy, reason: 'values are not numeric' };
      return {
        value: numbers.reduce((total, number) => total + number, 0),
        from: null, strategy, reason: 'total across ' + numbers.length + ' source record(s)',
      };
    }
    default: {
      const entry = byRecord.get(trusted[0]);
      return { value: entry.raw, from: trusted[0], strategy, reason: 'default survivorship' };
    }
  }
}

/**
 * Builds one golden record from a cluster.
 *
 * Provenance is not optional here. A golden record whose values cannot be traced
 * back to the source records they came from cannot be defended when someone
 * disagrees with it, and disagreement is the normal case in master data.
 */
function buildGoldenRecord(members, fields, model, clusterIndex) {
  const trusted = orderByTrust(members, model);
  const values = {};
  const provenance = {};
  let conflicts = 0;
  let needsSteward = false;

  for (const field of fields) {
    const distinct = new Set(members
      .map(record => record.standardised[field.key])
      .filter(value => value !== null && value !== undefined));
    if (distinct.size > 1) conflicts += 1;

    const survivor = pickSurvivor(members, field, model);
    values[field.key] = survivor.value;
    provenance[field.key] = {
      strategy: survivor.strategy,
      reason: survivor.reason,
      sourceRecordId: survivor.from ? survivor.from.sourceId : null,
      sourceSystem: survivor.from ? survivor.from.sourceSystem : null,
      candidates: distinct.size,
    };
    if (survivor.strategy === 'manual' && distinct.size) needsSteward = true;
  }

  const primary = trusted[0];
  return {
    goldenId: goldenIdFor(primary, model, clusterIndex),
    values,
    provenance,
    memberCount: members.length,
    sourceSystems: [...new Set(members.map(record => record.sourceSystem).filter(Boolean))],
    sourceRecordIds: members.map(record => record.sourceId),
    conflicts,
    needsSteward,
  };
}

function goldenIdFor(primary, model, clusterIndex) {
  const strategy = model.goldenIdStrategy || 'sequential';
  if (strategy === 'primary_source_id' && primary && primary.sourceId !== null && primary.sourceId !== undefined) {
    return String(primary.sourceId);
  }
  const prefix = model.goldenIdPrefix || 'MDM';
  return prefix + '-' + String(clusterIndex + 1).padStart(6, '0');
}

// ── The pipeline ──

/**
 * Runs the whole thing over a set of raw rows.
 *
 * `rows` are the raw records as read from the source table; `model` describes the
 * fields, blocking, matching and survivorship. Returns the golden records, the
 * crosswalk from source record to golden id, the pairs that need human review, and
 * statistics about the run — including the blocking cost, because that is what
 * makes the difference between a model that scales and one that does not.
 */
function buildMasterData(rows, model) {
  const fields = model.fields || [];
  if (!fields.length) throw new Error('The model has no fields defined.');

  const records = rows.map((raw, index) => ({
    index,
    raw,
    sourceId: model.sourceIdField ? raw[model.sourceIdField] : index,
    sourceSystem: model.sourceField ? raw[model.sourceField] : null,
    standardised: standardiseRecord(raw, fields, model),
  }));

  const blocks = (model.blocks || []).length
    ? model.blocks
    // With no blocking configured, comparing everything is correct but quadratic.
    // It is allowed for small sets and reported, never chosen silently.
    : [{ field: fields[0].key, strategy: 'prefix', size: 1 }];

  const candidates = generateCandidatePairs(records, blocks, { maxPairs: model.maxPairs });

  const matched = [];
  const review = [];
  let scored = 0;
  for (const [a, b] of candidates.pairs) {
    const result = scorePair(records[a], records[b], fields, model);
    scored += 1;
    if (result.decision === 'match') matched.push([Math.min(a, b), Math.max(a, b)]);
    else if (result.decision === 'review') {
      review.push({
        leftIndex: a, rightIndex: b,
        leftId: records[a].sourceId, rightId: records[b].sourceId,
        leftSystem: records[a].sourceSystem, rightSystem: records[b].sourceSystem,
        score: result.score,
        contributions: result.contributions,
        rejectedBy: result.rejectedBy,
      });
    }
  }

  const clusters = clusterRecords(records.length, matched, { strict: !!model.strictClustering });
  const golden = clusters.map((members, clusterIndex) =>
    buildGoldenRecord(members.map(index => records[index]), fields, model, clusterIndex));

  const crosswalk = [];
  golden.forEach(record => {
    record.sourceRecordIds.forEach(sourceId => {
      crosswalk.push({ goldenId: record.goldenId, sourceId });
    });
  });

  const merged = golden.filter(record => record.memberCount > 1);
  const largestCluster = clusters.length ? clusters[0].length : 0;

  return {
    golden,
    crosswalk,
    review: review.sort((a, b) => b.score - a.score),
    stats: {
      rawRecords: records.length,
      goldenRecords: golden.length,
      mergedClusters: merged.length,
      recordsMerged: merged.reduce((total, record) => total + record.memberCount, 0),
      duplicatesRemoved: records.length - golden.length,
      pairsCompared: scored,
      candidatePairs: candidates.pairs.length,
      blocksExamined: candidates.blocksExamined,
      largestBlock: candidates.largestBlock,
      pairsTruncated: candidates.truncated,
      reviewPairs: review.length,
      conflictedFields: golden.reduce((total, record) => total + record.conflicts, 0),
      stewardRequired: golden.filter(record => record.needsSteward).length,
      largestCluster,
      // A cluster far larger than the rest is the signature of over-merging, and it
      // is worth saying so rather than leaving it to be discovered downstream.
      overMergeSuspected: largestCluster > Math.max(10, records.length * 0.05),
    },
  };
}

module.exports = {
  DEFAULT_NULL_TOKENS,
  DEFAULT_ABBREVIATIONS,
  STANDARDISER_DEFS,
  BLOCKING_DEFS,
  COMPARATOR_DEFS,
  NULL_POLICY_DEFS,
  SURVIVORSHIP_DEFS,
  standardiseValue,
  standardiseRecord,
  soundex,
  levenshtein,
  editSimilarity,
  jaroWinkler,
  tokenSetSimilarity,
  blockKeysFor,
  generateCandidatePairs,
  compareValues,
  scorePair,
  clusterRecords,
  orderByTrust,
  pickSurvivor,
  buildGoldenRecord,
  buildMasterData,
};
