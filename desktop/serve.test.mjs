import path from "node:path";
import { describe, expect, it } from "vitest";
import serve from "./serve.cjs";

const { mimeFor, isEngineRequest, engineTarget, resolveInDist } = serve;
const DIST = "/app/dist";

describe("resolveInDist", () => {
  it("serves a file inside dist", () => {
    expect(resolveInDist(DIST, "/assets/index.js")).toBe(path.join(DIST, "assets/index.js"));
  });

  it("serves the shell for the root", () => {
    expect(resolveInDist(DIST, "/")).toBe(path.join(DIST, "index.html"));
    expect(resolveInDist(DIST, "")).toBe(path.join(DIST, "index.html"));
  });

  it("refuses to climb out of dist", () => {
    expect(resolveInDist(DIST, "/../../etc/passwd")).toBeNull();
    expect(resolveInDist(DIST, "/assets/../../../secret")).toBeNull();
  });

  it("refuses a traversal hidden in percent escapes", () => {
    // %2e%2e%2f is "../" once decoded, which is exactly the point of decoding
    // before the containment check rather than after it.
    expect(resolveInDist(DIST, "/%2e%2e%2f%2e%2e%2fetc/passwd")).toBeNull();
  });

  it("refuses a malformed escape rather than guessing", () => {
    expect(resolveInDist(DIST, "/%E0%A4%A")).toBeNull();
  });

  it("refuses a null byte", () => {
    expect(resolveInDist(DIST, "/index.html%00.png")).toBeNull();
  });

  it("does not mistake a sibling directory for dist", () => {
    // "/app/dist-secret" starts with "/app/dist" as a string but is not inside it.
    expect(resolveInDist(DIST, "/../dist-secret/key.txt")).toBeNull();
  });

  it("allows the nested MediaPipe assets the studio needs", () => {
    expect(resolveInDist(DIST, "/wasm/vision_wasm_internal.wasm")).toBe(
      path.join(DIST, "wasm/vision_wasm_internal.wasm")
    );
    expect(resolveInDist(DIST, "/models/hand_landmarker.task")).toBe(
      path.join(DIST, "models/hand_landmarker.task")
    );
  });
});

describe("mimeFor", () => {
  it("types the files the studio actually loads", () => {
    expect(mimeFor("/a/index.html")).toMatch(/^text\/html/);
    expect(mimeFor("/a/index.js")).toMatch(/^text\/javascript/);
    expect(mimeFor("/a/style.CSS")).toMatch(/^text\/css/);
    expect(mimeFor("/a/vision.wasm")).toBe("application/wasm");
    expect(mimeFor("/a/hand_landmarker.task")).toBe("application/octet-stream");
    expect(mimeFor("/a/dice.svg")).toBe("image/svg+xml");
  });

  it("falls back rather than guessing wrong", () => {
    expect(mimeFor("/a/LICENSE")).toBe("application/octet-stream");
  });
});

describe("engine proxy", () => {
  it("recognises engine requests and nothing else", () => {
    expect(isEngineRequest("/engine")).toBe(true);
    expect(isEngineRequest("/engine/api/session")).toBe(true);
    expect(isEngineRequest("/engineering/notes.js")).toBe(false);
    expect(isEngineRequest("/assets/engine.js")).toBe(false);
  });

  it("maps a request onto the engine origin, query string and all", () => {
    expect(engineTarget("http://localhost:8000", "/engine/api/session")).toBe(
      "http://localhost:8000/api/session"
    );
    expect(
      engineTarget("http://localhost:8000/", "/engine/api/session/x/file", "?path=stems%2Fbeat.wav")
    ).toBe("http://localhost:8000/api/session/x/file?path=stems%2Fbeat.wav");
  });

  it("maps the bare prefix to the engine root", () => {
    expect(engineTarget("http://localhost:8000", "/engine")).toBe("http://localhost:8000/");
  });
});
