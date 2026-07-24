const msal = require('@azure/msal-node');
const { DefaultAzureCredential } = require('@azure/identity');

// Cache MSAL apps by config hash to support multiple SPs
const appCache = new Map();

function getConfigHash(cfg) {
  return `${cfg.clientId}|${cfg.clientSecret}|${cfg.tenantId}`;
}

// ── Managed Identity token acquisition ──
const miCredential = new DefaultAzureCredential();
const miTokenCache = {};

// Token for System-assigned MI (fallback when no clientId configured)
async function getManagedIdentityToken(scope) {
  const cached = miTokenCache[scope];
  if (cached && cached.expiresOn > Date.now() + 5 * 60 * 1000) {
    return cached.token;
  }
  const result = await miCredential.getToken(scope);
  if (!result || !result.token) {
    throw new Error('Failed to acquire Managed Identity token for scope: ' + scope);
  }
  miTokenCache[scope] = { token: result.token, expiresOn: result.expiresOnTimestamp };
  return result.token;
}

// Token for User-assigned MI — keyed by clientId + scope
const { ManagedIdentityCredential } = require('@azure/identity');
const uamiCredentials = new Map();
const uamiTokenCache = {};

function getUamiCredential(clientId) {
  if (!uamiCredentials.has(clientId)) {
    uamiCredentials.set(clientId, new ManagedIdentityCredential({ clientId }));
  }
  return uamiCredentials.get(clientId);
}

async function getUamiToken(clientId, scope) {
  const cacheKey = clientId + '|' + scope;
  const cached = uamiTokenCache[cacheKey];
  if (cached && cached.expiresOn > Date.now() + 5 * 60 * 1000) {
    return cached.token;
  }
  const credential = getUamiCredential(clientId);
  const result = await credential.getToken(scope);
  if (!result || !result.token) {
    throw new Error('Failed to acquire User Assigned MI token (clientId: ' + clientId + ') for scope: ' + scope);
  }
  uamiTokenCache[cacheKey] = { token: result.token, expiresOn: result.expiresOnTimestamp };
  return result.token;
}

// Convenience wrappers — accept optional clientId
// When clientId is provided: User Assigned MI; otherwise: System Assigned / DefaultAzureCredential
async function getMIToken(clientId, scope) {
  return clientId ? getUamiToken(clientId, scope) : getManagedIdentityToken(scope);
}

async function getAccessTokenForMI(clientId) {
  return getMIToken(clientId, 'https://analysis.windows.net/powerbi/api/.default');
}

async function getFabricTokenForMI(clientId) {
  return getMIToken(clientId, 'https://api.fabric.microsoft.com/.default');
}

async function getAzureManagementTokenForMI(clientId) {
  return getMIToken(clientId, 'https://management.azure.com/.default');
}

async function getGraphTokenForMI(clientId) {
  return getMIToken(clientId, 'https://graph.microsoft.com/.default');
}

async function getOneLakeTokenForMI(clientId) {
  return getMIToken(clientId, 'https://storage.azure.com/.default');
}

function getConfidentialClient(spConfig) {
  if (!spConfig || !spConfig.client_id || !spConfig.client_secret || !spConfig.tenant_id) {
    throw new Error('Service principal is not configured. Go to Settings to add one.');
  }

  const hash = getConfigHash({ clientId: spConfig.client_id, clientSecret: spConfig.client_secret, tenantId: spConfig.tenant_id });

  if (appCache.has(hash)) {
    return appCache.get(hash);
  }

  const msalConfig = {
    auth: {
      clientId: spConfig.client_id,
      clientSecret: spConfig.client_secret,
      authority: `https://login.microsoftonline.com/${spConfig.tenant_id}`,
    },
  };

  const app = new msal.ConfidentialClientApplication(msalConfig);
  appCache.set(hash, app);
  return app;
}

async function getAccessTokenForSP(spConfig) {
  const app = getConfidentialClient(spConfig);

  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://analysis.windows.net/powerbi/api/.default'],
  });

  if (!result || !result.accessToken) {
    throw new Error('Failed to acquire Power BI access token');
  }

  return result.accessToken;
}

// Fabric Core API requires its own scope for write operations (e.g. assignToCapacity)
async function getFabricTokenForSP(spConfig) {
  const app = getConfidentialClient(spConfig);

  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://api.fabric.microsoft.com/.default'],
  });

  if (!result || !result.accessToken) {
    throw new Error('Failed to acquire Fabric API access token');
  }

  return result.accessToken;
}

function resetAuthCache() {
  appCache.clear();
}

// ── Delegated (user-based) auth for migration ──
// Uses the Entra ID app registration configured via environment variables

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
    auth: {
      clientId,
      clientSecret,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
  });
  return delegatedMsalApp;
}

function getDelegatedAuthUrl(redirectUri, state) {
  const app = getDelegatedClient();
  return app.getAuthCodeUrl({
    scopes: ['https://analysis.windows.net/powerbi/api/Tenant.ReadWrite.All'],
    redirectUri,
    state,
    prompt: 'consent',
  });
}

async function acquireDelegatedToken(code, redirectUri) {
  const app = getDelegatedClient();
  const result = await app.acquireTokenByCode({
    code,
    scopes: ['https://analysis.windows.net/powerbi/api/Tenant.ReadWrite.All'],
    redirectUri,
  });
  if (!result || !result.accessToken) {
    throw new Error('Failed to acquire delegated Power BI token');
  }
  return result.accessToken;
}

// ── Microsoft Graph API token (for user/SP search) ──
async function getGraphTokenForSP(spConfig) {
  const app = getConfidentialClient(spConfig);
  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });
  if (!result || !result.accessToken) {
    throw new Error('Failed to acquire Microsoft Graph access token');
  }
  return result.accessToken;
}

// ── OneLake / Azure Storage token (for item size via ADLS Gen2 API) ──
async function getOneLakeTokenForSP(spConfig) {
  const app = getConfidentialClient(spConfig);
  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://storage.azure.com/.default'],
  });
  if (!result || !result.accessToken) {
    throw new Error('Failed to acquire OneLake storage access token');
  }
  return result.accessToken;
}

// ── Azure Management API token (for capacity pause/resume) ──
async function getAzureManagementTokenForSP(spConfig) {
  const app = getConfidentialClient(spConfig);
  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://management.azure.com/.default'],
  });
  if (!result || !result.accessToken) {
    throw new Error('Failed to acquire Azure Management access token');
  }
  return result.accessToken;
}

module.exports = {
  getAccessTokenForSP, getFabricTokenForSP, getAzureManagementTokenForSP, getGraphTokenForSP, getOneLakeTokenForSP, resetAuthCache,
  getDelegatedAuthUrl, acquireDelegatedToken,
  getAccessTokenForMI, getFabricTokenForMI, getAzureManagementTokenForMI, getGraphTokenForMI, getOneLakeTokenForMI,
};
