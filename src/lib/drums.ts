// drums.ts - synthesized drum machine + metronome.
//
// Pure pattern data + step logic live here (testable). The DrumMachine class is
// a lookahead scheduler (same "Tale of Two Clocks" approach as the arpeggiator)
// running at 16th-note resolution. It shares the transport tempo (BPM) with the
// arpeggiator: both run at the same BPM against AudioContext.currentTime, so the
// drums and arp stay locked.

import { arrangementAllows, type TrackArrangement } from "./arrangement";
import {
  bassStackFromPattern,
  bassStackSteps,
  bassStackVoicesAt,
  emptyBassStack,
  type BassLane,
  type BassPattern,
} from "./bass";

export type DrumInstrument =
  | "kick"
  | "snare"
  | "clap"
  | "hat"
  | "tom"
  | "shaker";

/**
 * One groove. Each lane holds `bars * STEPS_PER_BAR` flags, 1 = hit. The built-in
 * catalog is all one bar; a user-edited pattern from the beat sequencer can be
 * up to MAX_PATTERN_BARS long. All three lanes are always the same length.
 */
export interface DrumPattern {
  kick: number[];
  snare: number[];
  clap: number[];
  hat: number[];
  tom: number[];
  shaker: number[];
}

/**
 * The three velocities a step can hold.
 *
 * A lane cell is a number in 0..1, not a flag, so a pattern can breathe: an
 * accent on the backbeat and ghost notes around it are the difference between a
 * groove and a metronome. Three named levels rather than a continuous slider,
 * because that is what a pad player and a drum tab can both express, and what
 * the notation can round-trip without losing anything.
 */
export const ACCENT = 1;
export const NORMAL = 0.72;
export const GHOST = 0.4;

/** Snap a velocity to the nearest named level. */
export function nearestVelocity(v: number): number {
  if (!(v > 0)) return 0;
  return [GHOST, NORMAL, ACCENT].reduce((best, level) =>
    Math.abs(level - v) < Math.abs(best - v) ? level : best
  );
}

/**
 * The tempo range, shared by every control that sets it.
 *
 * There used to be three: two sliders capped at 200 and a number box capped at
 * 220, all writing the same value, so what the tempo could be depended on which
 * one you happened to touch.
 */
export const BPM_MIN = 40;
export const BPM_MAX = 220;

export function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return 120;
  return Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(bpm)));
}

/**
 * Turn what someone typed into a tempo, or return `current` if it is not a
 * number yet.
 *
 * This exists because clamping a controlled number input on every keystroke is
 * a trap. Typing "90" over "120" sends "9" first, which clamps to the minimum
 * of 40, and the next keystroke then appends to *that*, giving "400", which
 * clamps to the maximum. The field sticks at 220 and cannot be typed out of.
 * The fix is to hold the draft while it is being typed and only clamp when it
 * is committed.
 */
export function commitBpm(draft: string, current: number): number {
  const trimmed = draft.trim();
  if (trimmed === "") return current;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return current;
  return clampBpm(n);
}

export const STEPS_PER_BAR = 16; // 16th notes
export const MAX_PATTERN_BARS = 4;
export const DRUM_LANES: DrumInstrument[] = [
  "kick",
  "snare",
  "clap",
  "hat",
  "tom",
  "shaker",
];

function steps(hits: number[]): number[] {
  const a = new Array(STEPS_PER_BAR).fill(0);
  for (const i of hits) if (i >= 0 && i < STEPS_PER_BAR) a[i] = 1;
  return a;
}

/** Lane length in steps (the kick lane is authoritative). */
export function patternLength(p: DrumPattern): number {
  return p.kick.length || STEPS_PER_BAR;
}

/** How many bars the pattern spans. */
export function patternBars(p: DrumPattern): number {
  return Math.max(1, Math.round(patternLength(p) / STEPS_PER_BAR));
}

export function clonePattern(p: DrumPattern): DrumPattern {
  return Object.fromEntries(DRUM_LANES.map((lane) => [lane, [...p[lane]]])) as unknown as DrumPattern;
}

/** A silent pattern of `bars` bars. */
export function emptyPattern(bars = 1): DrumPattern {
  const n = clampBars(bars) * STEPS_PER_BAR;
  return Object.fromEntries(
    DRUM_LANES.map((lane) => [lane, new Array(n).fill(0)])
  ) as unknown as DrumPattern;
}

