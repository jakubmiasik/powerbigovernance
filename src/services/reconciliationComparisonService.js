/**
 * Comparing two reconciliation runs.
 *
 * Two runs of the same control answer the question a reviewer actually has: is the
 * problem getting better or worse, and which specific items changed? Counts alone
 * do not answer that — twenty exceptions before and twenty after can mean nothing
 * moved, or that twenty were fixed and twenty new ones appeared. So this works from
 * the findings each run recorded, not from the totals.
 *
 * Pure: it takes rows and returns a comparison, with no database and no clock.
 */

const { OUTCOME_DEFS, OUTCOME_BY_KEY } = require('./reconciliationService');

// Metrics that carry over between runs, and which direction is an improvement.
const RUN_METRICS = [
  { key: 'records_a', label: 'Records read from source A', better: 'none' },
  { key: 'records_b', label: 'Records read from source B', better: 'none' },
  { key: 'keys_compared', label: 'Business keys compared', better: 'none' },
  { key: 'matched', label: 'Matched', better: 'up' },
  { key: 'exception_count', label: 'Exceptions', better: 'down' },
];

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function classifyDelta(delta, better) {
  if (delta === null || delta === 0) return 'unchanged';
  if (better === 'none') return 'changed';
  const improved = better === 'up' ? delta > 0 : delta < 0;
  return improved ? 'improved' : 'worsened';
}

/** Metric-by-metric deltas between two run rows. */
function diffRunMetrics(fromRun, toRun) {
  return RUN_METRICS.map(metric => {
    const from = num(fromRun ? fromRun[metric.key] : null);
    const to = num(toRun ? toRun[metric.key] : null);
    const delta = from === null || to === null ? null : to - from;
    return {
      key: metric.key,
      label: metric.label,
      from,
      to,
      delta,
      // A rate is more useful than a raw count when the two runs read different
      // volumes, which they usually do.
      percentChange: from ? Math.round((delta / from) * 1000) / 10 : null,
      direction: classifyDelta(delta, metric.better),
    };
  });
}

function countByOutcome(findings) {
  const counts = new Map();
  for (const finding of findings || []) {
    const outcome = finding.outcome;
    counts.set(outcome, (counts.get(outcome) || 0) + 1);
  }
  return counts;
}

/** Per-outcome counts side by side, including outcomes present in only one run. */
function diffOutcomes(findingsFrom, findingsTo) {
  const from = countByOutcome(findingsFrom);
  const to = countByOutcome(findingsTo);
  const keys = new Set([...from.keys(), ...to.keys()]);
  // Keep the canonical ordering, then append anything unrecognised rather than
  // dropping it — an outcome this build does not know about is still a finding.
  const ordered = OUTCOME_DEFS.map(def => def.key).filter(key => keys.has(key));
  for (const key of keys) if (!ordered.includes(key)) ordered.push(key);

  return ordered.map(key => {
    const def = OUTCOME_BY_KEY.get(key);
    const fromCount = from.get(key) || 0;
    const toCount = to.get(key) || 0;
    return {
      key,
      label: def ? def.label : key,
      description: def ? def.description : null,
      from: fromCount,
      to: toCount,
      delta: toCount - fromCount,
    };
  });
}

function indexByFingerprint(findings) {
  const index = new Map();
  for (const finding of findings || []) {
    // A run should not record the same fingerprint twice, but if it does the first
    // one wins rather than the comparison inventing a duplicate item.
    if (!index.has(finding.fingerprint)) index.set(finding.fingerprint, finding);
  }
  return index;
}

function describeFinding(finding) {
  const def = OUTCOME_BY_KEY.get(finding.outcome);
  return {
    fingerprint: finding.fingerprint,
    businessKey: finding.business_key,
    outcome: finding.outcome,
    outcomeLabel: def ? def.label : finding.outcome,
    severity: finding.severity,
    exceptionId: finding.exception_id,
  };
}

