/**
 * The audit log: every change made through this application, newest first.
 * Under /settings, so administrators only. Read-only — nothing here edits or
 * deletes a row.
 */

const express = require('express');
const audit = require('../services/auditLogService');

function readFilters(query) {
  const pick = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const filters = {
    actor: pick(query.actor),
    category: audit.CATEGORIES.includes(query.category) ? query.category : null,
    outcome: ['succeeded', 'failed'].includes(query.outcome) ? query.outcome : null,
    from: /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : null,
    to: null,
  };
  if (/^\d{4}-\d{2}-\d{2}$/.test(query.to || '')) {
    // "To" is inclusive of the day the reader picked.
    const end = new Date(query.to + 'T00:00:00Z');
    end.setUTCDate(end.getUTCDate() + 1);
    filters.to = end.toISOString();
  }
  return filters;
}

function createRouter({ service = audit } = {}) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const filters = readFilters(req.query || {});
    let rows = [];
    let error = null;
    try {
      rows = await service.list(filters, 500);
    } catch (err) {
      error = err.message;
    }
    res.render('settings/audit', {
      title: 'Audit Log', user: req.user, hideRunSelector: true,
      rows, filters, query: req.query || {}, categories: audit.CATEGORIES, error,
    });
  });

  router.get('/export.csv', async (req, res) => {
    try {
      const rows = await service.list(readFilters(req.query || {}), 5000);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="audit-log-' + new Date().toISOString().slice(0, 10) + '.csv"');
      res.send(audit.toCsv(rows));
    } catch (err) {
      res.status(500).send('Could not read the audit log: ' + err.message);
    }
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
module.exports.readFilters = readFilters;
