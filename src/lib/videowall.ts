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
  /** This take's own level in the mix, 0..1. Absent means unity. */
  level?: number;
  /**
   * How much of the head of this take to skip on playback, in milliseconds.
   *
   * A take recorded over the wall starts rolling just before the guide starts,
   * and the singer hears the guide late and is heard late by the amount the
   * audio system reports. Skipping that much puts the take back on the guide.
   */
  leadInMs?: number;
  /** Repeat this take for as long as the wall plays. */
  loop?: boolean;
  /** Brought in from a file rather than recorded here. */
  imported?: boolean;
  /** This browser could not decode it. Shown as such rather than as black. */
  broken?: boolean;
  /** Left out of the wall without being deleted. */
  hidden?: boolean;
}

/**
 * How loud each take should be when `count` of them play together.
 *
 * Equal power rather than one-over-n: separate takes of a voice are not the
 * same signal, so they sum closer to the square root of their number than to
 * their number. One take plays at unity, four at half - and a take's own level
 * rides on top of that, so balancing the mix does not undo the staging.
 */
export function takeLevel(
  take: { muted?: boolean; level?: number },
  count: number,
  guide = 1
): number {
  if (take.muted) return 0;
  const own = typeof take.level === "number" && Number.isFinite(take.level)
    ? Math.max(0, Math.min(1, take.level))
    : 1;
  return (own * Math.max(0, Math.min(1, guide))) / Math.sqrt(Math.max(1, count));
}

/** The takes actually on the wall. */
export function visibleTakes(takes: VideoTake[]): VideoTake[] {
  return takes.filter((t) => !t.hidden).slice(0, MAX_TAKES);
}

/**
 * The lead-in for a new take.
 *
 * `guideZeroAt` is the clock time at which the guide was at its own start, read
 * back from where the guide really was, so a slow start is already counted.
 * Never negative, since a take cannot be started before its first frame.
 */
export function measureLeadInMs(
  guideZeroAt: number,
  recorderStartedAt: number,
  roundTripMs = 0
): number {
  const gap = guideZeroAt - recorderStartedAt + Math.max(0, roundTripMs || 0);
  return Number.isFinite(gap) ? Math.max(0, Math.round(gap)) : 0;
}

/**
 * How to bring a playing take back to where it should be.
 *
 * Each take is its own media element on its own clock. A small error is closed
 * by a slight change of speed, which is inaudible. A large one needs a seek,
 * which is audible, so it is kept for errors that are already worse than a
 * jump. `driftSec` is positive when the take is ahead.
 */
export function driftCorrection(driftSec: number): { rate: number; seekBy: number | null } {
  if (!Number.isFinite(driftSec)) return { rate: 1, seekBy: null };
  const size = Math.abs(driftSec);
  if (size < 0.015) return { rate: 1, seekBy: null };
  if (size > 0.2) return { rate: 1, seekBy: -driftSec };
  return { rate: Math.max(0.95, Math.min(1.05, 1 - driftSec * 0.5)), seekBy: null };
}

/** What a take is worth once its lead-in is skipped. */
export function playableMs(take: VideoTake): number {
  const total = take.durationMs || 0;
  if (total <= 0) return 0;
  const lead = Math.max(0, Math.min(total, take.leadInMs ?? 0));
  return total - lead;
}

/**
 * How long one pass of a looping take lasts, in milliseconds.
 *
 * Snapped down to whole bars at the studio tempo when one is given, because a
 * take is stopped by hand and almost never ends on a bar line. A loop a fraction
 * of a bar long falls further off the beat on every pass. A take shorter than
 * one bar keeps its own length.
 */
export function loopPeriodMs(take: VideoTake, bpm?: number, beatsPerBar = 4): number {
  const playable = playableMs(take);
  if (playable <= 0) return 0;
  if (!bpm || !Number.isFinite(bpm) || bpm <= 0) return playable;
  const barMs = (60000 / bpm) * Math.max(1, beatsPerBar);
  const bars = Math.floor(playable / barMs + 1e-6);
  return bars >= 1 ? bars * barMs : playable;
}

