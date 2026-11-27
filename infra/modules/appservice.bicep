@description('Location for all resources')
param location string

@description('Tags for all resources')
param tags object

@description('Unique suffix for resource names')
param resourceSuffix string

@description('Application Insights connection string')
param appInsightsConnectionString string

@description('Key used to encrypt service principal secrets stored in the database')
@secure()
param secretEncryptionKey string = uniqueString(subscription().id, resourceGroup().id, 'pbi-gov-secret-encryption')

@description('Run scans in a separate worker app, so a web restart or deployment does not stop them')
param deployScanWorker bool = false

@description('Azure SQL server host name, e.g. myserver.database.windows.net (also settable in the portal)')
param sqlServer string = ''

@description('Azure SQL database name')
param sqlDatabase string = ''

// The Governance Outcome reads with its own identity, which the database grants
// SELECT on five tables only (scripts/setup-sql-identities.js, run after provisioning).
resource governanceReader 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-pbi-gov-reader-${resourceSuffix}'
  location: location
  tags: tags
}

var sharedSettings = concat([
  {
    name: 'NODE_ENV'
    value: 'production'
  }
  {
    name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
    value: appInsightsConnectionString
  }
  {
    name: 'ApplicationInsightsAgent_EXTENSION_VERSION'
    value: '~3'
  }
  {
    name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
    value: 'true'
  }
  {
    name: 'SECRET_ENCRYPTION_KEY'
    value: secretEncryptionKey
  }
  {
    name: 'ANALYSIS_WORKER_MODE'
    value: deployScanWorker ? 'external' : 'inline'
  }
], empty(sqlServer) ? [] : [
  {
    name: 'SQL_SERVER'
    value: sqlServer
  }
  {
    name: 'SQL_DATABASE'
    value: sqlDatabase
  }
])

resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'asp-pbi-gov-${resourceSuffix}'
  location: location
  tags: tags
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
  properties: {
    reserved: true // Linux
  }
}

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: 'app-pbi-gov-${resourceSuffix}'
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  identity: {
    // System-assigned for the application's own database access; the reader
    // identity only for the Governance Outcome's read-only queries.
    type: 'SystemAssigned, UserAssigned'
    userAssignedIdentities: {
      '${governanceReader.id}': {}
    }
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      healthCheckPath: '/health'
      appCommandLine: 'npm start'
      // Required: the capacity pause/resume scheduler runs in-process. Without
      // Always On the worker is unloaded when idle and the timer never fires.
      alwaysOn: true
      appSettings: concat(sharedSettings, [
        {
          name: 'GOVERNANCE_SQL_CLIENT_ID'
          value: governanceReader.properties.clientId
        }
      ])
    }
  }
}

// The scan worker: same code, started with `npm run worker`. It answers /health
// on the port App Service gives it and runs queued scans one at a time.
resource scanWorker 'Microsoft.Web/sites@2023-12-01' = if (deployScanWorker) {
  name: 'app-pbi-gov-worker-${resourceSuffix}'
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      healthCheckPath: '/health'
      appCommandLine: 'npm run worker'
      alwaysOn: true
      appSettings: sharedSettings
    }
  }
}

output webAppUrl string = 'https://${webApp.properties.defaultHostName}'
output webAppName string = webApp.name
output governanceReaderIdentityName string = governanceReader.name
output scanWorkerName string = deployScanWorker ? scanWorker.name : ''
