const msal = require('@azure/msal-node');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');
const crypto = require('crypto');
const { decryptSecret } = require('./secretCryptoService');

// ── Key Vault: resolve SP client secret at runtime ──
const kvClientCache = new Map(); // kvName → SecretClient
const kvSecretCache = new Map(); // `kvName|secretName` → { value, expiresAt }
const KV_SECRET_TTL = 60 * 60 * 1000; // re-fetch secret every hour
const PBI_DELEGATED_SCOPES = ['https://analysis.windows.net/powerbi/api/Tenant.ReadWrite.All'];
const KV_DELEGATED_SCOPES = ['https://vault.azure.net/user_impersonation'];

function getKvClient(keyVaultName) {
  if (!kvClientCache.has(keyVaultName)) {
    const url = `https://${keyVaultName}.vault.azure.net`;
    kvClientCache.set(keyVaultName, new SecretClient(url, new DefaultAzureCredential()));
  }
  return kvClientCache.get(keyVaultName);
}

function createDelegatedTokenCredential(accessToken) {
  return {
    async getToken() {
      return {
        token: accessToken,
        expiresOnTimestamp: Date.now() + (50 * 60 * 1000),
      };
    },
  };
}

function isKeyVaultAuthorizationError(err) {
  const status = err?.statusCode || err?.status || err?.code;
  if (status === 401 || status === 403) return true;
  const message = (err?.message || '').toLowerCase();
  return message.includes('forbidden') || message.includes('unauthorized') || message.includes('permission');
}

function createKeyVaultAuthRequiredError(keyVaultName, authUrl) {
  const message = authUrl
    ? `Managed identity cannot access Key Vault '${keyVaultName}'. Authenticate as a user with Key Vault access: ${authUrl}`
    : `Managed identity cannot access Key Vault '${keyVaultName}'. Authenticate as a user with Key Vault access in Settings.`;
  const err = new Error(message);
  err.code = 'KEYVAULT_USER_AUTH_REQUIRED';
  if (authUrl) err.keyVaultAuthUrl = authUrl;
  return err;
}

function secretRecord(secret) {
  return {
    value: secret.value,
    expiresOn: secret.properties && secret.properties.expiresOn ? secret.properties.expiresOn : null,
    contentType: secret.properties && secret.properties.contentType ? secret.properties.contentType : null,
  };
}

// The secret and what Key Vault knows about it: its expiry and content type.
async function getKeyVaultSecretRecord(keyVaultName, secretName, options = {}) {
  const cacheKey = `${keyVaultName}|${secretName}`;
  const cached = kvSecretCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.record;
  }

  const read = async (client) => {
    const secret = await client.getSecret(secretName);
    if (!secret || !secret.value) {
      throw new Error(`Secret '${secretName}' not found in Key Vault '${keyVaultName}'.`);
    }
    const record = secretRecord(secret);
    kvSecretCache.set(cacheKey, { record, expiresAt: Date.now() + KV_SECRET_TTL });
    return record;
  };

  try {
    return await read(getKvClient(keyVaultName));
  } catch (miError) {
    if (!isKeyVaultAuthorizationError(miError)) {
      throw miError;
    }

    if (options.keyVaultDelegatedToken) {
      try {
        return await read(new SecretClient(
          `https://${keyVaultName}.vault.azure.net`,
          createDelegatedTokenCredential(options.keyVaultDelegatedToken)
        ));
      } catch (delegatedError) {
        if (isKeyVaultAuthorizationError(delegatedError)) {
          throw createKeyVaultAuthRequiredError(keyVaultName, options.keyVaultAuthUrl);
        }
        throw delegatedError;
      }
    }

    throw createKeyVaultAuthRequiredError(keyVaultName, options.keyVaultAuthUrl);
  }
}

async function getSecretFromKeyVault(keyVaultName, secretName, options = {}) {
  return (await getKeyVaultSecretRecord(keyVaultName, secretName, options)).value;
}

// Told when a credential's expiry becomes known, so it can be stored and shown.
// Set by whoever wants to know (the database layer at start-up); never required.
let expiryListener = null;
function onCredentialExpiry(fn) { expiryListener = typeof fn === 'function' ? fn : null; }
const reportedExpiry = new Map(); // sp id → what was last reported
function reportExpiry(spConfig, expiresOn, source) {
  if (!expiryListener || !spConfig || !spConfig.id || !expiresOn) return;
  const key = new Date(expiresOn).toISOString() + '|' + source;
  if (reportedExpiry.get(spConfig.id) === key) return;
  reportedExpiry.set(spConfig.id, key);
  Promise.resolve().then(() => expiryListener(spConfig.id, expiresOn, source)).catch(() => {});
}

