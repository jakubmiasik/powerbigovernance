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
    type: 'SystemAssigned'
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
      appSettings: [
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
      ]
    }
  }
}

output webAppUrl string = 'https://${webApp.properties.defaultHostName}'
output webAppName string = webApp.name