function clampBars(bars: number): number {
  return Math.max(1, Math.min(MAX_PATTERN_BARS, Math.round(bars) || 1));
}

/** A mutable copy of a named preset, as the starting point for editing. */
export function patternFromName(name: DrumPatternName): DrumPattern {
  return clonePattern(DRUM_PATTERNS[name] ?? DRUM_PATTERNS.Off);
}

/**
 * Grow or shrink a pattern to `bars`. Growing repeats what is already there so
 * a one-bar groove tiles into two rather than leaving the new bar silent -
 * that is the behaviour people expect when they extend a loop.
 */
export function setPatternBars(p: DrumPattern, bars: number): DrumPattern {
  const target = clampBars(bars) * STEPS_PER_BAR;
  const resize = (lane: number[]): number[] => {
    const src = lane.length ? lane : new Array(STEPS_PER_BAR).fill(0);
    const out = new Array(target).fill(0);
    // Carry the velocity across, not just the fact of a hit: flattening every
    // cell to full here would erase a groove's dynamics the moment someone
    // changed the bar count.
    for (let i = 0; i < target; i++) out[i] = src[i % src.length] || 0;
    return out;
  };
  return Object.fromEntries(
    DRUM_LANES.map((lane) => [lane, resize(p[lane])])
  ) as unknown as DrumPattern;
}

/** Flip one cell. Returns a new pattern; out-of-range steps are a no-op. */
export function toggleStep(
  p: DrumPattern,
  lane: DrumInstrument,
  step: number
): DrumPattern {
  const next = clonePattern(p);
  if (step < 0 || step >= next[lane].length) return next;
  next[lane][step] = next[lane][step] ? 0 : NORMAL;
  return next;
}

/**
 * Write one cell. Used by click-and-drag painting.
 *
 * `on` may be a boolean or a velocity, so painting and setting an accent are
 * the same operation rather than two.
 */
export function setStep(
  p: DrumPattern,
  lane: DrumInstrument,
  step: number,
  on: boolean | number
): DrumPattern {
  const next = clonePattern(p);
  if (step < 0 || step >= next[lane].length) return next;
  const v = typeof on === "number" ? Math.max(0, Math.min(1, on)) : on ? NORMAL : 0;
  next[lane][step] = v;
  return next;
}

/** Silence one lane, or the whole pattern when `lane` is omitted. */
export function clearPattern(
  p: DrumPattern,
  lane?: DrumInstrument
): DrumPattern {
  const next = clonePattern(p);
  for (const l of DRUM_LANES) {
    if (lane && l !== lane) continue;
    next[l] = next[l].map(() => 0);
  }
  return next;
}

/** True when every lane is silent. */
export function isPatternEmpty(p: DrumPattern): boolean {
  return DRUM_LANES.every((l) => p[l].every((v) => v === 0));
}

/**
 * Validate untrusted pattern data (a restored project, mainly). Requires six
 * equal-length 0/1 lanes of a whole number of bars, within the bar cap.
 */
export function isDrumPattern(value: unknown): value is DrumPattern {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<DrumPattern>;
  if (DRUM_LANES.some((lane) => !Array.isArray(v[lane]))) return false;
  const n = v.kick!.length;
  if (n < STEPS_PER_BAR || n > MAX_PATTERN_BARS * STEPS_PER_BAR) return false;
  if (n % STEPS_PER_BAR !== 0) return false;
  if (DRUM_LANES.some((lane) => v[lane]!.length !== n)) return false;
  for (const lane of DRUM_LANES) {
    // Cells carry velocity, so anything in 0..1 is legal. A saved project from
    // before velocity existed holds only 0 and 1, which still passes.
    for (const cell of v[lane]!) {
      if (typeof cell !== "number" || !Number.isFinite(cell) || cell < 0 || cell > 1) return false;
    }
  }
  return true;
}

