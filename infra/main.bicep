targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the environment (used for resource naming)')
param environmentName string

@minLength(1)
@description('Primary location for all resources')
param location string

@description('Run scans in a separate worker app (recommended for tenants whose scans take long)')
param deployScanWorker bool = false

@description('Azure SQL server host name, e.g. myserver.database.windows.net')
param sqlServer string = ''

@description('Azure SQL database name')
param sqlDatabase string = ''

var tags = { 'azd-env-name': environmentName }
var resourceSuffix = take(uniqueString(subscription().id, environmentName, location), 6)

resource rg 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

module monitoring './modules/monitoring.bicep' = {
  name: 'monitoring'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceSuffix: resourceSuffix
  }
}

module appservice './modules/appservice.bicep' = {
  name: 'appservice'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceSuffix: resourceSuffix
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    deployScanWorker: deployScanWorker
    sqlServer: sqlServer
    sqlDatabase: sqlDatabase
  }
}

output AZURE_RESOURCE_GROUP string = rg.name
output WEB_URL string = appservice.outputs.webAppUrl
output AZURE_LOG_ANALYTICS_WORKSPACE_ID string = monitoring.outputs.logAnalyticsWorkspaceId
output GOVERNANCE_READER_IDENTITY_NAME string = appservice.outputs.governanceReaderIdentityName
output SCAN_WORKER_NAME string = appservice.outputs.scanWorkerName
output SQL_SERVER string = sqlServer
output SQL_DATABASE string = sqlDatabase
