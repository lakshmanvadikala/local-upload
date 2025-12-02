const path = require('path');
const router = require("express").Router();
const core = require('../core');
const gbs = require('../../config/globals');

// Login page
router.get('/login', (req, res) => {
  res.render('login', { error: null });
});

// Handle login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    let accounts = await core.accounts();
    let account;
    
    if (accounts.length === 0) {
      const Account = require('../core/account');
      account = new Account();
      await account.login(email, password);
      core.addAccount(account);
    } else {
      account = accounts[0];
      await account.login(email, password);
    }
    
    res.redirect('/settings');
  } catch (error) {
    console.error("Login error:", error);
    res.render('login', { error: error.message });
  }
});

// Select folder endpoint
router.post('/select-folder', async (req, res) => {
  try {
    const { folder } = req.body;
    
    if (!folder) {
      return res.status(400).json({ error: 'No folder selected' });
    }
    
    const fs = require('fs-extra');
    if (!await fs.exists(folder)) {
      return res.status(400).json({ error: 'Folder does not exist' });
    }
    
    const accounts = await core.accounts();
    if (accounts.length === 0) {
      return res.status(400).json({ error: 'No account found. Please login first.' });
    }
    
    const account = accounts[0];
    account.folder = folder;
    await account.save();
    
    res.json({ success: true, folder });
  } catch (error) {
    console.error("Folder selection error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Settings page
router.get('/settings', async (req, res) => {
  let accounts = await core.accounts();
  
  if (accounts.length === 0) {
    return res.redirect('/login');
  }

  const account = accounts[0];
  const fs = require('fs-extra');
  const hasFolder = account.folder && await fs.exists(account.folder);
  
  res.render('settings', {
    accounts,
    hasFolder,
    email: account.email,
    syncedFilesCount: Object.keys(account.syncedFiles || {}).length,
    folder: account.folder || 'No folder selected'
  });
});

// Start sync endpoint
router.post('/start-sync', async (req, res) => {
  try {
    const accounts = await core.accounts();
    if (accounts.length === 0) {
      return res.status(400).json({ error: 'No account found' });
    }
    
    const account = accounts[0];
    
    if (!account.folder) {
      return res.status(400).json({ error: 'Please select a folder first' });
    }
    
    const fs = require('fs-extra');
    if (!await fs.exists(account.folder)) {
      return res.status(400).json({ error: 'Selected folder does not exist' });
    }
    
    if (!account.sync) {
      const Sync = require('../core/sync');
      account.sync = new Sync(account);
    }
    
    account.sync.start((progress) => {
      if (gbs.win && gbs.win.webContents) {
        gbs.win.webContents.send('sync-progress', progress);
      }
    }).then(result => {
      if (gbs.win && gbs.win.webContents) {
        gbs.win.webContents.send('sync-complete', result);
      }
    }).catch(error => {
      if (gbs.win && gbs.win.webContents) {
        gbs.win.webContents.send('sync-error', error.message);
      }
    });
    
    res.json({ success: true, message: 'Sync started' });
  } catch (error) {
    console.error("Sync error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Check for new files endpoint (for auto-sync)
router.post('/check-new-files', async (req, res) => {
  try {
    const accounts = await core.accounts();
    if (accounts.length === 0) {
      return res.json({ hasNewFiles: false });
    }
    
    const account = accounts[0];
    
    if (!account.folder || !await require('fs-extra').exists(account.folder)) {
      return res.json({ hasNewFiles: false });
    }
    
    if (!account.sync) {
      return res.json({ hasNewFiles: false });
    }
    
    const allFiles = await account.sync.scanFolder(account.folder);
    const newFilesCount = allFiles.filter(file => !account.isFileSynced(file)).length;
    
    if (newFilesCount > 0 && !account.sync.syncing) {
      account.sync.startAutoSync(allFiles.filter(file => !account.isFileSynced(file)))
        .then(result => {
          if (gbs.win && gbs.win.webContents) {
            gbs.win.webContents.send('auto-sync-complete', result);
          }
        })
        .catch(error => {
          console.error("Auto-sync error:", error);
        });
      
      return res.json({ hasNewFiles: true, count: newFilesCount });
    }
    
    res.json({ hasNewFiles: false });
  } catch (error) {
    console.error("Check new files error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get sync status
router.get('/sync-status', async (req, res) => {
  const accounts = await core.accounts();
  if (accounts.length === 0) {
    return res.json({ syncing: false, hasAccount: false });
  }
  
  const account = accounts[0];
  const syncing = account.sync ? account.sync.syncing : false;
  const progress = account.sync ? account.sync.currentSyncProgress : null;
  const hasFolder = !!account.folder && await require('fs-extra').exists(account.folder);
  
  res.json({
    syncing,
    progress,
    hasFolder,
    syncedFilesCount: Object.keys(account.syncedFiles || {}).length
  });
});

// Logout
router.get('/logout', async (req, res) => {
  const accounts = await core.accounts();
  if (accounts.length > 0) {
    await core.removeAccount(accounts[0]);
  }
  res.redirect('/login');
});

module.exports = router;