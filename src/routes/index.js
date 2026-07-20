const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  if (!req.user) {
    return res.render('landing', { title: 'Power BI Governance' });
  }
  res.render('home', { title: 'Home', user: req.user, breadcrumb: [{ label: 'Home', href: '/' }] });
});

module.exports = router;
