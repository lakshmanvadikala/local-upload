const {app, BrowserWindow, Tray, Menu, ipcMain} = require('electron');
const url = require('url');
const path = require("path");
const fs = require('fs-extra');

const gbs = require('./config/globals');
const core = require('./app/core');
const backend = require('./app/backend');
const AutoLaunch = require('auto-launch');

const autolauncher = new AutoLaunch({name: "EngazeWell Drive"});

const logo = path.join(__dirname, 'public', 'images', 'logo.png');
const logoGrey = path.join(__dirname, 'public', 'images', 'logo-grey.png');
const logoSync = path.join(__dirname, 'public', 'images', 'logo-sync.png');

function createWindow () {
  gbs.win = new BrowserWindow({
    width: 600,
    height: 700,
    icon: logo,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    resizable: true,
    show: false
  });

  gbs.win.loadURL(url.format({
    pathname: "odrive.io/",
    protocol: 'http:',
    slashes: true
  }));

  gbs.win.once('ready-to-show', () => {
    gbs.win.show();
  });

  gbs.win.on('closed', () => {
    gbs.win = null;
  });
}

function generateTrayMenu() {
  if (!gbs.tray) return;

  gbs.trayMenu = Menu.buildFromTemplate([
    {
      label: 'Open Settings',
      click () {
        if (gbs.win === null) {
          createWindow();
        } else {
          gbs.win.show();
        }
      }
    },
    {
      label: 'Launch on startup',
      type: 'checkbox',
      checked: gbs.autorun,
      click() {
        if (gbs.autorun) {
          autolauncher.disable().then(() => gbs.autorun = false);
        } else {
          autolauncher.enable().then(() => gbs.autorun = true);
        }
      }
    },
    {type: 'separator'},
    {
      label: 'Quit',
      click () { app.quit(); }
    }
  ]);
  
  gbs.tray.setContextMenu(gbs.trayMenu);
}

function generateTray() {
  gbs.tray = new Tray(logo);
  generateTrayMenu();
}

function updateTrayIcon() {
  const accounts = core.accounts();
  const isSyncing = accounts.length > 0 && accounts[0].syncing;
  const path = isSyncing ? logoSync : logo;
  gbs.tray.setImage(path);
}

async function launch() {
  autolauncher.isEnabled().then(enabled => {
    gbs.autorun = enabled;
  }).catch(err => {
    console.error("Auto-launch error:", err);
  });

  generateTray();
  await backend.launch();

  const accounts = await core.accounts();
  
  if (accounts.length === 0) {
    createWindow();
  } else {
    createWindow();
  }

  core.on("notification", (text) => {
    if (gbs.tray) {
      gbs.tray.displayBalloon({
        title: "EngazeWell Drive",
        content: text
      });
    }
  });

  gbs.on("syncing", updateTrayIcon);
}

ipcMain.handle('select-folder', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });
  
  if (!result.canceled) {
    return result.filePaths[0];
  }
  return null;
});

app.on('browser-window-focus', () => {
  if (gbs.win) {
    gbs.win.webContents.send('window-focused');
  }
});

app.commandLine.appendSwitch('host-rules', `MAP odrive.io 127.0.0.1:${backend.port}`);

app.on('ready', launch);

app.on('window-all-closed', () => {
  // Keep app running in tray
});

app.on('activate', () => {
  if (gbs.win === null) {
    createWindow();
  }
});