const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const { isEncryptionConfigured } = require('../services/secretCryptoService');
const naming = require('../services/namingConventionService');
const { loadNamingConvention, saveNamingConvention } = require('../services/namingConventionStore');
const {
  getAccessTokenForSP,
  getKeyVaultDelegatedAuthUrl,
  acquireKeyVaultDelegatedToken,
} = require('../services/authService');

function encodeState(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeState(state) {
  if (!state) return null;
  try {
    return JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function getSafeReturnTo(candidate) {
  if (typeof candidate === 'string' && candidate.startsWith('/')) return candidate;
  return '/settings';
}

function buildKeyVaultAuthUrl(req, spId, returnTo = '/settings') {
  const params = new URLSearchParams({
    spId: String(spId),
    returnTo: getSafeReturnTo(returnTo),
  });
  return `/settings/kv/auth?${params.toString()}`;
}

function getDelegatedKeyVaultTokenFromSession(req) {
  const token = req.session?.keyVaultDelegatedToken?.token;
  return token || null;
}

function namingLocals(convention) {
  return {
    naming: convention,
    segmentDefs: naming.SEGMENT_DEFS,
    letterCases: naming.LETTER_CASES,
    namingPattern: naming.describeConvention(convention),
    namingExample: naming.exampleName(convention),
  };
}

router.get('/', async (req, res) => {
  const convention = await loadNamingConvention();
  try {
    const servicePrincipals = await db.getServicePrincipals();
    res.render('config', {
      title: 'Settings',
      user: req.user,
      // Never hand the stored ciphertext to the template — only whether one exists.
      servicePrincipals: servicePrincipals.map((sp) => ({ ...sp, client_secret: sp.client_secret ? true : null })),
      secretEncryptionReady: isEncryptionConfigured(),
      ...namingLocals(convention),
      success: req.flash('success'),
      error: req.flash('error'),
    });
  } catch (err) {
    res.render('config', {
      title: 'Settings',
      user: req.user,
      servicePrincipals: [],
      secretEncryptionReady: isEncryptionConfigured(),
      ...namingLocals(convention),
      success: [],
      error: [err.message],
    });
  }
});

/**
 * Saves the naming convention.
 *
 * A convention that cannot be satisfied — no required part, an artifact naming an
 * experience that does not exist — is refused rather than stored, because the
 * result would be a tenant-wide finding nobody can clear.
 */
router.post('/naming', async (req, res) => {
  try {
    const restoring = req.body.restoreDefaults === 'true';
    const convention = restoring
      // Restoring keeps whether it is enforced: someone fixing a convention they
      // broke should not also have to remember to switch it back on.
      ? naming.normalizeConvention({ ...naming.DEFAULT_CONVENTION, enabled: (await loadNamingConvention()).enabled })
      : naming.conventionFromForm(req.body);

    const problems = naming.validateConvention(convention);
    if (problems.length) {
      req.flash('error', 'The naming convention was not saved: ' + problems.join(' '));
      return res.redirect('/settings');
    }

    await saveNamingConvention(convention, req.user ? (req.user.name || req.user.email) : null);
    req.flash('success', restoring
      ? 'Naming convention restored to the defaults.'
      : 'Naming convention saved. Artifacts are checked as ' + naming.describeConvention(convention) + '.');
  } catch (err) {
    req.flash('error', 'Could not save the naming convention: ' + err.message);
  }
  res.redirect('/settings');
});

router.post('/sp/save', async (req, res) => {
  const { id, name, tenantId, clientId, enterpriseAppObjectId, keyVaultName, keyVaultSecretName, clientSecret, secretSource } = req.body;
  const useKeyVault = secretSource !== 'direct';

  if (!name || !tenantId || !clientId) {
    req.flash('error', 'Name, Tenant ID and Client ID are required.');
    return res.redirect('/settings');
  }
  if (useKeyVault && (!keyVaultName || !keyVaultSecretName)) {
    req.flash('error', 'Key Vault Name and Secret Name are required when using Key Vault.');
    return res.redirect('/settings');
  }
  if (!useKeyVault && !clientSecret && !id) {
    req.flash('error', 'A client secret is required when Key Vault is not used.');
    return res.redirect('/settings');
  }

  try {
    await db.saveServicePrincipal({
      id: id ? parseInt(id, 10) : null,
      name,
      tenantId,
      clientId,
      // undefined leaves any existing secret untouched; null clears it.
      clientSecret: useKeyVault ? null : (clientSecret ? clientSecret : undefined),
      enterpriseAppObjectId: enterpriseAppObjectId || null,
      keyVaultName: useKeyVault ? keyVaultName : null,
      keyVaultSecretName: useKeyVault ? keyVaultSecretName : null,
    });
    req.flash('success', 'Service principal saved.');
  } catch (err) {
    req.flash('error', 'Failed to save: ' + err.message);
  }
  res.redirect('/settings');
});

router.post('/sp/delete/:id', async (req, res) => {
  try {
    await db.deleteServicePrincipal(parseInt(req.params.id, 10));
    req.flash('success', 'Service principal deleted.');
  } catch (err) {
    req.flash('error', 'Failed to delete: ' + err.message);
  }
  res.redirect('/settings');
});

router.post('/sp/test/:id', async (req, res) => {
  try {
    const spId = parseInt(req.params.id, 10);
    const sp = await db.getServicePrincipalById(spId);
    if (!sp) return res.json({ success: false, message: 'Service principal not found.' });

    const keyVaultAuthUrl = buildKeyVaultAuthUrl(req, sp.id, '/settings');
    await getAccessTokenForSP(sp, {
      keyVaultDelegatedToken: getDelegatedKeyVaultTokenFromSession(req),
      keyVaultAuthUrl,
    });
    res.json({ success: true, message: 'Successfully connected to Power BI API.' });
  } catch (err) {
    if (err.code === 'KEYVAULT_USER_AUTH_REQUIRED') {
      return res.status(403).json({
        success: false,
        requiresKeyVaultAuth: true,
        authUrl: err.keyVaultAuthUrl || buildKeyVaultAuthUrl(req, req.params.id, '/settings'),
        message: err.message,
      });
    }
    res.json({ success: false, message: err.message });
  }
});

router.get('/kv/auth', async (req, res) => {
  try {
    const spId = parseInt(req.query.spId, 10);
    const returnTo = getSafeReturnTo(req.query.returnTo);
    const sp = await db.getServicePrincipalById(spId);
    if (!sp) {
      req.flash('error', 'Service principal not found.');
      return res.redirect('/settings');
    }

    const state = encodeState({ flow: 'kv', spId: sp.id, returnTo });
    const redirectUri = `${req.protocol}://${req.get('host')}/settings/kv/auth/callback`;
    const authUrl = await getKeyVaultDelegatedAuthUrl(redirectUri, state);
    res.redirect(authUrl);
  } catch (err) {
    req.flash('error', 'Failed to start Key Vault authentication: ' + err.message);
    res.redirect('/settings');
  }
});

router.get('/kv/auth/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  const parsedState = decodeState(state);
  const returnTo = getSafeReturnTo(parsedState?.returnTo);

  try {
    if (error) {
      req.flash('error', errorDescription || error);
      return res.redirect(returnTo);
    }

    const redirectUri = `${req.protocol}://${req.get('host')}/settings/kv/auth/callback`;
    const token = await acquireKeyVaultDelegatedToken(code, redirectUri);
    req.session.keyVaultDelegatedToken = {
      token: token.accessToken,
      expiresOn: token.expiresOn,
    };
    req.flash('success', 'Key Vault user authentication completed. You can retry your operation now.');
    res.redirect(returnTo);
  } catch (err) {
    req.flash('error', 'Key Vault authentication failed: ' + err.message);
    res.redirect(returnTo);
  }
});

module.exports = router;
