// preload.cjs - the desktop shell's bridge, kept deliberately almost empty.
//
// The studio needs nothing from Node: it records through the Web Audio API,
// stores projects in IndexedDB, and reaches the engine through the same-origin
// /engine proxy the main process installs. So the only thing exposed is a flag
// the UI can use to say "desktop" where it would otherwise say "browser".
//
// Anything more would be surface area on a page that runs a camera.

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("dice", {
  desktop: true,
  platform: process.platform,
});
