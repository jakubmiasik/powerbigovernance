const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', '..', 'config.local.json');

function loadFileConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading config file:', err.message);
  }
  return {};
}

function saveFileConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

function getConfig() {
  const fileConfig = loadFileConfig();

  return {
    // Entra ID web app (user sign-in)
    entra: {
      clientId: fileConfig.entraClientId || process.env.ENTRA_CLIENT_ID || '',
      clientSecret: fileConfig.entraClientSecret || process.env.ENTRA_CLIENT_SECRET || '',
      tenantId: fileConfig.entraTenantId || process.env.ENTRA_TENANT_ID || '',
    },
    // Power BI service principal
    powerbi: {
      clientId: fileConfig.powerbiClientId || process.env.POWERBI_CLIENT_ID || '',
      clientSecret: fileConfig.powerbiClientSecret || process.env.POWERBI_CLIENT_SECRET || '',
      tenantId: fileConfig.powerbiTenantId || process.env.POWERBI_TENANT_ID || '',
    },
    session: {
      secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    },
    port: parseInt(process.env.PORT || '3000', 10),
  };
}

function updatePowerBIConfig(config) {
  const fileConfig = loadFileConfig();
  fileConfig.powerbiClientId = config.clientId;
  fileConfig.powerbiClientSecret = config.clientSecret;
  fileConfig.powerbiTenantId = config.tenantId;
  saveFileConfig(fileConfig);
}

function updateEntraConfig(config) {
  const fileConfig = loadFileConfig();
  fileConfig.entraClientId = config.clientId;
  fileConfig.entraClientSecret = config.clientSecret;
  fileConfig.entraTenantId = config.tenantId;
  saveFileConfig(fileConfig);
}

function isEntraConfigured() {
  const cfg = getConfig();
  return !!(cfg.entra.clientId && cfg.entra.clientSecret && cfg.entra.tenantId);
}

function isPowerBIConfigured() {
  const cfg = getConfig();
  return !!(cfg.powerbi.clientId && cfg.powerbi.clientSecret && cfg.powerbi.tenantId);
}

module.exports = {
  getConfig,
  updatePowerBIConfig,
  updateEntraConfig,
  isEntraConfigured,
  isPowerBIConfigured,
};
