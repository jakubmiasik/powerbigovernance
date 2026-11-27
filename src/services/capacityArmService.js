/**
 * Where each capacity lives in Azure, as far as the service principal can see.
 *
 * Pausing and resuming go through Azure Resource Manager, which needs the
 * subscription and resource group of the capacity. Typing them by hand is how a
 * pause lands on the wrong resource, so they are read from Azure whenever the
 * principal can see the capacity there, and the page says plainly when it cannot.
 *
 * Only Fabric F SKUs are Azure resources that can be paused. Premium P and EM
 * capacities, Premium Per User and Fabric trials are not, and are reported as
 * such rather than as a missing permission.
 */

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

function isAzurePausable(capacity) {
  const sku = String((capacity && capacity.sku) || '').toUpperCase();
  return /^F\d+$/.test(sku);
}

/** Subscription and resource group, read from an ARM resource id. */
function armLocation(armResource) {
  const parts = String((armResource && armResource.id) || '').split('/');
  const lower = parts.map(part => part.toLowerCase());
  const sub = lower.indexOf('subscriptions');
  const rg = lower.indexOf('resourcegroups');
  return {
    subscriptionId: sub >= 0 ? parts[sub + 1] || null : null,
    resourceGroup: rg >= 0 ? parts[rg + 1] || null : null,
  };
}

/**
 * The ARM resource for a capacity. A Fabric capacity's resource name is the name
 * the Fabric API shows, so it is matched on that and nothing looser: a pause on
 * the wrong capacity is worse than no match.
 */
function matchArmCapacity(capacity, armCapacities) {
  const name = String((capacity && capacity.displayName) || '').trim().toLowerCase();
  if (!name) return null;
  return (armCapacities || []).find(arm => String(arm.name || '').trim().toLowerCase() === name) || null;
}

/**
 * Every Fabric capacity the principal can read, across the configured
 * subscription and every subscription it can list.
 *
 * Returns { capacities, error } — error is set when nothing at all could be read,
 * which is what "no Azure access" looks like.
 */
async function listVisibleArmCapacities(pbi, { configuredSubscriptionId, cacheKey, now = Date.now } = {}) {
  const key = cacheKey || null;
  if (key && cache.has(key) && cache.get(key).expiresAt > now()) return cache.get(key).value;

  const subscriptions = new Set();
  if (configuredSubscriptionId) subscriptions.add(String(configuredSubscriptionId));
  let listError = null;
  if (typeof pbi.listSubscriptions === 'function') {
    try {
      for (const sub of await pbi.listSubscriptions()) {
        if (sub && sub.subscriptionId) subscriptions.add(String(sub.subscriptionId));
      }
    } catch (err) {
      listError = err.message;
    }
  }

  const capacities = [];
  const errors = [];
  for (const subscriptionId of subscriptions) {
    try {
      capacities.push(...await pbi.listArmCapacities(subscriptionId));
    } catch (err) {
      errors.push(err.message);
    }
  }

  const value = {
    capacities,
    error: capacities.length ? null
      : errors[0] || listError || (subscriptions.size ? null : 'The service principal cannot see any Azure subscription.'),
  };
  if (key) cache.set(key, { value, expiresAt: now() + CACHE_TTL_MS });
  return value;
}

/**
 * What the page says about one capacity's Azure side.
 *   status: 'reachable' | 'no-access' | 'not-azure'
 */
function describeArmAccess(capacity, armCapacities) {
  if (!isAzurePausable(capacity)) {
    return { status: 'not-azure', arm: null, subscriptionId: null, resourceGroup: null };
  }
  const arm = matchArmCapacity(capacity, armCapacities);
  if (!arm) return { status: 'no-access', arm: null, subscriptionId: null, resourceGroup: null };
  return { status: 'reachable', arm, ...armLocation(arm) };
}

function clearCache() { cache.clear(); }

module.exports = {
  isAzurePausable, armLocation, matchArmCapacity, listVisibleArmCapacities, describeArmAccess, clearCache,
};
