import type { MixerProjectSnapshot } from "./producerMixer";
import { isTrackArrangement, type TrackArrangement } from "./arrangement";
import {
  bassStackFromPattern,
  isBassPattern,
  normalizeBassLanes,
  normalizeBassPattern,
  type BassLane,
  type BassPattern,
} from "./bass";
import {
  isDrumPatternChoice,
  normalizeDrumPattern,
  type DrumPattern,
  type DrumPatternChoice,
} from "./drums";

// Namespaced to dice on purpose. Two studios served from the same localhost
// origin would otherwise share one IndexedDB database and overwrite each
// other's autosaved project.
const DB_NAME = "dice-studio";
const DB_VERSION = 2;
const STORE_NAME = "projects";
const INDEX_STORE = "index";
const AUTOSAVE_KEY = "autosave";
const INDEX_KEY = "summaries";

/** Drum-panel state: which dropdown entry is selected, plus the user's beat. */
export interface DrumProjectState {
  choice: DrumPatternChoice;
  custom: DrumPattern;
}

export interface CompositionProjectState {
  bassOn: boolean;
  /**
   * The first bass lane on its own.
   *
   * Kept alongside the stack rather than replaced by it so a project saved by
   * this build still opens in one that predates stacking: an older dice reads
   * this field and ignores `bassLanes` entirely, and gets the foundation rather
   * than nothing.
   */
  bass: BassPattern;
  /** Every bassline in the stack, first one included. */
  bassLanes: BassLane[];
  arrangement: TrackArrangement;
}

export interface DiceProject {
  version: 1;
  name: string;
  savedAt: string;
  bpm: number;
  bars: number;
  mixer: MixerProjectSnapshot;
  /** Optional: projects saved before the beat sequencer shipped have no drums. */
  drums?: DrumProjectState;
  /** Optional custom bassline and bar-by-bar layer arrangement. */
  composition?: CompositionProjectState;
}

/**
 * What the projects browser needs to draw a card.
 *
 * Kept separate from the project itself because a project carries every
 * recorded audio buffer with it. Listing ten projects by reading them whole
 * would pull tens of megabytes of audio out of IndexedDB just to render ten
 * names, so summaries live in their own record.
 */
export interface ProjectSummary {
  id: string;
  name: string;
  savedAt: string;
  bpm: number;
  tracks: number;
}

/** Derive a card from a project. */
export function projectSummary(id: string, project: DiceProject): ProjectSummary {
  return {
    id,
    name: cleanProjectName(project.name),
    savedAt: project.savedAt,
    bpm: Math.round(project.bpm),
    tracks: project.mixer?.tracks?.length ?? 0,
  };
}

/**
 * A fresh project id, ordered the way projects were made.
 *
 * The timestamp is zero-padded to a fixed width. Base-36 strings of different
 * lengths do not sort lexicographically the way the numbers do, so without the
 * padding an id made today can sort before one made last year.
 */
export function newProjectId(now = Date.now(), rand = Math.random): string {
  const stamp = Math.max(0, Math.floor(now)).toString(36).padStart(9, "0");
  const suffix = Math.floor(rand() * 0xffffff)
    .toString(36)
    .padStart(4, "0");
  return `p${stamp}${suffix}`;
}

/**
 * Put a summary into the index, newest first, replacing any entry with the same
 * id. Newest first because that is the order the browser shows them in, and
 * re-saving a project should move it to the front rather than leave it where it
 * was.
 */
export function upsertSummary(
  index: ProjectSummary[],
  summary: ProjectSummary
): ProjectSummary[] {
  const without = index.filter((s) => s.id !== summary.id);
  return [summary, ...without];
}

export function removeSummary(index: ProjectSummary[], id: string): ProjectSummary[] {
  return index.filter((s) => s.id !== id);
}

/** Keep only well-formed entries, so one corrupt record cannot blank the list. */
export function sanitizeIndex(value: unknown): ProjectSummary[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (s): s is ProjectSummary =>
      !!s &&
      typeof s === "object" &&
      typeof (s as ProjectSummary).id === "string" &&
      typeof (s as ProjectSummary).name === "string" &&
      typeof (s as ProjectSummary).savedAt === "string" &&
      Number.isFinite((s as ProjectSummary).bpm) &&
      Number.isFinite((s as ProjectSummary).tracks)
  );
}

