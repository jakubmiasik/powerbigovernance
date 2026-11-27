/**
 * Reads who holds which role in every workspace, through the admin scanner.
 *
 * The scan used to ask `GET admin/groups/{id}/users` once per workspace. That
 * endpoint allows roughly 200 calls an hour, so on a tenant of a few hundred
 * workspaces the later calls were refused and those workspaces were stored with
 * an empty access list, as if nobody were in them.
 *
 * The scanner (`POST admin/workspaces/getInfo?getArtifactUsers=true`) returns the
 * same lists for up to 100 workspaces per request, against a limit of 500
 * requests an hour. Whatever it cannot answer falls back to the per-workspace
 * call, and whatever that cannot answer is reported as not read: never as empty.
 *
 * The API is passed in, so the batching, polling and fallback can be tested
 * without a tenant.
 */

const BATCH_SIZE = 100;
const PARALLEL_SCANS = 4;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const FALLBACK_BATCH = 10;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const keyOf = (id) => String(id || '').toLowerCase();

/** One scanner request: start it, wait for it, read it. Returns id → users[]. */
async function scanBatch(api, ids, options) {
  const started = await api.startAccessScan(ids);
  const scanId = started && started.id;
  if (!scanId) throw new Error('The scanner did not return a scan id');

  const deadline = options.now() + options.timeoutMs;
  for (;;) {
    await options.sleep(options.pollMs);
    const status = await api.getScanStatus(scanId);
    const state = String((status && status.status) || '').toLowerCase();
    if (state === 'succeeded') break;
    if (state === 'failed') throw new Error('The scanner reported the scan as failed');
    if (options.now() > deadline) throw new Error('The scanner did not finish within ' + Math.round(options.timeoutMs / 1000) + ' s');
  }

  const result = await api.getScanResult(scanId);
  const found = new Map();
  for (const workspace of (result && result.workspaces) || []) {
    // A workspace the scanner returns without a `users` array was not answered —
    // classic workspaces, for one, are not listed this way.
    if (Array.isArray(workspace.users)) found.set(keyOf(workspace.id), workspace.users);
  }
  return found;
}

/**
 * Returns { users: Map(id → users[]), unread: id[], viaScanner, viaFallback,
 * scannerError }.
 */
async function readWorkspaceAccess(api, workspaceIds, options = {}) {
  const settings = {
    batchSize: options.batchSize || BATCH_SIZE,
    parallel: options.parallel || PARALLEL_SCANS,
    pollMs: options.pollMs === undefined ? POLL_INTERVAL_MS : options.pollMs,
    timeoutMs: options.timeoutMs || POLL_TIMEOUT_MS,
    sleep: options.sleep || sleep,
    now: options.now || Date.now,
    onProgress: options.onProgress || (() => {}),
    shouldStop: options.shouldStop || (() => {}),
  };

  const ids = [...new Set((workspaceIds || []).filter(Boolean))];
  const users = new Map();
  let scannerError = null;
  let viaScanner = 0;

  if (typeof api.startAccessScan === 'function') {
    const batches = chunk(ids, settings.batchSize);
    for (const group of chunk(batches, settings.parallel)) {
      settings.shouldStop();
      const results = await Promise.allSettled(group.map(batch => scanBatch(api, batch, settings)));
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          for (const id of group[index]) {
            const list = result.value.get(keyOf(id));
            if (list) { users.set(id, list); viaScanner += 1; }
          }
        } else if (!scannerError) {
          scannerError = result.reason && result.reason.message ? result.reason.message : String(result.reason);
        }
      });
      settings.onProgress({ done: users.size, total: ids.length, stage: 'scanner' });
    }
  }

  // Whatever the scanner left out is asked one workspace at a time.
  const remaining = ids.filter(id => !users.has(id));
  const unread = [];
  let viaFallback = 0;
  for (const batch of chunk(remaining, FALLBACK_BATCH)) {
    settings.shouldStop();
    const results = await Promise.allSettled(batch.map(id => api.readWorkspaceUsers(id)));
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') { users.set(batch[index], result.value || []); viaFallback += 1; }
      else unread.push(batch[index]);
    });
    settings.onProgress({ done: users.size, total: ids.length, stage: 'fallback' });
  }

  return { users, unread, viaScanner, viaFallback, scannerError };
}

module.exports = { readWorkspaceAccess, BATCH_SIZE };
