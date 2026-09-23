// clipview.ts - how a clip should be drawn.
//
// This is where dice's arrangement view stops looking like everyone else's. In
// a conventional DAW every region is the same object: a rectangle with a
// waveform in it, whether it holds a sung take or a programmed drum part. But
// those are not the same kind of thing to work on. A performance is something
// you listen back to and trim; a programmed part is a pattern you edit.
//
// So dice draws them differently. A performance keeps its waveform, because the
// shape of the sound is the information. A programmed part becomes a block with
// its rhythm shown as steps, because where the hits fall is the information and
// the waveform of a synthesised kick tells you nothing you wanted to know.

/** How a clip is drawn: a waveform, or a block of steps. */
export type ClipLook = "performance" | "block";

/**
 * Parts the engine generated or the sequencer plays. These are patterns, so
 * they draw as blocks.
 */
const PROGRAMMED_ROLES = new Set(["beat", "drums", "pad", "bass", "arp", "chords"]);

/**
 * Decide how to draw a clip.
 *
 * Recorded and imported audio is a performance whatever it contains: someone
 * beatboxing a drum part is still a performance, and the waveform is what tells
 * them which take it was. Only parts that came from a pattern draw as blocks.
 */
export function clipLook(track: { kind: string; role: string }): ClipLook {
  if (track.kind === "loop") return "performance";
  return PROGRAMMED_ROLES.has(track.role.toLowerCase()) ? "block" : "performance";
}

/** Vocal takes recorded as one stack, which the view groups together. */
export function isStacked(track: { role: string }): boolean {
  return track.role.toLowerCase() === "vocal-stack";
}

/**
 * Reduce a waveform to per-step energy, for a block's pattern preview.
 *
 * Peaks come in at whatever resolution the lane is wide; this buckets them down
 * to musical steps and takes the loudest sample in each, because a step either
 * has a hit in it or does not and an average would smear a sharp transient into
 * its neighbours.
 *
 * Values are normalised against the loudest step, so a quiet part still shows a
 * readable pattern rather than a row of blank cells.
 */
export function stepsFromPeaks(peaks: number[], steps: number): number[] {
  const n = Math.max(1, Math.floor(steps));
  const out = new Array(n).fill(0);
  if (peaks.length === 0) return out;

  for (let i = 0; i < n; i += 1) {
    const from = Math.floor((i * peaks.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / n));
    let loudest = 0;
    for (let j = from; j < to && j < peaks.length; j += 1) {
      const v = peaks[j];
      if (Number.isFinite(v) && v > loudest) loudest = v;
    }
    out[i] = loudest;
  }

  const max = Math.max(...out);
  return max > 0 ? out.map((v) => v / max) : out;
}

/** Below this share of the loudest step, a cell reads as empty. */
export const STEP_ON_THRESHOLD = 0.28;

/** How many steps to draw in a block of this many bars. */
export function stepsForBars(bars: number, perBar = 16): number {
  return Math.max(perBar, Math.round(Math.max(1, bars) * perBar));
}
