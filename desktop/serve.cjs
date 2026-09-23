// serve.cjs - how the desktop shell turns a request into a file or a proxy.
//
// Kept free of any Electron import so it can be tested in plain Node. The parts
// worth testing are exactly the parts that would be security bugs if they were
// wrong: which paths are allowed out of the dist directory, and which requests
// are handed to the engine instead of the filesystem.

const path = require("node:path");

/** MIME types for the files a Vite build and the MediaPipe assets actually emit. */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".binarypb": "application/octet-stream",
  ".woff2": "font/woff2",
  ".wav": "audio/wav",
};

/** The content type to serve a file as. */
function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

const ENGINE_PREFIX = "/engine";

/** Whether a request should go to the engine rather than to disk. */
function isEngineRequest(pathname) {
  return pathname === ENGINE_PREFIX || pathname.startsWith(`${ENGINE_PREFIX}/`);
}

/** The engine URL a proxied request maps to. */
function engineTarget(origin, pathname, search = "") {
  const rest = pathname.slice(ENGINE_PREFIX.length) || "/";
  return `${origin.replace(/\/+$/, "")}${rest}${search}`;
}

/**
 * Resolve a request path to a file inside `distRoot`, or null if it would
 * escape.
 *
 * The containment check is the whole point. Without it a page could ask for
 * `dice://app/../../../../etc/passwd` and the shell would happily read it off
 * the user's disk and hand it to the renderer.
 */
function resolveInDist(distRoot, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    // A malformed escape sequence is not a path worth guessing at.
    return null;
  }
  rel = rel.replace(/^\/+/, "");
  // A null byte truncates a path in some syscalls; never let one through.
  if (rel.includes("\0")) return null;
  const root = path.resolve(distRoot);
  const target = path.resolve(root, rel || "index.html");
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

module.exports = { MIME, mimeFor, isEngineRequest, engineTarget, resolveInDist, ENGINE_PREFIX };
