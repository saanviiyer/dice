// videowall.ts - stacking several recorded takes into one joint display.
//
// Record yourself playing the part, record another take over the top, and the
// wall shows them side by side and plays them together, photobooth fashion.
// Export bounces the grid down to a single video with all the audio mixed.
//
// The layout maths lives here, pure, because it is the part that is easy to get
// subtly wrong (letterboxed cells, a fifth take squeezing the other four) and
// hard to check by eye.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Grid {
  cols: number;
  rows: number;
}

/** The largest wall the exporter will lay out. */
export const MAX_TAKES = 9;

/**
 * The grid for `count` takes.
 *
 * Two takes go side by side rather than stacked, because a webcam frame is
 * landscape and stacking two of them leaves a tall thin wall with bars down
 * both sides. Everything above that fills a square-ish grid, which keeps the
 * cells as close to the source aspect as possible.
 */
export function wallGrid(count: number): Grid {
  const n = Math.max(0, Math.min(MAX_TAKES, Math.floor(count)));
  if (n <= 0) return { cols: 0, rows: 0 };
  if (n === 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n <= 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  return { cols: 3, rows: 3 };
}

/**
 * Where each take sits on a wall of the given size.
 *
 * The last row is centred when it is not full, so three takes read as a row of
 * two above one centred take rather than one hanging off to the left.
 */
export function cellRects(count: number, width: number, height: number, gap = 0): Rect[] {
  const n = Math.max(0, Math.min(MAX_TAKES, Math.floor(count)));
  if (n <= 0 || width <= 0 || height <= 0) return [];
  const { cols, rows } = wallGrid(n);

  const cellW = (width - gap * (cols + 1)) / cols;
  const cellH = (height - gap * (rows + 1)) / rows;

  const out: Rect[] = [];
  for (let i = 0; i < n; i += 1) {
    const row = Math.floor(i / cols);
    const inRow = i % cols;
    // How many cells this row actually holds, so a short last row can centre.
    const rowCount = Math.min(cols, n - row * cols);
    const rowWidth = rowCount * cellW + (rowCount - 1) * gap;
    const x0 = (width - rowWidth) / 2;
    out.push({
      x: x0 + inRow * (cellW + gap),
      y: gap + row * (cellH + gap),
      width: cellW,
      height: cellH,
    });
  }
  return out;
}

/**
 * The source rectangle to draw so a frame fills its cell without distorting,
 * cropping the overflow. The CSS `object-fit: cover` rule, in numbers, because
 * `drawImage` has no such thing.
 */
export function coverSource(srcW: number, srcH: number, dst: Rect): Rect {
  if (srcW <= 0 || srcH <= 0 || dst.width <= 0 || dst.height <= 0) {
    return { x: 0, y: 0, width: Math.max(0, srcW), height: Math.max(0, srcH) };
  }
  const srcAspect = srcW / srcH;
  const dstAspect = dst.width / dst.height;
  if (srcAspect > dstAspect) {
    // Source is wider: crop the sides.
    const w = srcH * dstAspect;
    return { x: (srcW - w) / 2, y: 0, width: w, height: srcH };
  }
  // Source is taller: crop top and bottom.
  const h = srcW / dstAspect;
  return { x: 0, y: (srcH - h) / 2, width: srcW, height: h };
}

/** A take on the wall. */
export interface VideoTake {
  id: number;
  url: string;
  blob: Blob;
  label: string;
  /** Milliseconds, or 0 until the browser has read the metadata. */
  durationMs: number;
  /** Silenced but still on the wall: the picture without its sound. */
  muted?: boolean;
  /** Brought in from a file rather than recorded here. */
  imported?: boolean;
  /** This browser could not decode it. Shown as such rather than as black. */
  broken?: boolean;
  /** Left out of the wall without being deleted. */
  hidden?: boolean;
}

/** The takes actually on the wall. */
export function visibleTakes(takes: VideoTake[]): VideoTake[] {
  return takes.filter((t) => !t.hidden).slice(0, MAX_TAKES);
}

/**
 * How long the wall runs: the longest take, since they all start together.
 * Zero when nothing has a known duration yet, which the caller treats as "let
 * the elements tell us when they end" rather than "stop immediately".
 */
export function wallDurationMs(takes: VideoTake[]): number {
  const live = visibleTakes(takes);
  if (live.length === 0) return 0;
  return live.reduce((max, t) => Math.max(max, t.durationMs || 0), 0);
}

/**
 * Whether this browser is likely to be able to play a file at all.
 *
 * Deliberately permissive: browsers disagree about codecs inside containers,
 * `canPlayType` answers "maybe" more often than not, and the honest test is to
 * try. So anything claiming to be a video gets a chance, and a file that turns
 * out to be undecodable is reported on the wall rather than rejected at the
 * door on a guess.
 */
export function looksPlayable(file: { type?: string; name?: string }): boolean {
  const type = (file.type ?? "").toLowerCase();
  if (type.startsWith("video/")) return true;
  if (type) return false;
  // Some systems hand over a file with no type at all; fall back to the name.
  return /\.(mp4|mov|m4v|webm|ogv|mkv)$/i.test(file.name ?? "");
}

/**
 * A label for an imported file: its own name, shortened.
 *
 * The name is what the person knows the clip by, so it beats "take 4" - but a
 * cell is a couple of inches wide, and the end of a filename is usually the
 * part that identifies it, so the middle is what goes.
 */
export function importedLabel(fileName: string, maxChars = 22): string {
  const base = (fileName || "clip").replace(/\.[^.]+$/, "").trim() || "clip";
  const limit = Math.max(6, Math.floor(maxChars));
  if (base.length <= limit) return base;
  const head = Math.ceil((limit - 1) / 2);
  const tail = Math.floor((limit - 1) / 2);
  return `${base.slice(0, head)}…${base.slice(base.length - tail)}`;
}

/** A short human label for a take, from its index and length. */
export function takeLabel(index: number, durationMs: number): string {
  const secs = Math.round(durationMs / 100) / 10;
  return durationMs > 0 ? `take ${index + 1} · ${secs}s` : `take ${index + 1}`;
}
