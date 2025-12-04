const { app, BrowserWindow, Tray, Menu, ipcMain, dialog } = require("electron");
const path = require("path");
const AutoLaunch = require("auto-launch");

const gbs = require("./config/globals");
const core = require("./app/core");
const backend = require("./app/backend");

// -------------------------------------
// Prevent infinite shutdown loop
// -------------------------------------
let shuttingDown = false;

// Auto-launch
const autolauncher = new AutoLaunch({
  name: "EngazeWell Drive",
});

// Icons
const logo = path.join(__dirname, "public", "images", "logo.png");
const logoGrey = path.join(__dirname, "public", "images", "logo-grey.png");
const logoSync = path.join(__dirname, "public", "images", "logo-sync.png");


// -------------------------------------------------------------
// SINGLE INSTANCE LOCK
// -------------------------------------------------------------
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (gbs.win) {
      if (gbs.win.isMinimized()) gbs.win.restore();
      gbs.win.show();
    } else {
      createWindow();
    }
  });
}


// -------------------------------------------------------------
// CREATE MAIN WINDOW
// -------------------------------------------------------------
function createWindow() {
  if (gbs.win) return;

  gbs.win = new BrowserWindow({
    width: 800,
    height: 750,
    icon: logo,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    resizable: true,
    show: false
  });

  gbs.win.loadURL(`http://127.0.0.1:${backend.port}`);

  gbs.win.once("ready-to-show", () => {
    gbs.win.show();
  });

  // -------------------------------------
  // FIX: CLOSE BUTTON SHOULD QUIT ONCE
  // -------------------------------------
  gbs.win.on("close", async (e) => {
    if (!shuttingDown) {
      e.preventDefault();
      shuttingDown = true;   // avoid infinite loop

      console.log("Window closed → stopping backend...");

      try {
        await backend.stop();  // Stop backend server
      } catch (err) {
        console.error("Error stopping backend:", err);
      }

      gbs.win = null;

      console.log("Quitting app...");
      app.quit();  // This will NOT trigger loop now
    }
  });
}


// -------------------------------------------------------------
// TRAY MENU
// -------------------------------------------------------------
function generateTrayMenu() {
  if (!gbs.tray) return;

  gbs.trayMenu = Menu.buildFromTemplate([
    {
      label: "Open Settings",
      click() {
        if (!gbs.win) createWindow();
        else gbs.win.show();
      }
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
      }
    },
    { type: "separator" },

    // --------------------------
    // QUIT + STOP BACKEND
    // --------------------------
    {
      label: "Quit",
      click: async () => {
        if (!shuttingDown) {
          shuttingDown = true;

          console.log("Tray Quit → stopping backend...");
          try {
            await backend.stop();
          } catch (err) {
            console.error("Backend stop error:", err);
          }
        }

        app.quit();
      }
    }
  ]);

  gbs.tray.setContextMenu(gbs.trayMenu);
}


// -------------------------------------------------------------
// TRAY ICON & EVENTS
// -------------------------------------------------------------
function generateTray() {
  gbs.tray = new Tray(logo);

  gbs.tray.on("double-click", () => {
    if (!gbs.win) createWindow();
    else gbs.win.show();
  });

  generateTrayMenu();
}


// Update tray icon while syncing
function updateTrayIcon() {
  const accounts = core.accounts();
  const isSyncing = accounts.length > 0 && accounts[0].syncing;
  gbs.tray.setImage(isSyncing ? logoSync : logo);
}


// -------------------------------------------------------------
// APP LAUNCH
// -------------------------------------------------------------
async function launch() {
  autolauncher.isEnabled()
    .then((enabled) => (gbs.autorun = enabled))
    .catch((err) => console.error("Auto-launch error:", err));

  generateTray();

  // Launch backend
  await backend.launch();

  createWindow();

  // Notifications
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


// -------------------------------------------------------------
// IPC
// -------------------------------------------------------------
ipcMain.handle("select-folder", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"]
  });

  return result.canceled ? null : result.filePaths[0];
});


// -------------------------------------------------------------
// APP EVENTS
// -------------------------------------------------------------
app.on("browser-window-focus", () => {
  if (gbs.win) {
    gbs.win.webContents.send("window-focused");
  }
});

// Quit fully when all windows closed
app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (!gbs.win) createWindow();
});


// Start the app
app.whenReady().then(launch);
