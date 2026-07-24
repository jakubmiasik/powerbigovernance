const msal = require('@azure/msal-node');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');

// ── Key Vault: resolve SP client secret at runtime ──
const kvClientCache = new Map(); // kvName → SecretClient
const kvSecretCache = new Map(); // `kvName|secretName` → { value, expiresAt }
const KV_SECRET_TTL = 60 * 60 * 1000; // re-fetch secret every hour

function getKvClient(keyVaultName) {
  if (!kvClientCache.has(keyVaultName)) {
    const url = `https://${keyVaultName}.vault.azure.net`;
    kvClientCache.set(keyVaultName, new SecretClient(url, new DefaultAzureCredential()));
  }
  return kvClientCache.get(keyVaultName);
}

async function getSecretFromKeyVault(keyVaultName, secretName) {
  const cacheKey = `${keyVaultName}|${secretName}`;
  const cached = kvSecretCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const client = getKvClient(keyVaultName);
  const secret = await client.getSecret(secretName);
  if (!secret || !secret.value) {
    throw new Error(`Secret '${secretName}' not found in Key Vault '${keyVaultName}'.`);
  }
  kvSecretCache.set(cacheKey, { value: secret.value, expiresAt: Date.now() + KV_SECRET_TTL });
  return secret.value;
}

// Resolve the client secret for a SP config — ALWAYS from Key Vault
async function resolveClientSecret(spConfig) {
  if (!spConfig.key_vault_name || !spConfig.key_vault_secret_name) {
    throw new Error('Service principal must have Key Vault configured. Open Settings and set the Key Vault Name and Secret Name.');
  }
  return getSecretFromKeyVault(spConfig.key_vault_name, spConfig.key_vault_secret_name);
}

// ── Cache MSAL apps by config hash to support multiple SPs ──
const appCache = new Map();

function getConfigHash(cfg) {
  return `${cfg.clientId}|${cfg.clientSecret}|${cfg.tenantId}`;
}

async function getConfidentialClient(spConfig) {
  if (!spConfig || !spConfig.client_id || !spConfig.tenant_id) {
    throw new Error('Service principal is not configured. Go to Settings to add one.');
  }

  const clientSecret = await resolveClientSecret(spConfig);
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

async function getAccessTokenForSP(spConfig) {
  const app = await getConfidentialClient(spConfig);
  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://analysis.windows.net/powerbi/api/.default'],
  });
  if (!result || !result.accessToken) throw new Error('Failed to acquire Power BI access token');
  return result.accessToken;
}

async function getFabricTokenForSP(spConfig) {
  const app = await getConfidentialClient(spConfig);
  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://api.fabric.microsoft.com/.default'],
  });
  if (!result || !result.accessToken) throw new Error('Failed to acquire Fabric API access token');
  return result.accessToken;
}

async function getGraphTokenForSP(spConfig) {
  const app = await getConfidentialClient(spConfig);
  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });
  if (!result || !result.accessToken) throw new Error('Failed to acquire Microsoft Graph access token');
  return result.accessToken;
}

async function getOneLakeTokenForSP(spConfig) {
  const app = await getConfidentialClient(spConfig);
  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://storage.azure.com/.default'],
  });
  if (!result || !result.accessToken) throw new Error('Failed to acquire OneLake storage access token');
  return result.accessToken;
}

async function getAzureManagementTokenForSP(spConfig) {
  const app = await getConfidentialClient(spConfig);
  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://management.azure.com/.default'],
  });
  if (!result || !result.accessToken) throw new Error('Failed to acquire Azure Management access token');
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
    scopes: ['https://analysis.windows.net/powerbi/api/Tenant.ReadWrite.All'],
    redirectUri, state, prompt: 'consent',
  });
}

async function acquireDelegatedToken(code, redirectUri) {
  const app = getDelegatedClient();
  const result = await app.acquireTokenByCode({
    code,
    scopes: ['https://analysis.windows.net/powerbi/api/Tenant.ReadWrite.All'],
    redirectUri,
  });
  if (!result || !result.accessToken) throw new Error('Failed to acquire delegated Power BI token');
  return result.accessToken;
}

module.exports = {
  getAccessTokenForSP, getFabricTokenForSP, getAzureManagementTokenForSP,
  getGraphTokenForSP, getOneLakeTokenForSP, resetAuthCache,
  getDelegatedAuthUrl, acquireDelegatedToken,
  getSecretFromKeyVault,
};
