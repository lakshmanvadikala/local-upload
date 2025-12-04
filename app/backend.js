const path = require("path");
const express = require("express");
const morgan = require("morgan");
const bodyParser = require("body-parser");
const isConnectionError = require("./modules/isconnectionerror");
const commandLineArgs = require("command-line-args");

const globals = require("../config/globals");
const core = require("./core");
const router = require("./routes/index");

const app = express();
let serverInstance = null;   // <-- backend server reference

// CLI args
globals.args = commandLineArgs([{ name: "clear", type: Boolean }]);

const port = globals.port;

// ----------------------------
// VIEW ENGINE
// ----------------------------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "../", "views")); // packaged-friendly path

// ----------------------------
// MIDDLEWARES
// ----------------------------
app.use(morgan("dev"));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Custom middlewares
for (let middleware of require("./modules/middlewares")) {
  app.use(middleware);
}

// Static assets + routes
app.use("/", express.static(path.join(__dirname, "..", "public")));
app.use("/", router);

console.log("Serving public directory:", path.join(__dirname, "..", "public"));

// ----------------------------
// START SERVER (Listen)
// ----------------------------
async function listen() {
  try {
    serverInstance = app.listen(port, "localhost", () => {
      console.log("Backend started on port", port);
    });
  } catch (err) {
    console.error("Backend listen error:", err);
  }
}

// ----------------------------
// STOP SERVER (clean shutdown)
// ----------------------------
async function stop() {
  return new Promise((resolve) => {
    if (serverInstance) {
      serverInstance.close(() => {
        console.log("Backend stopped (port released)");
        serverInstance = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

// ----------------------------
// BACKEND LAUNCH (core startup)
// ----------------------------
async function launch() {
  await core.launch();
}

// Start server immediately
listen();

// ----------------------------
// ERROR HANDLING
// ----------------------------
process.on("unhandledRejection", async (error) => {
  console.error("Unhandled rejection:", error.message);

  if (isConnectionError(error)) {
    globals.updateConnectivity(false);

    if (error.syncObject && error.watcher) {
      const { syncObject } = error;
      console.log(
        "Connection lost while watching changes. Restarting in 10 seconds..."
      );
      setTimeout(() => syncObject.load(), 10000);
    }
  }

  // Prevent log flooding
  if ("syncObject" in error) delete error["syncObject"];
  console.error(error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error.errno);

  if (error.errno === "EADDRINUSE") {
    console.error(
      "Port is already in use. Make sure another instance is not running."
    );
    return process.exit(1);
  }

  if (isConnectionError(error)) {
    globals.updateConnectivity(false);

    if (error.syncObject && error.watcher) {
      const { syncObject } = error;
      console.log(
        "Connection lost (exception). Restarting in 10 seconds..."
      );
      setTimeout(() => syncObject.load(), 10000);
    }
  }

  if ("syncObject" in error) delete error["syncObject"];
  console.error(error);
});

// EXPORTS
module.exports = {
  port,
  launch,
  stop,
};
