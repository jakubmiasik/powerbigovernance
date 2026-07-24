const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const { getManagedIdentityService } = require('../services/powerbiService');

// Helper to get a PBI service instance using Managed Identity
function getPbiService() {
  return getManagedIdentityService();
}

// ── Capacities list page ──
router.get('/', async (req, res) => {
  try {
    const pbi = getPbiService();
    const capacities = await pbi.getCapacities();
    res.render('capacities/list', {
      title: 'Capacities',
      user: req.user,
      capacities,
      breadcrumb: [{ label: 'Capacities', href: '/capacities' }],
    });
  } catch (err) {
    res.render('capacities/list', {
      title: 'Capacities',
      user: req.user,
      capacities: [],
      breadcrumb: [{ label: 'Capacities', href: '/capacities' }],
      error: err.message,
    });
  }
});

// ── Refresh capacities (AJAX) ──
router.get('/refresh', async (req, res) => {
  try {
    const pbi = getPbiService();
    const capacities = await pbi.getCapacities();
    res.json({ success: true, capacities });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Capacity detail page ──
router.get('/:id', async (req, res) => {
  try {
    const pbi = getPbiService();
    const capacities = await pbi.getCapacities();
    const capacity = capacities.find(c => (c.id || '').toLowerCase() === req.params.id.toLowerCase());
    if (!capacity) {
      return res.render('error', { title: 'Error', user: req.user, message: 'Capacity not found.' });
    }

    // Try to get ARM details if subscription info is configured
    let armDetail = null;
    const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
    if (subscriptionId) {
      try {
        const armCaps = await pbi.listArmCapacities(subscriptionId);
        armDetail = armCaps.find(c =>
          (c.name || '').toLowerCase() === (capacity.displayName || '').toLowerCase() ||
          (c.properties?.administrationMembers || []).length > 0
        );
        // Better match: find by capacity ID from ARM properties
        if (!armDetail) {
          armDetail = armCaps.find(c =>
            c.id && c.id.toLowerCase().includes(req.params.id.toLowerCase())
          );
        }
        // Match by display name
        if (!armDetail) {
          armDetail = armCaps.find(c =>
            (c.name || '').toLowerCase() === (capacity.displayName || '').toLowerCase()
          );
        }
      } catch (armErr) {
        armDetail = { error: armErr.message };
      }
    }

    // Get schedules for this capacity
    const allSchedules = await db.getCapacitySchedules();
    const schedules = allSchedules.filter(s =>
      (s.capacity_name || '').toLowerCase() === (capacity.displayName || '').toLowerCase()
    );

    // Get execution history
    const history = await db.getScheduleHistory(capacity.displayName || '', 5);

    res.render('capacities/detail', {
      title: 'Capacity: ' + (capacity.displayName || 'Unknown'),
      user: req.user,
      capacity,
      armDetail,
      schedules,
      history,
      subscriptionId: subscriptionId || '',
      breadcrumb: [{ label: 'Capacities', href: '/capacities' }, { label: capacity.displayName || 'Detail', href: '#' }],
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

// ── Pause capacity ──
router.post('/:name/suspend', async (req, res) => {
  try {
    const { subscriptionId, resourceGroup } = req.body;
    if (!subscriptionId || !resourceGroup) {
      return res.json({ success: false, message: 'Subscription ID and Resource Group are required.' });
    }
    const pbi = getPbiService();

    // Check current state before executing
    try {
      const detail = await pbi.getArmCapacityDetail(subscriptionId, resourceGroup, req.params.name);
      const state = (detail.properties && detail.properties.state) || '';
      const provisioning = (detail.properties && detail.properties.provisioningState) || '';
      if (state === 'Paused' || state === 'Suspended') {
        return res.json({ success: false, message: 'Capacity is already paused.' });
      }
      if (provisioning && provisioning !== 'Succeeded') {
        return res.json({ success: false, message: `Capacity is in transitional state (${provisioning}). Please wait and try again.` });
      }
    } catch (stateErr) {
      // Continue anyway if state check fails
      console.warn('[Capacities] State check failed:', stateErr.message);
    }

    await pbi.suspendCapacity(subscriptionId, resourceGroup, req.params.name);
    res.json({ success: true, message: 'Capacity suspend initiated.' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Resume capacity ──
router.post('/:name/resume', async (req, res) => {
  try {
    const { subscriptionId, resourceGroup } = req.body;
    if (!subscriptionId || !resourceGroup) {
      return res.json({ success: false, message: 'Subscription ID and Resource Group are required.' });
    }
    const pbi = getPbiService();

    // Check current state before executing
    try {
      const detail = await pbi.getArmCapacityDetail(subscriptionId, resourceGroup, req.params.name);
      const state = (detail.properties && detail.properties.state) || '';
      const provisioning = (detail.properties && detail.properties.provisioningState) || '';
      if (state === 'Active') {
        return res.json({ success: false, message: 'Capacity is already active.' });
      }
      if (provisioning && provisioning !== 'Succeeded') {
        return res.json({ success: false, message: `Capacity is in transitional state (${provisioning}). Please wait and try again.` });
      }
    } catch (stateErr) {
      // Continue anyway if state check fails
      console.warn('[Capacities] State check failed:', stateErr.message);
    }

    await pbi.resumeCapacity(subscriptionId, resourceGroup, req.params.name);
    res.json({ success: true, message: 'Capacity resume initiated.' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Add schedule ──
router.post('/:name/schedule', async (req, res) => {
  try {
    const { subscriptionId, resourceGroup, action, scheduleType, hour, minute, day, timezone } = req.body;
    if (!subscriptionId || !resourceGroup || !action || !scheduleType) {
      return res.json({ success: false, message: 'All fields are required.' });
    }
    await db.saveCapacitySchedule({
      capacityName: req.params.name,
      subscriptionId,
      resourceGroup,
      action,
      scheduleType,
      hour: hour != null ? parseInt(hour) : null,
      minute: minute != null ? parseInt(minute) : null,
      day: day || null,
      timezone: timezone || 'UTC',
      enabled: true,
    });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Delete schedule ──
router.delete('/schedule/:id', async (req, res) => {
  try {
    await db.deleteCapacitySchedule(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Update schedule ──
router.put('/schedule/:id', async (req, res) => {
  try {
    const { action, scheduleType, hour, minute, day, timezone } = req.body;
    await db.updateCapacitySchedule(parseInt(req.params.id), {
      action,
      scheduleType,
      hour: hour != null ? parseInt(hour) : undefined,
      minute: minute != null ? parseInt(minute) : undefined,
      day: day || undefined,
      timezone: timezone || undefined,
    });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Toggle schedule ──
router.post('/schedule/:id/toggle', async (req, res) => {
  try {
    await db.toggleCapacitySchedule(parseInt(req.params.id), req.body.enabled);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Schedule history ──
router.get('/history/:capacityName', async (req, res) => {
  try {
    const history = await db.getScheduleHistory(req.params.capacityName, 5);
    res.json({ success: true, history });
  } catch (err) {
    res.json({ success: false, message: err.message, history: [] });
  }
});

module.exports = router;