/** "just now", "3 hours ago", "2 days ago" - for the card's subtitle. */
export function savedAgo(savedAt: string, now = Date.now()): string {
  const then = Date.parse(savedAt);
  if (!Number.isFinite(then)) return "";
  const mins = Math.max(0, Math.round((now - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function cleanProjectName(value: string): string {
  const clean = value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80);
  return clean || "Untitled project";
}

export function isDiceProject(value: unknown): value is DiceProject {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<DiceProject>;
  return (
    v.version === 1 &&
    typeof v.name === "string" &&
    typeof v.savedAt === "string" &&
    typeof v.bpm === "number" &&
    Number.isFinite(v.bpm) &&
    typeof v.bars === "number" &&
    Number.isFinite(v.bars) &&
    !!v.mixer &&
    v.mixer.version === 1 &&
    Array.isArray(v.mixer.tracks)
  );
}

/**
 * Drum state from a restored project, or null if it is missing or damaged.
 * Deliberately separate from isDiceProject: a corrupt drum pattern should
 * cost the user their beat, not the recorded audio in the same project.
 */
export function sanitizeDrumState(value: unknown): DrumProjectState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<DrumProjectState>;
  const custom = normalizeDrumPattern(v.custom);
  if (!isDrumPatternChoice(v.choice) || !custom) return null;
  return { choice: v.choice, custom };
}

export function sanitizeCompositionState(value: unknown): CompositionProjectState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<CompositionProjectState>;
  if (typeof v.bassOn !== "boolean" || !isTrackArrangement(v.arrangement)) return null;
  // A bassline saved before layers existed holds one note or null per step;
  // normalizing reads either shape, so an old project opens unchanged.
  const bass = normalizeBassPattern(v.bass);
  if (!bass || !isBassPattern(bass)) return null;
  // A project saved before stacking has no lanes at all, and one whose lanes
  // are damaged still has its original bassline sitting right there: either way
  // the single pattern is the fallback, so nobody loses their foundation.
  const bassLanes = normalizeBassLanes(v.bassLanes) ?? bassStackFromPattern(bass);
  return { bassOn: v.bassOn, bass, bassLanes, arrangement: v.arrangement };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Added in version 2. The existing autosave lives in STORE_NAME and is
      // untouched, so upgrading never loses the project someone had open.
      if (!db.objectStoreNames.contains(INDEX_STORE)) db.createObjectStore(INDEX_STORE);
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open project storage."));
  });
}

export async function saveAutosave(project: DiceProject): Promise<void> {
  if (!isDiceProject(project)) throw new Error("Invalid project data.");
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(project, AUTOSAVE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not save project."));
      tx.onabort = () => reject(tx.error ?? new Error("Project save was cancelled."));
    });
  } finally {
    db.close();
  }
}

export async function loadAutosave(): Promise<DiceProject | null> {
  const db = await openDatabase();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(AUTOSAVE_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not load project."));
    });
    return isDiceProject(value) ? value : null;
  } finally {
    db.close();
  }
}

export async function clearAutosave(): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(AUTOSAVE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not clear project."));
    });
  } finally {
    db.close();
  }
}


// ---------------------------------------------------------------------------
// Named projects
// ---------------------------------------------------------------------------

function withStore<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = run(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
      })
  );
}

/** Every saved project, newest first. */
export async function listProjects(): Promise<ProjectSummary[]> {
  try {
    return sanitizeIndex(await withStore(INDEX_STORE, "readonly", (s) => s.get(INDEX_KEY)));
  } catch {
    return [];
  }
}

/** Save a project under an id, and put it at the front of the list. */
export async function saveProjectAs(id: string, project: DiceProject): Promise<void> {
  if (!isDiceProject(project)) throw new Error("Invalid project data.");
  await withStore(STORE_NAME, "readwrite", (s) => s.put(project, id));
  const index = await listProjects();
  await withStore(INDEX_STORE, "readwrite", (s) =>
    s.put(upsertSummary(index, projectSummary(id, project)), INDEX_KEY)
  );
}

export async function loadProject(id: string): Promise<DiceProject | null> {
  try {
    const value = await withStore(STORE_NAME, "readonly", (s) => s.get(id));
    return isDiceProject(value) ? value : null;
  } catch {
    return null;
  }
}

export async function deleteProject(id: string): Promise<void> {
  await withStore(STORE_NAME, "readwrite", (s) => s.delete(id));
  const index = await listProjects();
  await withStore(INDEX_STORE, "readwrite", (s) => s.put(removeSummary(index, id), INDEX_KEY));
}

/** Rename without rewriting the audio: the name lives in both records. */
export async function renameProject(id: string, name: string): Promise<void> {
  const clean = cleanProjectName(name);
  const project = await loadProject(id);
  if (project) {
    await withStore(STORE_NAME, "readwrite", (s) => s.put({ ...project, name: clean }, id));
  }
  const index = await listProjects();
  await withStore(INDEX_STORE, "readwrite", (s) =>
    s.put(
      index.map((entry) => (entry.id === id ? { ...entry, name: clean } : entry)),
      INDEX_KEY
    )
  );
}