/** Upgrade the original three-lane format while restoring older projects. */
export function normalizeDrumPattern(value: unknown): DrumPattern | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<DrumPattern>;
  if (!Array.isArray(v.kick) || !Array.isArray(v.snare) || !Array.isArray(v.hat)) return null;
  const n = v.kick.length;
  if (n < STEPS_PER_BAR || n > MAX_PATTERN_BARS * STEPS_PER_BAR || n % STEPS_PER_BAR !== 0) return null;
  const legacy = [v.kick, v.snare, v.hat];
  const badCell = (cell: unknown) =>
    typeof cell !== "number" || !Number.isFinite(cell) || cell < 0 || cell > 1;
  if (legacy.some((lane) => lane.length !== n || lane.some(badCell))) return null;
  const silent = () => new Array(n).fill(0);
  const candidate: DrumPattern = {
    kick: [...v.kick],
    snare: [...v.snare],
    clap: Array.isArray(v.clap) ? [...v.clap] : silent(),
    hat: [...v.hat],
    tom: Array.isArray(v.tom) ? [...v.tom] : silent(),
    shaker: Array.isArray(v.shaker) ? [...v.shaker] : silent(),
  };
  return isDrumPattern(candidate) ? candidate : null;
}

export type DrumPatternName =
  | "Off"
  | "Four-on-floor"
  | "Rock"
  | "Half-time"
  | "Hi-hat 8ths"
  | "House"
  | "Techno"
  | "Disco"
  | "Garage 2-step"
  | "Boom-bap"
  | "Trap"
  | "Drum & Bass"
  | "Breakbeat"
  | "Funk"
  | "Dembow"
  | "Bossa Nova"
  | "Afrobeat"
  | "Jersey club"
  | "UK drill"
  | "Baile funk"
  | "Electro pop";

function groove(
  kick: number[],
  snare: number[],
  hat: number[],
  clap: number[] = [],
  tom: number[] = [],
  shaker: number[] = []
): DrumPattern {
  return {
    kick: steps(kick),
    snare: steps(snare),
    clap: steps(clap),
    hat: steps(hat),
    tom: steps(tom),
    shaker: steps(shaker),
  };
}

// Ordered roughly by family (basic -> four-on-floor dance -> breaks/hip-hop ->
// latin) because this order is what the Pattern dropdown shows. "Off" stays
// first: ProducerMode takes DRUM_PATTERN_NAMES[0] as its silent default.
export const DRUM_PATTERNS: Record<DrumPatternName, DrumPattern> = {
  Off: groove([], [], []),
  "Four-on-floor": groove([0, 4, 8, 12], [4, 12], [0, 2, 4, 6, 8, 10, 12, 14], [4, 12]),
  Rock: groove([0, 8], [4, 12], [0, 2, 4, 6, 8, 10, 12, 14], [], [14]),
  "Half-time": groove([0], [8], [0, 2, 4, 6, 8, 10, 12, 14], [8]),
  "Hi-hat 8ths": groove([0], [], [0, 2, 4, 6, 8, 10, 12, 14]),
  House: groove([0, 4, 8, 12], [4, 12], [2, 6, 10, 14], [4, 12], [], [1, 3, 5, 7, 9, 11, 13, 15]),
  Techno: groove([0, 4, 8, 12], [12], [2, 6, 10, 14], [4, 12], [15]),
  Disco: groove([0, 4, 8, 12], [4, 12], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [4, 12]),
  "Garage 2-step": groove([0, 6], [4, 12], [1, 3, 5, 7, 9, 11, 13, 15], [12], [], [2, 6, 10, 14]),
  "Boom-bap": groove([0, 10], [4, 12], [0, 2, 4, 6, 8, 10, 12, 14], [], [15]),
  Trap: groove([0, 6, 10], [8], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [8]),
  "Drum & Bass": groove([0, 10], [4, 12], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [], [15]),
  Breakbeat: groove([0, 3, 10], [4, 12], [0, 2, 4, 6, 8, 10, 12, 14], [], [7, 15]),
  Funk: groove([0, 6, 10], [4, 12], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [], [3, 15]),
  Dembow: groove([0, 3, 8, 11], [3, 6, 11, 14], [0, 2, 4, 6, 8, 10, 12, 14], [6, 14], [], [1, 5, 9, 13]),
  "Bossa Nova": groove([0, 6, 8, 14], [3, 6, 10, 13], [0, 2, 4, 6, 8, 10, 12, 14], [], [15], [1, 3, 5, 7, 9, 11, 13, 15]),
  Afrobeat: groove([0, 7, 10], [4, 12], [2, 6, 10, 14], [4, 12], [15], [0, 2, 4, 6, 8, 10, 12, 14]),
  "Jersey club": groove([0, 3, 6, 10, 12], [4, 12], [2, 6, 10, 14], [4, 7, 12]),
  "UK drill": groove([0, 7, 10], [8], [0, 3, 6, 9, 11, 14], [8], [15]),
  "Baile funk": groove([0, 3, 7, 10], [4, 11], [2, 6, 10, 14], [4, 11], [15], [1, 5, 9, 13]),
  "Electro pop": groove([0, 4, 8, 11], [4, 12], [2, 6, 10, 14], [4, 12], [15], [3, 7, 11, 15]),
};

