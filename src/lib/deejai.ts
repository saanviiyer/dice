// deejai.ts - client for the dice engine.
//
// The engine is an offline Python audio engine (the deejai project) wrapped in
// a small FastAPI REST API. dice sends it natural-language producer commands
// ("add a lofi beat"), then fetches the rendered stem WAV files, decodes them
// into AudioBuffers, and drops them into the mixer alongside the live loops.
// Both the command box and the producer agent's add_backing tool come through
// here, so they produce the same stems and fail the same way.
//
// The module keeps the engine's own name because it is a separate project that
// dice does not modify; everything the user sees calls it the dice engine.
//
// Base URL resolution, in order:
//   - VITE_DICE_ENGINE_URL, the current name.
//   - VITE_DEEJAI_URL, still read so an existing environment keeps working.
//   - the dev-proxy path "/engine" (see vite.config.ts), which Vite forwards to
//     http://localhost:8000, avoiding CORS.
//
// The URL builders and the stem-to-track mapping are pure and unit tested; the
// network and Web Audio decode calls are thin wrappers around fetch and
// decodeAudioData.

/** Resolved base URL for the dice engine (no trailing slash). */
export function deejaiBase(): string {
  const env = import.meta.env as Record<string, string | undefined>;
  const raw = env.VITE_DICE_ENGINE_URL || env.VITE_DEEJAI_URL || "/engine";
  return raw.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// URL builders (pure)
// ---------------------------------------------------------------------------

export function sessionUrl(base: string): string {
  return `${base}/api/session`;
}

export function commandUrl(base: string, sid: string): string {
  return `${base}/api/session/${encodeURIComponent(sid)}/command`;
}

export function fileUrl(base: string, sid: string, path: string): string {
  return (
    `${base}/api/session/${encodeURIComponent(sid)}/file` +
    `?path=${encodeURIComponent(path)}`
  );
}

// ---------------------------------------------------------------------------
// Response shapes (a subset of what server.py returns)
// ---------------------------------------------------------------------------

export interface DeejaiTrack {
  file: string; // relative path under the session dir, e.g. "stems/beat.wav"
  name: string;
  role: string; // "beat" | "pad" | "bass" | "arp" | "lead" | "harmony" | ...
  pan: number; // -1..1
  start?: number; // seconds
  trim?: number; // seconds
}

export interface DeejaiProject {
  tempo: number | null;
  beat_style?: string | null;
  key?: string | null;
  progression?: string | string[] | null;
  lead?: string | null;
  tracks: DeejaiTrack[];
}

export interface CreateResponse {
  id: string;
  parser: string;
  project: DeejaiProject;
}

export interface CommandResponse {
  messages: string[];
  project: DeejaiProject;
}

/** Thrown when the backend cannot be reached (network error / not running). */
export class DeejaiUnavailableError extends Error {
  constructor(message = "deejai backend is unreachable") {
    super(message);
    this.name = "DeejaiUnavailableError";
  }
}

/** Thrown when the backend responds but with an error status. */
export class DeejaiRequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DeejaiRequestError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Stem -> mixer track mapping (pure)
// ---------------------------------------------------------------------------

/** Clamp a deejai pan value into the mixer's -1..1 range. */
export function normalizePan(pan: number | undefined): number {
  if (typeof pan !== "number" || Number.isNaN(pan)) return 0;
  return Math.max(-1, Math.min(1, pan));
}

/**
 * Given a project and the set of stem file paths already loaded into the mixer,
 * return the tracks that are new (dedupe by file path). Lets the user re-run
 * commands without stacking duplicate stems.
 */
export function newStemsToAdd(
  project: DeejaiProject,
  existingFiles: Iterable<string>
): DeejaiTrack[] {
  const seen = new Set(existingFiles);
  const out: DeejaiTrack[] = [];
  for (const t of project.tracks) {
    if (!t.file || seen.has(t.file)) continue;
    seen.add(t.file);
    out.push(t);
  }
  return out;
}

/** A short, human label for a stem track in the mixer. */
export function stemTrackLabel(t: DeejaiTrack): string {
  const name = (t.name || t.role || "stem").trim();
  return `AI: ${name}`;
}

// ---------------------------------------------------------------------------
// Network calls (thin wrappers)
// ---------------------------------------------------------------------------

async function postJson<T>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new DeejaiUnavailableError();
  }
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const j = await res.json();
      if (j && typeof j.detail === "string") detail = j.detail;
    } catch {
      /* ignore */
    }
    throw new DeejaiRequestError(res.status, detail);
  }
  return (await res.json()) as T;
}

/** Create a session (defaults to the built-in demo takes on the backend). */
export function createSession(
  base: string,
  opts: { use_llm?: boolean } = {}
): Promise<CreateResponse> {
  return postJson<CreateResponse>(sessionUrl(base), {
    use_llm: opts.use_llm ?? true,
  });
}

/** Send a natural-language producer command to a session. */
export function sendCommand(
  base: string,
  sid: string,
  text: string
): Promise<CommandResponse> {
  return postJson<CommandResponse>(commandUrl(base, sid), { text });
}

/**
 * Fetch a rendered stem WAV and decode it into an AudioBuffer in the shared
 * AudioContext. A cache-busting query param is appended because the backend
 * overwrites stem files in place as the project changes.
 */
export async function fetchStemBuffer(
  base: string,
  sid: string,
  path: string,
  ctx: BaseAudioContext
): Promise<AudioBuffer> {
  const url = `${fileUrl(base, sid, path)}&v=${Date.now()}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new DeejaiUnavailableError();
  }
  if (!res.ok) {
    throw new DeejaiRequestError(res.status, `could not fetch stem ${path}`);
  }
  const bytes = await res.arrayBuffer();
  return ctx.decodeAudioData(bytes);
}

/**
 * Lightweight reachability probe: try to create a session. Returns the created
 * session on success (callers can reuse it) or null if the backend is down.
 */
export async function probe(base: string): Promise<CreateResponse | null> {
  try {
    return await createSession(base);
  } catch {
    return null;
  }
}
