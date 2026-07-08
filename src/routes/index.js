const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  if (!req.user) {
    return res.render('landing', { title: 'Power BI Governance' });
  }
  res.redirect('/governance');
});

module.exports = router;
