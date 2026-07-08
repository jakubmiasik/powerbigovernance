const express = require('express');
const router = express.Router();
const { isPowerBIConfigured } = require('../config/settings');

router.get('/', (req, res) => {
  res.render('index', {
    title: 'Power BI Governance',
    user: req.user,
    isPowerBIConfigured: isPowerBIConfigured(),
  });
});

module.exports = router;