/**
 * A certificate kept in Key Vault, read as the PEM its secret holds: the private
 * key and the certificate chain. Key Vault certificates created with the PKCS#12
 * content type cannot be read this way, and the error says so.
 */
function parseCertificatePem(pem) {
  const text = String(pem || '');
  const keyMatch = text.match(/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/);
  const certs = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  if (!keyMatch || !certs.length) {
    throw new Error('The certificate in Key Vault is not readable as PEM. Create it with the PEM content type (application/x-pem-file), so the app can read its private key.');
  }
  const x509 = new crypto.X509Certificate(certs[0]);
  return {
    privateKey: keyMatch[0],
    certificate: certs[0],
    x5c: certs.join('\n'),
    thumbprintSha256: x509.fingerprint256.replace(/:/g, '').toLowerCase(),
    thumbprint: x509.fingerprint.replace(/:/g, '').toLowerCase(),
    validTo: new Date(x509.validTo),
  };
}

async function resolveClientCertificate(spConfig, options = {}) {
  if (!spConfig.key_vault_name || !spConfig.key_vault_certificate_name) {
    throw new Error('Certificate sign-in needs a Key Vault name and the certificate name. Open Settings and add them.');
  }
  const record = await getKeyVaultSecretRecord(spConfig.key_vault_name, spConfig.key_vault_certificate_name, options);
  if (record.contentType && /pkcs12/i.test(record.contentType)) {
    throw new Error(`Certificate '${spConfig.key_vault_certificate_name}' is stored as PKCS#12. Re-create it in Key Vault with the PEM content type.`);
  }
  const certificate = parseCertificatePem(record.value);
  reportExpiry(spConfig, certificate.validTo, 'certificate');
  return certificate;
}

// Resolve the client secret for a SP config.
// Key Vault is preferred. A directly stored secret (encrypted at rest) is the
// fallback for tenants where the vault cannot be reached at all.
async function resolveClientSecret(spConfig, options = {}) {
  const hasKeyVault = Boolean(spConfig.key_vault_name && spConfig.key_vault_secret_name);
  const hasStoredSecret = Boolean(spConfig.client_secret);

  if (hasKeyVault) {
    try {
      const record = await getKeyVaultSecretRecord(spConfig.key_vault_name, spConfig.key_vault_secret_name, options);
      if (record.expiresOn) reportExpiry(spConfig, record.expiresOn, 'key-vault');
      return record.value;
    } catch (err) {
      if (!hasStoredSecret) throw err;
      // The vault is configured but unusable (cross-tenant, network, or policy).
      // Fall back rather than blocking the tenant entirely.
      console.warn(`[Auth] Key Vault lookup failed for "${spConfig.name || spConfig.client_id}", using the stored secret:`, err.message);
    }
  }

  if (hasStoredSecret) {
    try {
      return decryptSecret(spConfig.client_secret);
    } catch (err) {
      throw new Error(`Stored client secret could not be decrypted (${err.message}). Re-enter it in Settings, or check SECRET_ENCRYPTION_KEY.`);
    }
  }

  throw new Error('Service principal has no credential. Open Settings and either configure Key Vault or provide the client secret directly.');
}

// ── Cache MSAL apps by config hash to support multiple SPs ──
const appCache = new Map();

function getConfigHash(cfg) {
  return `${cfg.clientId}|${cfg.clientSecret}|${cfg.tenantId}`;
}

async function getConfidentialClient(spConfig, options = {}) {
  if (!spConfig || !spConfig.client_id || !spConfig.tenant_id) {
    throw new Error('Service principal is not configured. Go to Settings to add one.');
  }

  const authority = `https://login.microsoftonline.com/${spConfig.tenant_id}`;

  if (spConfig.auth_method === 'certificate') {
    const certificate = await resolveClientCertificate(spConfig, options);
    const hash = `cert|${spConfig.client_id}|${spConfig.tenant_id}|${certificate.thumbprintSha256}`;
    if (appCache.has(hash)) return appCache.get(hash);
    const app = new msal.ConfidentialClientApplication({
      auth: {
        clientId: spConfig.client_id,
        authority,
        clientCertificate: {
          thumbprintSha256: certificate.thumbprintSha256,
          privateKey: certificate.privateKey,
          x5c: certificate.x5c,
        },
      },
    });
    appCache.set(hash, app);
    return app;
  }

  const clientSecret = await resolveClientSecret(spConfig, options);
  const hash = getConfigHash({ clientId: spConfig.client_id, clientSecret, tenantId: spConfig.tenant_id });

  if (appCache.has(hash)) {
    return appCache.get(hash);
  }

  const app = new msal.ConfidentialClientApplication({
    auth: {
      clientId: spConfig.client_id,
      clientSecret,
      authority,
    },
  });
  appCache.set(hash, app);
  return app;
}

