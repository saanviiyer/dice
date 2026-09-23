// padkit.ts - playing the drum kit with the computer keyboard.
//
// Six pads on the home row, one per lane of the step sequencer, in lane order.
// Hitting a key fires the sound immediately; with record armed, the hit is also
// written into the pattern at the nearest step, so you can finger-drum a groove
// in and then edit it on the grid like anything you drew by hand.
//
// The layout avoids R, M and Space on purpose: the studio already binds those
// to record, metronome and transport, and a pad deck that silently swallowed
// them would break the shortcuts the rest of the app documents.

import {
  ACCENT,
  DRUM_LANES,
  NORMAL,
  STEPS_PER_BAR,
  clonePattern,
  type DrumInstrument,
  type DrumPattern,
} from "./drums";

export interface Pad {
  /** The physical key, as `KeyboardEvent.key` lowercased. */
  key: string;
  /** Shown on the pad face. */
  label: string;
  voice: DrumInstrument;
}

/**
 * The pads, in the same order as the sequencer's lanes so the deck and the grid
 * read as the same instrument. Home row, left to right, no reach.
 */
export const PADS: Pad[] = [
  { key: "a", label: "A", voice: "kick" },
  { key: "s", label: "S", voice: "snare" },
  { key: "d", label: "D", voice: "clap" },
  { key: "f", label: "F", voice: "hat" },
  { key: "g", label: "G", voice: "tom" },
  { key: "h", label: "H", voice: "shaker" },
];

/** Keys the deck claims, so the rest of the app can leave them alone. */
export const PAD_KEYS: string[] = PADS.map((p) => p.key);

const BY_KEY = new Map(PADS.map((p) => [p.key, p]));

/** The pad a keystroke means, or null if the deck does not want that key. */
export function padForKey(key: string): Pad | null {
  return BY_KEY.get(key.toLowerCase()) ?? null;
}

/** Every lane has a pad, and every pad a distinct key. */
export function padsCoverAllLanes(): boolean {
  const voices = new Set(PADS.map((p) => p.voice));
  return DRUM_LANES.every((l) => voices.has(l)) && new Set(PAD_KEYS).size === PADS.length;
}

/**
 * Snap a live hit onto the grid.
 *
 * `position` is the fractional step the transport was at when the key went
 * down, and `resolution` is how fine a grid to snap to: 1 for sixteenths, 2 for
 * eighths, 4 for quarters. Rounding is to the *nearest* grid line and wraps at
 * the end of the cycle, because a hit played a hair before the downbeat belongs
 * on the downbeat, not on the last sixteenth of the previous bar.
 */
export function quantizeStep(
  position: number,
  totalSteps: number,
  resolution = 1
): number {
  if (!(totalSteps > 0)) return 0;
  const res = Math.max(1, Math.round(resolution));
  const snapped = Math.round(position / res) * res;
  // A true modulo: the JS remainder of a negative number is negative.
  return ((snapped % totalSteps) + totalSteps) % totalSteps;
}

/**
 * Write a hit into a pattern at a velocity, returning a new one.
 *
 * A louder hit wins over one already on that step, so playing a part in twice
 * and hitting the accent harder the second time does what you meant. Playing it
 * softer does not quietly undo the accent you already have.
 */
export function withHit(
  pattern: DrumPattern,
  voice: DrumInstrument,
  step: number,
  velocity: number = NORMAL
): DrumPattern {
  const next = clonePattern(pattern);
  const lane = next[voice];
  const v = Math.max(0, Math.min(1, velocity));
  if (step >= 0 && step < lane.length) lane[step] = Math.max(lane[step] ?? 0, v);
  return next;
}

/** Holding shift plays the accent. */
export function velocityFor(accent: boolean): number {
  return accent ? ACCENT : NORMAL;
}

/** The grid resolutions the deck offers, coarsest last. */
export const RESOLUTIONS: Array<{ steps: number; label: string }> = [
  { steps: 1, label: "1/16" },
  { steps: 2, label: "1/8" },
  { steps: 4, label: "1/4" },
];

/** Bars a pattern spans, for labelling the deck. */
export function padBars(pattern: DrumPattern): number {
  return Math.max(1, Math.round(pattern.kick.length / STEPS_PER_BAR));
}
