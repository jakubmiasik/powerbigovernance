const msal = require('@azure/msal-node');

// Cache MSAL apps by config hash to support multiple SPs
const appCache = new Map();

function getConfigHash(cfg) {
  return `${cfg.clientId}|${cfg.clientSecret}|${cfg.tenantId}`;
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

function resetAuthCache() {
  appCache.clear();
}

module.exports = { getAccessTokenForSP, resetAuthCache };