/**
 * Which items changed between the runs.
 *
 * - `resolved`: seen in the earlier run, absent from the later one — fixed, or at
 *   least no longer failing.
 * - `introduced`: only in the later run — new problems.
 * - `persisting`: in both with the same outcome — not being dealt with.
 * - `changed`: in both, but the outcome moved (a value mismatch that became a
 *   missing record, say), which usually means something different is now wrong.
 */
function diffFindings(findingsFrom, findingsTo, { sampleLimit = 100 } = {}) {
  const from = indexByFingerprint(findingsFrom);
  const to = indexByFingerprint(findingsTo);

  const resolved = [];
  const introduced = [];
  const persisting = [];
  const changed = [];

  for (const [fingerprint, finding] of from) {
    const later = to.get(fingerprint);
    if (!later) { resolved.push(describeFinding(finding)); continue; }
    if (later.outcome !== finding.outcome) {
      changed.push({
        ...describeFinding(later),
        fromOutcome: finding.outcome,
        fromOutcomeLabel: (OUTCOME_BY_KEY.get(finding.outcome) || {}).label || finding.outcome,
      });
    } else {
      persisting.push(describeFinding(later));
    }
  }
  for (const [fingerprint, finding] of to) {
    if (!from.has(fingerprint)) introduced.push(describeFinding(finding));
  }

  // Counts stay exact; only the lists shown are capped, so a comparison over a
  // large run does not turn into an unreadable page.
  const cap = list => ({ total: list.length, sample: list.slice(0, sampleLimit) });
  return {
    resolved: cap(resolved),
    introduced: cap(introduced),
    persisting: cap(persisting),
    changed: cap(changed),
  };
}

/**
 * The headline: did this control improve? Judged on items, not on totals, so a run
 * that fixed ten problems and gained ten is reported as churn rather than as "no
 * change".
 */
function summarizeVerdict(findingDiff) {
  const introduced = findingDiff.introduced.total;
  const resolved = findingDiff.resolved.total;
  const persisting = findingDiff.persisting.total;
  const changed = findingDiff.changed.total;

  let verdict;
  if (!introduced && !resolved && !changed) {
    verdict = persisting ? 'unchanged' : 'clean';
  } else if (introduced && !resolved) {
    verdict = 'worse';
  } else if (resolved && !introduced) {
    verdict = 'better';
  } else {
    verdict = 'churn';
  }

  return {
    verdict,
    introduced,
    resolved,
    persisting,
    changed,
    netChange: introduced - resolved,
  };
}

const VERDICT_DEFS = {
  clean: { label: 'No exceptions in either run', color: 'success' },
  unchanged: { label: 'The same items are still failing', color: 'warning' },
  better: { label: 'Fewer items failing', color: 'success' },
  worse: { label: 'New items failing', color: 'danger' },
  churn: { label: 'Some fixed, some new', color: 'warning' },
};

/**
 * Full comparison of two runs.
 *
 * Runs of different rules are refused: two controls checking different things have
 * no shared business keys, so every item would read as both introduced and
 * resolved — a comparison that is not merely useless but actively misleading.
 */
function compareRuns({ fromRun, toRun, findingsFrom, findingsTo, sampleLimit }) {
  if (!fromRun || !toRun) throw new Error('Two runs are needed to compare.');
  if (fromRun.id === toRun.id) throw new Error('Select two different runs.');
  if (Number(fromRun.rule_id) !== Number(toRun.rule_id)) {
    throw new Error('Only runs of the same rule can be compared — different rules check different records, so their findings have nothing in common.');
  }

  // Order the pair by time rather than trusting the caller, so "introduced" and
  // "resolved" always mean what their names say.
  const earlier = new Date(fromRun.started_at) <= new Date(toRun.started_at) ? fromRun : toRun;
  const later = earlier === fromRun ? toRun : fromRun;
  const earlierFindings = earlier === fromRun ? findingsFrom : findingsTo;
  const laterFindings = earlier === fromRun ? findingsTo : findingsFrom;

  const findings = diffFindings(earlierFindings, laterFindings, { sampleLimit });
  return {
    earlier,
    later,
    reversed: earlier !== fromRun,
    versionChanged: Number(earlier.rule_version) !== Number(later.rule_version),
    metrics: diffRunMetrics(earlier, later),
    outcomes: diffOutcomes(earlierFindings, laterFindings),
    findings,
    summary: summarizeVerdict(findings),
  };
}

