// strum.ts - strumming a chord with the trackpad.
//
// Hold a chord, then sweep across the strings and they sound one at a time in
// the direction you moved. It is the interaction laurie.fm uses (chords on the
// number keys, strum on the trackpad) and the reason it feels like an
// instrument rather than a chord button: the timing between the notes is your
// gesture, not a preset "strum speed" slider. Sweep fast and it snaps; drag
// slowly and it arpeggiates; stop halfway and only the strings you crossed
// sound.
//
// Everything here is pure. Positions are normalised 0..1 across the strip, so
// the same code serves a pointer drag, a two-finger scroll and a touch swipe.

/** A note the strum wants played, relative to the start of the gesture. */
export interface StrumNote {
  midi: number;
  /** Seconds after the gesture segment began. */
  at: number;
  velocity: number;
}

/**
 * Lay a chord out across strings, guitar fashion.
 *
 * Chord tones repeat upward in octaves, so six strings over a triad give you
 * root-third-fifth-root-third-fifth across two octaves rather than three notes
 * and three silent strings. Always ascending, so string 0 is the lowest and a
 * downward sweep is a downstroke.
 */
export function stringVoicing(notes: number[], strings: number): number[] {
  if (notes.length === 0 || strings <= 0) return [];
  const sorted = [...notes].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < strings; i += 1) {
    const tone = sorted[i % sorted.length];
    const octave = Math.floor(i / sorted.length);
    out.push(tone + 12 * octave);
  }
  return out;
}

/**
 * The strings a sweep crossed, in the order it crossed them.
 *
 * Each string sits on a line at the centre of its band, so sweeping the whole
 * strip crosses every string exactly once and a sweep that stops between two
 * strings does not sound the one it never reached. Travel order, so a backwards
 * sweep returns them high to low: that is the upstroke.
 */
export function crossedStrings(from: number, to: number, strings: number): number[] {
  if (strings <= 0 || from === to) return [];
  const lineAt = (i: number) => (i + 0.5) / strings;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const crossed: number[] = [];
  for (let i = 0; i < strings; i += 1) {
    const line = lineAt(i);
    // Half-open, so a gesture resumed from exactly where it stopped does not
    // sound the same string twice.
    if (line > lo && line <= hi) crossed.push(i);
  }
  return to < from ? crossed.reverse() : crossed;
}

/**
 * How hard a sweep hits, from how fast it moved.
 *
 * A slow drag is a soft arpeggio and a flick is a hard strum, which is how a
 * real one behaves. Floored well above zero so a deliberate slow sweep is still
 * clearly audible rather than fading into nothing.
 */
export function strumVelocity(distance: number, seconds: number): number {
  if (!(seconds > 0)) return 1;
  const speed = Math.abs(distance) / seconds; // strips per second
  return Math.max(0.35, Math.min(1, 0.35 + Math.min(1, speed / 3.5) * 0.65));
}

export interface StrumOptions {
  /** MIDI notes of the held chord. */
  chord: number[];
  strings?: number;
  /** Where the gesture was, and where it moved to, 0..1 across the strip. */
  from: number;
  to: number;
  /** How long that movement took. */
  seconds: number;
  /**
   * Floor on the gap between consecutive strings, in seconds. A wheel event
   * reports a jump with no duration, and firing six notes at the same instant
   * is a chord, not a strum.
   */
  minGap?: number;
}

/**
 * Turn one segment of a gesture into notes to play.
 *
 * Notes are spaced across the time the movement actually took, so the rhythm of
 * the strum is the rhythm of your hand. When a segment reports no meaningful
 * duration, as a scroll wheel does, `minGap` spreads it just enough to read as
 * a strum instead of a block chord.
 */
export function strum(opts: StrumOptions): StrumNote[] {
  const strings = opts.strings ?? 6;
  const voicing = stringVoicing(opts.chord, strings);
  if (voicing.length === 0) return [];

  const crossed = crossedStrings(opts.from, opts.to, strings);
  if (crossed.length === 0) return [];

  const distance = opts.to - opts.from;
  const velocity = strumVelocity(distance, opts.seconds);
  const minGap = opts.minGap ?? 0.012;
  const span = Math.max(opts.seconds, minGap * crossed.length);
  const gap = crossed.length > 1 ? span / crossed.length : 0;

  return crossed.map((stringIndex, i) => ({
    midi: voicing[stringIndex],
    at: i * gap,
    // The strings at the end of a sweep are naturally a little softer, the way
    // the last string of a real strum is.
    velocity: velocity * (1 - (i / Math.max(1, crossed.length)) * 0.18),
  }));
}

/** Which way a sweep went, for the UI to show. */
export function strumDirection(from: number, to: number): "down" | "up" | "none" {
  if (to > from) return "down";
  if (to < from) return "up";
  return "none";
}

/** A strum note with the moment it should actually sound. */
export interface ScheduledStrumNote {
  note: StrumNote;
  /** Absolute time on the audio clock. */
  at: number;
}

/**
 * Lay a strum's notes on the clock so they sound one string after another.
 *
 * A pointer drag reports a smooth stream of positions and needs none of this:
 * each segment's notes can sound the moment the segment arrives. A trackpad
 * scroll does not. It arrives in bursts, several strings deep, and scheduling
 * every burst from "now" lands the second burst on top of the first - which is
 * heard as a slap rather than as a strum.
 *
 * So a scrolled strum queues: each string goes at least `gap` after the one
 * before it, wherever that leaves it relative to the gesture. `after` is the
 * time the previous call left the queue at, and comes back updated.
 *
 * Notes that would fall more than `maxLag` behind the gesture are dropped
 * rather than played late. Someone scrolling hard can cross strings faster than
 * a strum can sound them, and a queue that keeps every one of them plays a
 * flurry seconds after the fingers stopped, which is worse than a strum that
 * simply ends.
 */
export function sequenceStrum(
  notes: StrumNote[],
  base: number,
  after: number,
  gap: number,
  maxLag: number
): { plays: ScheduledStrumNote[]; after: number } {
  const plays: ScheduledStrumNote[] = [];
  let queue = after;
  for (const note of notes) {
    const at = Math.max(base + note.at, queue + gap);
    if (at > base + maxLag) break;
    plays.push({ note, at });
    queue = at;
  }
  return { plays, after: queue };
}
