const { createPowerBIService } = require('./powerbiService');

function getCapacityState(detail) {
  return {
    state: (detail && detail.properties && detail.properties.state) || '',
    provisioningState: (detail && detail.properties && detail.properties.provisioningState) || '',
  };
}

async function executeCapacityActionWithService(pbi, { subscriptionId, resourceGroup, capacityName, action }) {
  if (!subscriptionId || !resourceGroup || !capacityName || !action) {
    throw new Error('Subscription ID, Resource Group, capacity name, and action are required.');
  }

  try {
    const detail = await pbi.getArmCapacityDetail(subscriptionId, resourceGroup, capacityName);
    const { state, provisioningState } = getCapacityState(detail);
    if (action === 'suspend' && (state === 'Paused' || state === 'Suspended')) {
      return { status: 'skipped', message: 'Capacity is already paused.' };
    }
    if (action === 'resume' && state === 'Active') {
      return { status: 'skipped', message: 'Capacity is already active.' };
    }
    if (provisioningState && provisioningState !== 'Succeeded') {
      return { status: 'skipped', message: `Capacity is in transitional state (${provisioningState}). Please wait and try again.` };
    }
  } catch (stateErr) {
    console.warn('[CapacityAction] State check failed:', stateErr.message);
  }

  if (action === 'suspend') {
    await pbi.suspendCapacity(subscriptionId, resourceGroup, capacityName);
    return { status: 'success', message: 'Capacity suspend initiated.' };
  }
  if (action === 'resume') {
    await pbi.resumeCapacity(subscriptionId, resourceGroup, capacityName);
    return { status: 'success', message: 'Capacity resume initiated.' };
  }
  throw new Error(`Unsupported capacity action "${action}"`);
}

async function executeCapacityActionWithSp(sp, options) {
  const pbi = createPowerBIService(sp);
  return executeCapacityActionWithService(pbi, options);
}

module.exports = {
  executeCapacityActionWithService,
  executeCapacityActionWithSp,
};