async function getAccessTokenForSP(spConfig, options = {}) {
  const app = await getConfidentialClient(spConfig, options);
  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://analysis.windows.net/powerbi/api/.default'],
  });
  if (!result || !result.accessToken) throw new Error('Failed to acquire Power BI access token');
  return result.accessToken;
}

async function getFabricTokenForSP(spConfig, options = {}) {
  const app = await getConfidentialClient(spConfig, options);
  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://api.fabric.microsoft.com/.default'],
  });
  if (!result || !result.accessToken) throw new Error('Failed to acquire Fabric API access token');
  return result.accessToken;
}

async function getGraphTokenForSP(spConfig, options = {}) {
  const app = await getConfidentialClient(spConfig, options);
  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });
  if (!result || !result.accessToken) throw new Error('Failed to acquire Microsoft Graph access token');
  return result.accessToken;
}

async function getOneLakeTokenForSP(spConfig, options = {}) {
  const app = await getConfidentialClient(spConfig, options);
  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://storage.azure.com/.default'],
  });
  if (!result || !result.accessToken) throw new Error('Failed to acquire OneLake storage access token');
  return result.accessToken;
}

async function getAzureManagementTokenForSP(spConfig, options = {}) {
  const app = await getConfidentialClient(spConfig, options);
  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://management.azure.com/.default'],
  });
  if (!result || !result.accessToken) throw new Error('Failed to acquire Azure Management access token');
  return result.accessToken;
}

// Fabric SQL analytics endpoints authenticate with an Azure SQL scoped token.
async function getSqlTokenForSP(spConfig) {
  const app = await getConfidentialClient(spConfig);
  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://database.windows.net/.default'],
  });
  if (!result || !result.accessToken) throw new Error('Failed to acquire SQL access token');
  return result.accessToken;
}

function resetAuthCache() {
  appCache.clear();
}

// ── Delegated (user-based) auth for migration ──
let delegatedMsalApp = null;

function getDelegatedClient() {
  if (delegatedMsalApp) return delegatedMsalApp;
  const clientId = process.env.ENTRA_CLIENT_ID;
  const clientSecret = process.env.ENTRA_CLIENT_SECRET;
  const tenantId = process.env.ENTRA_TENANT_ID;
  if (!clientId || !clientSecret || !tenantId) {
    throw new Error('Delegated auth not configured. Set ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET, and ENTRA_TENANT_ID.');
  }
  delegatedMsalApp = new msal.ConfidentialClientApplication({
    auth: { clientId, clientSecret, authority: `https://login.microsoftonline.com/${tenantId}` },
  });
  return delegatedMsalApp;
}

function getDelegatedAuthUrl(redirectUri, state) {
  const app = getDelegatedClient();
  return app.getAuthCodeUrl({
    scopes: PBI_DELEGATED_SCOPES,
    redirectUri, state, prompt: 'consent',
  });
}

async function acquireDelegatedToken(code, redirectUri) {
  const app = getDelegatedClient();
  const result = await app.acquireTokenByCode({
    code,
    scopes: PBI_DELEGATED_SCOPES,
    redirectUri,
  });
  if (!result || !result.accessToken) throw new Error('Failed to acquire delegated Power BI token');
  return result.accessToken;
}

function getKeyVaultDelegatedAuthUrl(redirectUri, state) {
  const app = getDelegatedClient();
  return app.getAuthCodeUrl({
    scopes: KV_DELEGATED_SCOPES,
    redirectUri,
    state,
    prompt: 'select_account',
  });
}

async function acquireKeyVaultDelegatedToken(code, redirectUri) {
  const app = getDelegatedClient();
  const result = await app.acquireTokenByCode({
    code,
    scopes: KV_DELEGATED_SCOPES,
    redirectUri,
  });
  if (!result || !result.accessToken) throw new Error('Failed to acquire delegated Key Vault token');
  return {
    accessToken: result.accessToken,
    expiresOn: result.expiresOn ? result.expiresOn.toISOString() : null,
  };
}

module.exports = {
  getAccessTokenForSP, getFabricTokenForSP, getAzureManagementTokenForSP,
  getGraphTokenForSP, getOneLakeTokenForSP, getSqlTokenForSP, resetAuthCache,
  getDelegatedAuthUrl, acquireDelegatedToken,
  getKeyVaultDelegatedAuthUrl, acquireKeyVaultDelegatedToken,
  getSecretFromKeyVault,
  onCredentialExpiry,
  _private: { resolveClientSecret, parseCertificatePem, resolveClientCertificate, getConfidentialClient, kvSecretCache },
};
