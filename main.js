const { app, BrowserWindow, Tray, Menu, ipcMain, dialog } = require("electron");
const path = require("path");
const AutoLaunch = require("auto-launch");
const fs = require("fs-extra");

const gbs = require("./config/globals");
const core = require("./app/core");
const backend = require("./app/backend");

// Auto-launch settings
const autolauncher = new AutoLaunch({
  name: "EngazeWell Drive",
});

// Tray icon paths
const logo = path.join(__dirname, "public", "images", "logo.png");
const logoGrey = path.join(__dirname, "public", "images", "logo-grey.png");
const logoSync = path.join(__dirname, "public", "images", "logo-sync.png");

function createWindow() {
  gbs.win = new BrowserWindow({
    width: 600,
    height: 700,
    icon: logo,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    resizable: true,
    show: false,
  });

  // 👉 Load local HTML instead of remote URL (REQUIRED for packaged .exe)
  const indexPath = path.join(__dirname, "views/index.html");
  gbs.win.loadFile(indexPath);

  gbs.win.once("ready-to-show", () => {
    gbs.win.show();
  });

  gbs.win.on("closed", () => {
    gbs.win = null;
  });
}

// -------------------------
// TRAY
// -------------------------

function generateTrayMenu() {
  if (!gbs.tray) return;

  gbs.trayMenu = Menu.buildFromTemplate([
    {
      label: "Open Settings",
      click() {
        if (!gbs.win) createWindow();
        else gbs.win.show();
      },
    },
    {
      label: "Launch on startup",
      type: "checkbox",
      checked: gbs.autorun,
      click() {
        if (gbs.autorun) {
          autolauncher.disable().then(() => (gbs.autorun = false));
        } else {
          autolauncher.enable().then(() => (gbs.autorun = true));
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click() {
        app.quit();
      },
    },
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

  const iconPath = isSyncing ? logoSync : logo;
  gbs.tray.setImage(iconPath);
}

// -------------------------
// LAUNCH
// -------------------------

async function launch() {
  // Auto-launch check
  autolauncher
    .isEnabled()
    .then((enabled) => {
      gbs.autorun = enabled;
    })
    .catch((err) => console.error("Auto-launch error:", err));

  generateTray();

  // Start backend server
  await backend.launch();

  // Always open main window on startup
  createWindow();

  // Notifications
  core.on("notification", (text) => {
    if (gbs.tray) {
      gbs.tray.displayBalloon({
        title: "EngazeWell Drive",
        content: text,
      });
    }
  });

  gbs.on("syncing", updateTrayIcon);
}

// -------------------------
// IPC HANDLERS
// -------------------------

ipcMain.handle("select-folder", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

app.on("browser-window-focus", () => {
  if (gbs.win) {
    gbs.win.webContents.send("window-focused");
  }
});

// Keep tray always running
app.on("window-all-closed", () => {});

// Recreate window on dock click (macOS)
app.on("activate", () => {
  if (!gbs.win) createWindow();
});

app.whenReady().then(launch);
