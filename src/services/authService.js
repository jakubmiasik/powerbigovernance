const msal = require('@azure/msal-node');
const { getConfig } = require('../config/settings');

let cachedApp = null;
let cachedConfigHash = '';

function getConfigHash(cfg) {
  return `${cfg.clientId}|${cfg.clientSecret}|${cfg.tenantId}`;
}

function getConfidentialClient() {
  const config = getConfig();
  const pbiConfig = config.powerbi;
  const hash = getConfigHash(pbiConfig);

  if (cachedApp && cachedConfigHash === hash) {
    return cachedApp;
  }

  if (!pbiConfig.clientId || !pbiConfig.clientSecret || !pbiConfig.tenantId) {
    throw new Error('Power BI service principal is not configured. Go to Settings to configure it.');
  }

  const msalConfig = {
    auth: {
      clientId: pbiConfig.clientId,
      clientSecret: pbiConfig.clientSecret,
      authority: `https://login.microsoftonline.com/${pbiConfig.tenantId}`,
    },
  };

  cachedApp = new msal.ConfidentialClientApplication(msalConfig);
  cachedConfigHash = hash;
  return cachedApp;
}

async function getAccessToken() {
  const app = getConfidentialClient();

  const result = await app.acquireTokenByClientCredential({
    scopes: ['https://analysis.windows.net/powerbi/api/.default'],
  });

  if (!result || !result.accessToken) {
    throw new Error('Failed to acquire Power BI access token');
  }

  return result.accessToken;
}

// Invalidate cache when config changes
function resetAuthCache() {
  cachedApp = null;
  cachedConfigHash = '';
}

module.exports = { getAccessToken, resetAuthCache };
