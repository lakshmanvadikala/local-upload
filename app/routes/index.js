const router = require("express").Router();
const core = require('../core');

router.get('/', async (req, res) => {
  let accounts = await core.accounts();
  
  if (accounts.length > 0) {
    return res.redirect('/settings');
  }
  
  res.redirect('/login');
});

router.use('/', require('./settings'));

module.exports = router;