const SEVERITY_LEVELS = ['high', 'medium', 'low'];

/**
 * The two most recent completed runs of each rule, so one page can answer "is every
 * control moving in the right direction" without picking pairs by hand.
 *
 * Rules with a single run are still listed — with what that run found and no
 * comparison — because a control that has only ever run once is exactly the one
 * someone needs to be told about, not one to omit from the overview.
 */
function latestPairsByRule(runs) {
  const byRule = new Map();
  for (const run of runs || []) {
    if (run.status !== 'completed') continue;
    const key = Number(run.rule_id);
    if (!byRule.has(key)) {
      byRule.set(key, { ruleId: key, ruleName: run.rule_name || 'Rule #' + key, runs: [] });
    }
    byRule.get(key).runs.push(run);
  }

  const pairs = [];
  for (const entry of byRule.values()) {
    // Newest first, so the pair is the two most recent whatever order they arrived in.
    const ordered = entry.runs.slice().sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
    pairs.push({
      ruleId: entry.ruleId,
      ruleName: entry.ruleName,
      later: ordered[0] || null,
      earlier: ordered[1] || null,
      runCount: ordered.length,
    });
  }
  return pairs.sort((a, b) => a.ruleName.localeCompare(b.ruleName));
}

function groupFindingsByRun(findings) {
  const byRun = new Map();
  for (const finding of findings || []) {
    const key = Number(finding.run_id);
    if (!byRun.has(key)) byRun.set(key, []);
    byRun.get(key).push(finding);
  }
  return byRun;
}

function countBySeverity(findings) {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of findings || []) {
    const level = SEVERITY_LEVELS.includes(finding.severity) ? finding.severity : 'medium';
    counts[level] += 1;
  }
  return counts;
}

/**
 * One row per rule: where it stands now, and how that differs from its previous run.
 * Built on `compareRuns` so the overview and the detailed pair view can never
 * disagree about what "newly failing" means.
 */
function compareAcrossRules({ runs, findings, sampleLimit = 5 }) {
  const findingsByRun = groupFindingsByRun(findings);

  return latestPairsByRule(runs).map(pair => {
    const laterFindings = pair.later ? (findingsByRun.get(Number(pair.later.id)) || []) : [];
    const row = {
      ruleId: pair.ruleId,
      ruleName: pair.ruleName,
      later: pair.later,
      earlier: pair.earlier,
      runCount: pair.runCount,
      severity: countBySeverity(laterFindings),
      exceptionCount: pair.later ? Number(pair.later.exception_count) || 0 : 0,
      comparable: !!pair.earlier,
      comparison: null,
      summary: null,
      error: null,
    };
    if (!pair.earlier) return row;

    try {
      row.comparison = compareRuns({
        fromRun: pair.earlier,
        toRun: pair.later,
        findingsFrom: findingsByRun.get(Number(pair.earlier.id)) || [],
        findingsTo: laterFindings,
        sampleLimit,
      });
      row.summary = row.comparison.summary;
    } catch (err) {
      // One rule that cannot be compared must not take the overview down with it.
      row.error = err.message;
    }
    return row;
  });
}

module.exports = {
  RUN_METRICS,
  VERDICT_DEFS,
  SEVERITY_LEVELS,
  latestPairsByRule,
  compareAcrossRules,
  diffRunMetrics,
  diffOutcomes,
  diffFindings,
  summarizeVerdict,
  compareRuns,
};
