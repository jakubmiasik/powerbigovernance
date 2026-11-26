/**
 * How a scan is named to people: its service principal and that principal's own
 * scan number, "SoftwareOne #5". The database id is an internal key for joins and
 * links; it is never the name. A run not yet numbered (a database that has not run
 * the numbering migration) says so instead of passing its id off as a number.
 */

function principalName(run) {
  if (!run) return 'Unknown principal';
  if (run.sp_name) return run.sp_name;
  if (run.spName) return run.spName;
  const spId = run.sp_id !== undefined ? run.sp_id : run.spId;
  return spId === null || spId === undefined ? 'Managed identity' : 'Principal ' + spId;
}

function runNumber(run) {
  if (!run) return null;
  const value = run.sp_run_number !== undefined ? run.sp_run_number : run.spRunNumber;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function runLabel(run) {
  if (!run) return '';
  const number = runNumber(run);
  return principalName(run) + (number ? ' #' + number : ' (unnumbered, id ' + run.id + ')');
}

module.exports = { principalName, runNumber, runLabel };
