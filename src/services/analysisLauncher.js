/**
 * The seam between "something wants a scan" and the code that runs one.
 *
 * The runner itself lives with the analysis route, because it owns the in-memory
 * progress map that the progress endpoints read. The scheduler must be able to
 * start a scan without importing a route module — that would be a cycle, and it
 * would make the scheduler untestable without an Express app.
 *
 * So the route registers its runner here at load, and the scheduler asks this.
 * Small, and honest about why it exists.
 */

let runner = null;

function register(fn) {
  runner = typeof fn === 'function' ? fn : null;
}

function isRegistered() {
  return !!runner;
}

/**
 * Starts a scan. Resolves with `{ runId }` once the run record exists — not when
 * the scan finishes. A tenant scan takes minutes to hours, and a scheduler tick
 * that waited for one would block every other schedule behind it.
 */
async function start(options) {
  if (!runner) {
    throw new Error('No analysis runner is registered in this process, so a scan cannot be started from here.');
  }
  return runner(options || {});
}

module.exports = { register, isRegistered, start, _reset: () => { runner = null; } };
