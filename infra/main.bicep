targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the environment (used for resource naming)')
param environmentName string

@minLength(1)
@description('Primary location for all resources')
param location string

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
  }
}

output AZURE_RESOURCE_GROUP string = rg.name
output WEB_URL string = appservice.outputs.webAppUrl
output AZURE_LOG_ANALYTICS_WORKSPACE_ID string = monitoring.outputs.logAnalyticsWorkspaceId
