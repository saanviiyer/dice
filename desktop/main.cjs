// main.cjs - the dice desktop shell.
//
// Wraps the same build the website serves. Two things here are load-bearing and
// neither is boilerplate:
//
//  1. The app is served over a custom `dice://` scheme registered as *secure*,
//     not over file://. getUserMedia only runs in a secure context, so a
//     file:// shell would ship with a camera and a microphone that silently
//     never work. Registering the scheme as privileged is what makes the
//     instrument and the vocal recorder function at all on the desktop.
//
//  2. The same handler proxies /engine/* through to the local audio engine,
//     mirroring what the Vite dev server does in development. That keeps the
//     engine same-origin from the renderer's point of view, so the desktop
//     build needs no CORS configuration on the engine and no separate base URL
//     baked into the bundle.
//
// The request-mapping logic lives in serve.cjs so it can be tested without
// launching Electron.

const { app, BrowserWindow, protocol, net, shell, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { mimeFor, isEngineRequest, engineTarget, resolveInDist } = require("./serve.cjs");

const DIST = path.join(__dirname, "..", "dist");
const SCHEME = "dice";
const APP_ORIGIN = `${SCHEME}://app`;
const ENGINE_ORIGIN = process.env.DICE_ENGINE_URL || "http://localhost:8000";

// Must run before `ready`. `secure` is what puts the app in a secure context.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function fileResponse(filePath) {
  const body = fs.readFileSync(filePath);
  return new Response(body, { headers: { "content-type": mimeFor(filePath) } });
}

async function handleRequest(request) {
  const url = new URL(request.url);

  if (isEngineRequest(url.pathname)) {
    try {
      return await net.fetch(engineTarget(ENGINE_ORIGIN, url.pathname, url.search), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        // Required by fetch whenever a request body is streamed.
        duplex: "half",
      });
    } catch {
      // The studio treats an unreachable engine as "offline" and keeps working
      // without it, so this is a normal state rather than a crash.
      return new Response("dice engine unreachable", { status: 502 });
    }
  }

  const target = resolveInDist(DIST, url.pathname);
  if (!target) return new Response("forbidden", { status: 403 });

  try {
    return fileResponse(target);
  } catch {
    // A missing asset falls back to the shell. Routing is hash-based, so this
    // only catches genuinely absent files, but it beats a blank window.
    try {
      return fileResponse(path.join(DIST, "index.html"));
    } catch {
      return new Response("dice is not built yet. Run: npm run build", { status: 404 });
    }
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#3d1610",
    title: "dice",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadURL(`${APP_ORIGIN}/index.html`);

  // Links out of the app open in the real browser, never in a shell window
  // that has the app's permissions.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  return win;
}

app.whenReady().then(() => {
  protocol.handle(SCHEME, handleRequest);

  // The camera and the microphone are the product. Everything else is denied,
  // and both answers are scoped to the app's own origin.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    const fromApp = (contents.getURL() || "").startsWith(APP_ORIGIN);
    callback(fromApp && permission === "media");
  });
  session.defaultSession.setPermissionCheckHandler(
    (_contents, permission, origin) => origin.startsWith(APP_ORIGIN) && permission === "media"
  );

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