/** How many whole bars a loop lasts, or null when it is not bar-aligned. */
export function loopBars(take: VideoTake, bpm?: number, beatsPerBar = 4): number | null {
  if (!bpm || bpm <= 0) return null;
  const barMs = (60000 / bpm) * Math.max(1, beatsPerBar);
  const bars = Math.round(loopPeriodMs(take, bpm, beatsPerBar) / barMs);
  return bars >= 1 && Math.abs(bars * barMs - loopPeriodMs(take, bpm, beatsPerBar)) < 1 ? bars : null;
}

/**
 * Where a take should be, in seconds of its own file, this far into the wall.
 *
 * A looping take wraps within its playable part: back to the end of its
 * lead-in, never to its first frame, which would replay what was skipped.
 */
export function takePosition(
  take: VideoTake,
  elapsedSec: number,
  bpm?: number
): number {
  const lead = Math.max(0, take.leadInMs ?? 0) / 1000;
  const elapsed = Math.max(0, elapsedSec);
  if (!take.loop) return lead + elapsed;
  const period = loopPeriodMs(take, bpm) / 1000;
  if (period <= 0) return lead + elapsed;
  return lead + (elapsed % period);
}

/**
 * How far `actual` is from `target` on a loop, the short way round.
 *
 * Just after a loop wraps, a take still finishing its last pass is "ahead" by
 * almost a whole period if read in a straight line. Read around the circle it is
 * a few milliseconds behind, which is what it really is.
 */
export function loopDrift(actualSec: number, targetSec: number, periodSec: number): number {
  const d = actualSec - targetSec;
  if (!(periodSec > 0)) return d;
  const half = periodSec / 2;
  return ((((d + half) % periodSec) + periodSec) % periodSec) - half;
}

/**
 * How long the wall runs.
 *
 * Takes that do not loop decide it: the longest of them, measured from where
 * each starts playing, so a take's lead-in does not hold the wall open after it
 * has finished. Looping takes repeat until then. When every take loops, there is
 * no natural end, so this is one pass of the longest loop, which is what an
 * export of an all-loop wall records.
 *
 * Zero when nothing has a known duration yet, which the caller treats as "let
 * the elements tell us when they end" rather than "stop immediately".
 */
export function wallDurationMs(takes: VideoTake[], bpm?: number): number {
  const live = visibleTakes(takes);
  if (live.length === 0) return 0;
  const once = live.filter((t) => !t.loop);
  if (once.length > 0) return once.reduce((max, t) => Math.max(max, playableMs(t)), 0);
  return live.reduce((max, t) => Math.max(max, loopPeriodMs(t, bpm)), 0);
}

/** Whether the wall stops by itself, which it does unless every take loops. */
export function wallEnds(takes: VideoTake[]): boolean {
  return visibleTakes(takes).some((t) => !t.loop);
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

/**
 * Formats to record video in, cheapest first.
 *
 * H.264 goes first because Macs and most phones encode it in hardware. VP9 is
 * encoded in software, and measured on the same camera it took about three
 * times the processor, which is time taken from the hand tracking and from
 * whatever is playing on the wall. MP4 also opens in QuickTime and on a phone.
 */
export const VIDEO_MIMES = [
  "video/mp4;codecs=avc1,opus",
  "video/mp4;codecs=avc1.42E01F,opus",
  "video/webm;codecs=h264,opus",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

/** A file ending that matches what a blob holds. */
export function fileExtension(mime: string): string {
  const m = mime.toLowerCase();
  if (m.startsWith("video/mp4") || m.startsWith("audio/mp4")) return "mp4";
  if (m.includes("matroska")) return "mkv";
  if (m.startsWith("video/quicktime")) return "mov";
  if (m.startsWith("audio/ogg")) return "ogg";
  return "webm";
}

/** The shortest wait between two jumps of one take, in milliseconds. */
export const SEEK_GAP_MS = 1000;
/** The longest. */
export const SEEK_GAP_MAX_MS = 8000;

/**
 * How long a take waits before its next jump.
 *
 * A jump that came soon after the last one means the take is falling behind
 * faster than jumps can fix, which is what a busy computer does to a large
 * imported video. Jumping every second then makes it worse, so the wait
 * doubles. A take that has gone a long while without needing one starts again
 * from the shortest wait.
 */
export function nextSeekGap(gapMs: number, sinceLastSeekMs: number): number {
  if (sinceLastSeekMs > gapMs * 3) return SEEK_GAP_MS;
  return Math.min(SEEK_GAP_MAX_MS, Math.max(SEEK_GAP_MS, gapMs * 2));
}