export const DRUM_PATTERN_NAMES: DrumPatternName[] = Object.keys(
  DRUM_PATTERNS
) as DrumPatternName[];

/**
 * The extra dropdown entry that plays the user's own pattern from the beat
 * sequencer instead of a preset. It is a UI choice, not a catalog entry, so it
 * is deliberately absent from DRUM_PATTERNS.
 */
export const CUSTOM_PATTERN = "Custom";

export type DrumPatternChoice = DrumPatternName | typeof CUSTOM_PATTERN;

export const DRUM_PATTERN_CHOICES: DrumPatternChoice[] = [
  ...DRUM_PATTERN_NAMES,
  CUSTOM_PATTERN,
];

/** The pattern a dropdown choice actually plays. */
export function resolvePattern(
  choice: DrumPatternChoice,
  custom: DrumPattern
): DrumPattern {
  return choice === CUSTOM_PATTERN ? custom : DRUM_PATTERNS[choice] ?? DRUM_PATTERNS.Off;
}

/** Guard for restoring a saved choice; unknown names fall back to Off. */
export function isDrumPatternChoice(value: unknown): value is DrumPatternChoice {
  return (
    typeof value === "string" &&
    (value === CUSTOM_PATTERN || value in DRUM_PATTERNS)
  );
}

export interface StepHits {
  kick: boolean;
  snare: boolean;
  clap: boolean;
  hat: boolean;
  tom: boolean;
  shaker: boolean;
}

/** How hard each instrument hits on `step`, 0 for silent. */
export type StepVelocities = Record<DrumInstrument, number>;

/**
 * The velocity of every lane on `step`, wrapping at the pattern's own length.
 * This is the source of truth; `patternHits` is the same answer as booleans,
 * for the callers that only need to know whether something fires.
 */
export function patternVelocities(p: DrumPattern, step: number): StepVelocities {
  const n = patternLength(p);
  const i = ((step % n) + n) % n;
  const at = (lane: number[]) => {
    const v = lane[i];
    return typeof v === "number" && v > 0 ? Math.min(1, v) : 0;
  };
  return {
    kick: at(p.kick),
    snare: at(p.snare),
    clap: at(p.clap),
    hat: at(p.hat),
    tom: at(p.tom),
    shaker: at(p.shaker),
  };
}

/** Which instruments fire on `step` of a pattern, wrapping at its own length. */
export function patternHits(p: DrumPattern, step: number): StepHits {
  const v = patternVelocities(p, step);
  return {
    kick: v.kick > 0,
    snare: v.snare > 0,
    clap: v.clap > 0,
    hat: v.hat > 0,
    tom: v.tom > 0,
    shaker: v.shaker > 0,
  };
}

/** Which instruments fire on `step` (0..15) of a named preset. */
export function drumHits(name: DrumPatternName, step: number): StepHits {
  return patternHits(DRUM_PATTERNS[name], step);
}

