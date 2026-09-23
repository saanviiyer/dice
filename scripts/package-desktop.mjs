// package-desktop.mjs - build the dice desktop app.
//
// Two steps. First rasterise the brand mark into whatever icon format the
// target platform wants (macOS gets a real .icns built from the same SVG the
// website uses, so the dock icon and the favicon are the same drawing). Then
// hand the project to @electron/packager.
//
// Only four things go into the app: the built dist, the three desktop shell
// files, and package.json. The renderer's dependencies are already bundled into
// dist by Vite, so the packaged app ships no node_modules at all.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import packager from "@electron/packager";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = path.join(ROOT, "build");
const SVG = path.join(ROOT, "public", "dice.svg");

/** The sizes an .iconset needs, as {file, px}. */
const ICONSET = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

function png(size, out) {
  execFileSync("sips", ["-s", "format", "png", "-Z", String(size), SVG, "--out", out], {
    stdio: "ignore",
  });
}

/**
 * Build a platform icon from the brand SVG, or return undefined if this
 * platform's toolchain is not available. A missing icon is a cosmetic loss, so
 * it never fails the build.
 */
function buildIcon() {
  fs.mkdirSync(BUILD, { recursive: true });
  if (process.platform !== "darwin") {
    // Linux takes a PNG directly. Windows wants .ico, which needs a converter
    // this repo does not carry, so those builds use the Electron default.
    try {
      const out = path.join(BUILD, "icon.png");
      png(1024, out);
      return process.platform === "linux" ? out : undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const iconset = path.join(BUILD, "icon.iconset");
    fs.rmSync(iconset, { recursive: true, force: true });
    fs.mkdirSync(iconset, { recursive: true });
    for (const [file, size] of ICONSET) png(size, path.join(iconset, file));
    const icns = path.join(BUILD, "icon.icns");
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns], { stdio: "ignore" });
    // Handed over without its extension: packager appends the right one for the
    // target platform, and rejects the path if it is already there.
    return path.join(BUILD, "icon");
  } catch (err) {
    console.warn(`could not build the app icon (${err.message}); using the default`);
    return undefined;
  }
}

// Everything the packaged app needs, and nothing else.
const KEEP = [
  /^\/package\.json$/,
  /^\/desktop$/,
  /^\/desktop\/(main|preload|serve)\.cjs$/,
  /^\/dist$/,
  /^\/dist\//,
];

if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) {
  console.error("dist/index.html is missing. Run `npm run build` first.");
  process.exit(1);
}

const icon = buildIcon();
const out = path.join(ROOT, "release");

/**
 * Silence one specific, misleading warning.
 *
 * Packager asks for two macOS icon formats: the `.icns` every Mac has used for
 * decades, and the `.icon` bundle Icon Composer produces for macOS 26. It warns
 * when the second is missing even though the first applied perfectly, so every
 * single build printed a WARNING that read like a failure and was not one.
 *
 * The filter is deliberately narrow: it matches only the `.icon` case, so a
 * genuinely missing `.icns` still warns loudly.
 */
const warn = console.warn;
console.warn = (...args) => {
  const first = typeof args[0] === "string" ? args[0] : "";
  if (first.includes('with extension ".icon"')) return;
  warn(...args);
};

const paths = await packager({
  dir: ROOT,
  out,
  name: "dice",
  appBundleId: "com.dice.studio",
  appCategoryType: "public.app-category.music",
  platform: process.env.DICE_PLATFORM || os.platform(),
  arch: process.env.DICE_ARCH || os.arch(),
  overwrite: true,
  asar: true,
  prune: false,
  icon,
  ignore: (p) => p !== "" && !KEEP.some((re) => re.test(p)),
});

console.warn = warn;
for (const p of paths) console.log(`built ${p}`);
if (icon) console.log("icon: build/icon.icns");
console.log(
  "\nThis build is unsigned. On macOS, right-click the app and choose Open the\n" +
    "first time, or Gatekeeper will refuse to launch it."
);
