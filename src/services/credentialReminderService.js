/**
 * Which service principals' credentials are about to stop working.
 *
 * A client secret or certificate that expires stops every scan, schedule and
 * capacity action for that tenant at once, and the first anyone hears of it is
 * a failed sign-in. The expiry is known ahead of time — from Key Vault, from the
 * certificate itself, or entered by hand — so the app says so first.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WARN_DAYS = Number.parseInt(process.env.CREDENTIAL_WARN_DAYS || '30', 10) || 30;

const SOURCE_LABEL = {
  'key-vault': 'Key Vault',
  certificate: 'the certificate',
  entered: 'entered in Settings',
};

function credentialStatus(sp, { now = Date.now(), warnDays = WARN_DAYS } = {}) {
  const raw = sp && sp.credential_expires_at;
  const at = raw ? new Date(raw) : null;
  if (!at || Number.isNaN(at.getTime())) {
    return { state: 'unknown', expiresAt: null, daysLeft: null, source: null, label: 'Expiry unknown' };
  }
  const daysLeft = Math.floor((at.getTime() - now) / DAY_MS);
  const source = SOURCE_LABEL[sp.credential_expiry_source] || 'recorded';
  const state = at.getTime() <= now ? 'expired' : daysLeft < warnDays ? 'expiring' : 'ok';
  const date = at.toISOString().slice(0, 10);
  const label = state === 'expired' ? 'Expired on ' + date
    : state === 'expiring' ? 'Expires in ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + ' (' + date + ')'
      : 'Valid until ' + date;
  return { state, expiresAt: at.toISOString(), daysLeft, source, label };
}

/** Principals whose credential has expired or expires within the warning window. */
function reminders(servicePrincipals, options = {}) {
  return (servicePrincipals || [])
    .map(sp => ({ id: sp.id, name: sp.name, tenantId: sp.tenant_id, ...credentialStatus(sp, options) }))
    .filter(entry => entry.state === 'expired' || entry.state === 'expiring')
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

module.exports = { credentialStatus, reminders, WARN_DAYS };
