// strumpattern.ts - a right hand, written down.
//
// The trackpad strum gives a chord its rhythm from your own gesture, which is
// the best way to play one and no use at all when you want to hear what a
// progression sounds like. This is the other way: a pattern of strokes on the
// sixteenth grid, each with a direction, played against the same transport the
// drums run on so the guitar lands with the beat.
//
// Directions are the point. A down stroke runs low string to high and an up
// stroke runs high to low, which is most of why a strummed guitar sounds like
// a guitar and not like a chord being retriggered. Up strokes are also softer
// here, because a hand coming back up catches fewer strings and catches them
// at an angle.

import { STEPS_PER_BAR } from "./drums";

export type StrokeDirection = "down" | "up";

export interface Stroke {
  /** Sixteenth within the bar, 0..15. */
  step: number;
  direction: StrokeDirection;
  /** 0..1, before the pattern's own feel is applied. */
  velocity: number;
}

export interface StrumPattern {
  id: string;
  name: string;
  strokes: Stroke[];
  note: string;
}

const down = (step: number, velocity = 1): Stroke => ({ step, direction: "down", velocity });
const up = (step: number, velocity = 0.72): Stroke => ({ step, direction: "up", velocity });

/**
 * Patterns people actually play, rather than a grid of every possibility.
 *
 * The first is the one to start on: a stroke on each beat, which is what
 * anybody does when they want to hear the chords.
 */
export const STRUM_PATTERNS: StrumPattern[] = [
  {
    id: "beats",
    name: "On the beat",
    strokes: [down(0), down(4), down(8), down(12)],
    note: "A down stroke on each beat. The plainest way to hear a progression.",
  },
  {
    id: "folk",
    name: "Folk",
    strokes: [down(0), down(4), up(6), up(10), down(8, 0.85), up(14)],
    note: "Down, down-up, up-down-up. The campfire pattern.",
  },
  {
    id: "eighths",
    name: "Eighths",
    strokes: [down(0), up(2), down(4), up(6), down(8), up(10), down(12), up(14)],
    note: "Straight eighths, down and up all the way through.",
  },
  {
    id: "offbeat",
    name: "Offbeat",
    strokes: [up(2), up(6), up(10), up(14)],
    note: "Up strokes between the beats, the way a ska or reggae guitar sits.",
  },
  {
    id: "ballad",
    name: "Ballad",
    strokes: [down(0), down(8, 0.8), up(12, 0.6)],
    note: "Two strokes a bar and a lift at the end. Room for a voice.",
  },
  {
    id: "sixteenths",
    name: "Push",
    strokes: [down(0), up(3), up(6), down(8), up(11), up(14)],
    note: "Sixteenth pushes against the beat, for something with more drive.",
  },
];

/** The stroke at this step of the bar, or null for a gap. */
export function strokeAt(pattern: StrumPattern, step: number): Stroke | null {
  const inBar = ((Math.floor(step) % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR;
  return pattern.strokes.find((s) => s.step === inBar) ?? null;
}

/**
 * Which chord of a progression is playing at this step.
 *
 * One chord per bar, cycling, which is what a progression means when nobody
 * has said otherwise. Returns -1 when there is nothing to play.
 */
export function chordIndexAt(step: number, chordCount: number, barsPerChord = 1): number {
  if (chordCount <= 0) return -1;
  const bars = Math.max(1, Math.floor(barsPerChord));
  const bar = Math.floor(Math.max(0, step) / STEPS_PER_BAR / bars);
  return bar % chordCount;
}

/**
 * Where a stroke starts and ends across the strings, 0..1.
 *
 * A down stroke travels from the low string to the high one. The strum maths
 * in strum.ts reads 0 as the lowest string, so down runs 0 to 1 and up runs
 * back the other way.
 */
export function strokeSweep(direction: StrokeDirection): { from: number; to: number } {
  return direction === "down" ? { from: 0, to: 1 } : { from: 1, to: 0 };
}

/**
 * How long a stroke takes to cross the strings, in seconds.
 *
 * Tied to the tempo, because a strum at 180 that takes as long as a strum at
 * 70 arrives late enough to sound like a mistake. Up strokes are quicker: the
 * hand is travelling back and catches the strings in less time.
 */
export function strokeSeconds(bpm: number, direction: StrokeDirection): number {
  const beat = 60 / Math.max(20, Math.min(300, bpm || 120));
  const span = beat * (direction === "down" ? 0.09 : 0.07);
  return Math.max(0.012, Math.min(0.09, span));
}
