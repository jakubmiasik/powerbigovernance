/**
 * Governance Configuration: the rules the estate is judged against.
 *
 * Its own page rather than another card on Settings. Settings is about *reaching*
 * the tenant — which service principal, whose secret, which vault — and a
 * convention that decides whether a lakehouse is named acceptably is a different
 * question with a different audience. It is also the natural home for the rules
 * that follow: the triage thresholds are configured per-page today, and there is
 * nowhere obvious to put the next one.
 */

const express = require('express');
const router = express.Router();
const naming = require('../services/namingConventionService');
const { loadNamingConvention, saveNamingConvention } = require('../services/namingConventionStore');

function namingLocals(convention) {
  return {
    naming: convention,
    segmentDefs: naming.SEGMENT_DEFS,
    letterCases: naming.LETTER_CASES,
    namingPattern: naming.describeConvention(convention),
    namingExample: naming.exampleName(convention),
  };
}

router.get('/', async (req, res) => {
  try {
    const convention = await loadNamingConvention();
    res.render('governance-config/index', {
      title: 'Governance Configuration',
      user: req.user,
      // This page has nothing to do with a scan, so the run selector would be a
      // control that does not affect anything on it.
      hideRunSelector: true,
      ...namingLocals(convention),
      success: req.flash('success'),
      error: req.flash('error'),
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

/**
 * Saves the naming convention.
 *
 * A convention that cannot be satisfied — no required part, an artifact naming an
 * experience that does not exist — is refused rather than stored, because the
 * result would be a tenant-wide finding nobody can clear.
 */
router.post('/naming', async (req, res) => {
  try {
    const restoring = req.body.restoreDefaults === 'true';
    const convention = restoring
      // Restoring keeps whether it is enforced: someone fixing a convention they
      // broke should not also have to remember to switch it back on.
      ? naming.normalizeConvention({ ...naming.DEFAULT_CONVENTION, enabled: (await loadNamingConvention()).enabled })
      : naming.conventionFromForm(req.body);

    const problems = naming.validateConvention(convention);
    if (problems.length) {
      req.flash('error', 'The naming convention was not saved: ' + problems.join(' '));
      return res.redirect('/settings/governance');
    }

    await saveNamingConvention(convention, req.user ? (req.user.name || req.user.email) : null);
    req.flash('success', restoring
      ? 'Naming convention restored to the defaults.'
      : 'Naming convention saved. Artifacts are checked as ' + naming.describeConvention(convention) + '.');
  } catch (err) {
    req.flash('error', 'Could not save the naming convention: ' + err.message);
  }
  res.redirect('/settings/governance');
});

module.exports = router;
