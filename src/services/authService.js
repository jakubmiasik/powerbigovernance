const msal = require('@azure/msal-node');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');
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

async function getSecretFromKeyVault(keyVaultName, secretName, options = {}) {
  const cacheKey = `${keyVaultName}|${secretName}`;
  const cached = kvSecretCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const client = getKvClient(keyVaultName);
    const secret = await client.getSecret(secretName);
    if (!secret || !secret.value) {
      throw new Error(`Secret '${secretName}' not found in Key Vault '${keyVaultName}'.`);
    }
    kvSecretCache.set(cacheKey, { value: secret.value, expiresAt: Date.now() + KV_SECRET_TTL });
    return secret.value;
  } catch (miError) {
    if (!isKeyVaultAuthorizationError(miError)) {
      throw miError;
    }

    if (options.keyVaultDelegatedToken) {
      try {
        const delegatedClient = new SecretClient(
          `https://${keyVaultName}.vault.azure.net`,
          createDelegatedTokenCredential(options.keyVaultDelegatedToken)
        );
        const secret = await delegatedClient.getSecret(secretName);
        if (!secret || !secret.value) {
          throw new Error(`Secret '${secretName}' not found in Key Vault '${keyVaultName}'.`);
        }
        kvSecretCache.set(cacheKey, { value: secret.value, expiresAt: Date.now() + KV_SECRET_TTL });
        return secret.value;
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

// Resolve the client secret for a SP config.
// Key Vault is preferred. A directly stored secret (encrypted at rest) is the
// fallback for tenants where the vault cannot be reached at all.
async function resolveClientSecret(spConfig, options = {}) {
  const hasKeyVault = Boolean(spConfig.key_vault_name && spConfig.key_vault_secret_name);
  const hasStoredSecret = Boolean(spConfig.client_secret);

  if (hasKeyVault) {
    try {
      return await getSecretFromKeyVault(spConfig.key_vault_name, spConfig.key_vault_secret_name, options);
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

  const clientSecret = await resolveClientSecret(spConfig, options);
  const hash = getConfigHash({ clientId: spConfig.client_id, clientSecret, tenantId: spConfig.tenant_id });

  if (appCache.has(hash)) {
    return appCache.get(hash);
  }

  const app = new msal.ConfidentialClientApplication({
    auth: {
      clientId: spConfig.client_id,
      clientSecret,
      authority: `https://login.microsoftonline.com/${spConfig.tenant_id}`,
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
  _private: { resolveClientSecret },
};