/** Metronome: a click on every quarter (steps 0,4,8,12); accent on beat 1. */
export function metronomeClick(step: number): { click: boolean; accent: boolean } {
  const i = ((step % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR;
  return { click: i % 4 === 0, accent: i === 0 };
}

/**
 * How the machine asks for a sound. `velocity` is 0..1; every trigger has a
 * default so a caller that does not care can ignore it.
 */
export interface DrumTriggers {
  kick: (time: number, velocity?: number) => void;
  snare: (time: number, velocity?: number) => void;
  clap?: (time: number, velocity?: number) => void;
  hat: (time: number, velocity?: number) => void;
  tom?: (time: number, velocity?: number) => void;
  shaker?: (time: number, velocity?: number) => void;
  /** `gain` is the bass lane's own level, 0 to 1, not a velocity. */
  bass?: (midi: number, time: number, gate: number, gain?: number) => void;
  click: (time: number, accent: boolean) => void;
}

export type DrumEnables = Record<DrumInstrument, boolean>;

/**
 * Lookahead scheduler for drums + metronome at 16th-note resolution. Shares the
 * BPM with the arpeggiator so the two stay in tempo.
 */
export class DrumMachine {
  private ctx: AudioContext;
  private trig: DrumTriggers;

  private bpm = 120;
  private pattern: DrumPattern = DRUM_PATTERNS["Four-on-floor"];
  private bassLanes: BassLane[] = emptyBassStack(1);
  private bassEnabled = false;
  private arrangement: TrackArrangement | null = null;
  private enables: DrumEnables = {
    kick: true,
    snare: true,
    clap: true,
    hat: true,
    tom: true,
    shaker: true,
  };
  private metronome = false;

  private step = 0;
  private nextTime = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly lookaheadMs = 25;
  private readonly scheduleAhead = 0.1;

  // Steps handed to the audio clock but not yet heard. The UI drains this in a
  // draw loop so the sequencer playhead lands on the step you are hearing, not
  // the one already scheduled ~100ms ahead.
  private scheduled: { step: number; time: number }[] = [];
  private lastHeardStep = -1;
  private lastHeardTime = -1;

  constructor(ctx: AudioContext, trig: DrumTriggers) {
    this.ctx = ctx;
    this.trig = trig;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  setBpm(bpm: number): void {
    this.bpm = Math.max(20, Math.min(300, bpm));
  }
  /** Play a named preset, or a custom pattern from the beat sequencer. */
  setPattern(pattern: DrumPatternName | DrumPattern): void {
    this.pattern =
      typeof pattern === "string"
        ? DRUM_PATTERNS[pattern] ?? DRUM_PATTERNS.Off
        : pattern;
    // Editing bar count mid-loop must not leave the cursor past the end.
    this.step %= this.cycleSteps();
  }
  /**
   * Load the bassline, or a whole stack of them.
   *
   * Both shapes are accepted because a single pattern is still the useful thing
   * to hand over from a preset or a test, and wrapping it here keeps every
   * caller from having to know that basslines come in stacks now.
   */
  setBassPattern(bass: BassPattern | readonly BassLane[]): void {
    this.bassLanes = Array.isArray(bass)
      ? (bass as BassLane[]).slice()
      : bassStackFromPattern(bass as BassPattern);
    if (this.bassLanes.length === 0) this.bassLanes = emptyBassStack(1);
    this.step %= this.cycleSteps();
  }
  setBassEnabled(on: boolean): void {
    this.bassEnabled = on;
  }
  setArrangement(arrangement: TrackArrangement | null): void {
    this.arrangement = arrangement;
    this.step %= this.cycleSteps();
  }
  private cycleSteps(): number {
    if (this.arrangement) return this.arrangement.bars * STEPS_PER_BAR;
    // The longest bass lane, so a four-bar layer over a one-bar sub gets all
    // four of its bars before the loop comes round again.
    return Math.max(patternLength(this.pattern), bassStackSteps(this.bassLanes));
  }

  /** Steps in the pattern now playing (16 per bar). */
  get patternSteps(): number {
    return this.cycleSteps();
  }

  /**
   * The step currently sounding, or -1 when stopped. Call from a draw loop:
   * it drains the scheduled-step queue up to the audio clock.
   */
  playheadStep(): number {
    if (this.timer === null) return -1;
    const now = this.ctx.currentTime;
    while (this.scheduled.length > 0 && this.scheduled[0].time <= now) {
      const heard = this.scheduled.shift()!;
      this.lastHeardStep = heard.step;
      this.lastHeardTime = heard.time;
    }
    return this.lastHeardStep;
  }

  /**
   * Where the cycle is right now, as a fractional step, or -1 when stopped.
   *
   * `playheadStep` is what you draw; this is what you quantise against. A hit
   * played a little after a step still belongs to that step, and one played a
   * little before the next one belongs to the next: rounding needs the fraction
   * to make that call, and an integer step would drag every slightly-early hit
   * backwards onto the beat that had already passed.
   */
  playheadPosition(): number {
    const step = this.playheadStep();
    if (step < 0 || this.lastHeardTime < 0) return -1;
    const elapsed = Math.max(0, this.ctx.currentTime - this.lastHeardTime);
    return step + elapsed / this.stepDuration();
  }
  setEnables(e: DrumEnables): void {
    this.enables = { ...e };
  }
  setMetronome(on: boolean): void {
    this.metronome = on;
  }

  private stepDuration(): number {
    return 60 / this.bpm / 4; // 16th note
  }

  start(): void {
    if (this.timer !== null) return;
    this.step = 0;
    this.scheduled = [];
    this.lastHeardStep = -1;
    this.lastHeardTime = -1;
    this.nextTime = this.ctx.currentTime + 0.06;
    this.timer = setInterval(() => this.tick(), this.lookaheadMs);
  }

  /**
   * Halt, and rewind. The next `start` begins at the top of the pattern.
   *
   * The scheduled queue is dropped as well as the timer, because the scheduler
   * runs ahead of the audio clock: without that, up to a tenth of a second of
   * already-queued hits would keep sounding after you pressed stop.
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.step = 0;
    this.scheduled = [];
    this.lastHeardStep = -1;
    this.lastHeardTime = -1;
  }

  /** Halt where it is, so `resume` picks the groove up mid-bar. */
  pause(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.scheduled = [];
    this.lastHeardStep = -1;
    this.lastHeardTime = -1;
  }

  /**
   * Carry on from where `pause` left off, rather than from the top.
   *
   * The difference matters once a groove is more than a bar long: restarting a
   * four-bar pattern every time you glance away turns it back into bar one, and
   * you can never hear the part you were working on in context.
   */
  resume(): void {
    if (this.timer !== null) return;
    this.scheduled = [];
    this.lastHeardStep = -1;
    this.lastHeardTime = -1;
    this.nextTime = this.ctx.currentTime + 0.06;
    this.timer = setInterval(() => this.tick(), this.lookaheadMs);
  }

  private tick(): void {
    const dur = this.stepDuration();
    while (this.nextTime < this.ctx.currentTime + this.scheduleAhead) {
      const t = this.nextTime;
      const vel = patternVelocities(this.pattern, this.step);
      const drumsAllowed = arrangementAllows(this.arrangement, "drums", this.step);
      if (drumsAllowed && vel.kick > 0 && this.enables.kick) this.trig.kick(t, vel.kick);
      if (drumsAllowed && vel.snare > 0 && this.enables.snare) this.trig.snare(t, vel.snare);
      if (drumsAllowed && vel.clap > 0 && this.enables.clap) this.trig.clap?.(t, vel.clap);
      if (drumsAllowed && vel.hat > 0 && this.enables.hat) this.trig.hat(t, vel.hat);
      if (drumsAllowed && vel.tom > 0 && this.enables.tom) this.trig.tom?.(t, vel.tom);
      if (drumsAllowed && vel.shaker > 0 && this.enables.shaker) this.trig.shaker?.(t, vel.shaker);
      const bassVoices = bassStackVoicesAt(this.bassLanes, this.step);
      if (
        this.bassEnabled &&
        bassVoices.length > 0 &&
        arrangementAllows(this.arrangement, "bass", this.step)
      ) {
        // Every note of every unmuted lane, so neither a fifth layered onto a
        // root nor a whole second bassline gets silently dropped. Each voice
        // carries its lane's level with it.
        for (const voice of bassVoices) this.trig.bass?.(voice.midi, t, dur * 0.88, voice.gain);
      }
      if (this.metronome) {
        const m = metronomeClick(this.step);
        if (m.click) this.trig.click(t, m.accent);
      }
      this.scheduled.push({ step: this.step, time: t });
      // Bound the queue in case nothing is drawing a playhead.
      if (this.scheduled.length > 64) this.scheduled.shift();
      this.nextTime += dur;
      this.step = (this.step + 1) % this.cycleSteps();
    }
  }
}
