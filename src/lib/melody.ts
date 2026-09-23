// melody.ts - listening back to a sung take and working out what would go under it.
//
// The harmonizer already sings harmonies, but only onto the chord your hand is
// holding: it needs to be told what the harmony is. That is fine while you are
// playing and useless the moment you have sung something and do not know what
// you sang. So this reads a recorded take back - pitch by pitch, into notes,
// into a key, into chords - and hands the answer to the two surfaces that can
// use it: the key selector and the progression box.
//
// Everything here is pure and tested against synthesised tones. The pitch
// detector itself is the harmonizer's, so what the suggestions hear is exactly
// what the live harmony hears.

import { detectPitchAutocorr } from "./harmonizer";
import { NOTE_NAMES, SCALE_INTERVALS, type ScaleName } from "./music";

export interface MelodyNote {
  midi: number;
  startSec: number;
  durSec: number;
}

export interface MelodyKey {
  /** Pitch class 0..11. */
  tonic: number;
  scale: ScaleName;
  /** 0..1. How much better this key fit than the average of the others. */
  confidence: number;
}

export interface MelodyAnalysis {
  notes: MelodyNote[];
  key: MelodyKey | null;
  /** One chord per segment, in order, as symbols: ["Em", "C", "G", "D"]. */
  chords: string[];
  /** Lowest and highest note sung, or null when nothing was. */
  range: { low: number; high: number } | null;
  durationSec: number;
}

/** Frequency of a MIDI note. */
const midiOf = (hz: number) => 69 + 12 * Math.log2(hz / 440);

/**
 * Drop the sample rate before looking for pitch.
 *
 * Autocorrelation costs window times lag count, and at 48kHz that is tens of
 * millions of operations per second of audio for information a voice does not
 * carry: nothing sung has a fundamental above a few hundred hertz. Averaging
 * down to 8kHz makes the whole analysis quick enough to run on a click, and
 * costs nothing that matters, because averaging is also a crude low-pass and
 * the thing being thrown away is the part that would alias.
 */
export function downsampleTo(
  samples: Float32Array,
  sampleRate: number,
  targetRate: number
): { data: Float32Array; sampleRate: number } {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return { data: new Float32Array(0), sampleRate: 0 };
  }
  if (targetRate <= 0 || sampleRate <= targetRate) {
    return { data: samples, sampleRate };
  }
  const factor = Math.floor(sampleRate / targetRate);
  if (factor <= 1) return { data: samples, sampleRate };
  const outLen = Math.floor(samples.length / factor);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    let sum = 0;
    for (let j = 0; j < factor; j += 1) sum += samples[i * factor + j];
    out[i] = sum / factor;
  }
  return { data: out, sampleRate: sampleRate / factor };
}

export interface PitchTrackOptions {
  /** Seconds between frames. */
  hopSec?: number;
  /** Length of each analysed frame, in seconds. */
  windowSec?: number;
  minHz?: number;
  maxHz?: number;
}

/** The pitch of each frame of a take, in Hz, or null where nothing was sung. */
export function pitchTrack(
  samples: Float32Array,
  sampleRate: number,
  opts: PitchTrackOptions = {}
): { hz: (number | null)[]; hopSec: number } {
  const hopSec = opts.hopSec ?? 0.02;
  const windowSec = opts.windowSec ?? 0.064;
  const minHz = opts.minHz ?? 80;
  const maxHz = opts.maxHz ?? 900;

  const low = downsampleTo(samples, sampleRate, 8000);
  const hop = Math.max(1, Math.round(hopSec * low.sampleRate));
  const win = Math.max(64, Math.round(windowSec * low.sampleRate));
  const hz: (number | null)[] = [];
  for (let start = 0; start + win <= low.data.length; start += hop) {
    const frame = low.data.subarray(start, start + win);
    hz.push(
      detectPitchAutocorr(frame, low.sampleRate, {
        minHz,
        maxHz,
        rmsThreshold: 0.008,
        clarityThreshold: 0.55,
      })
    );
  }
  return { hz, hopSec: hop / low.sampleRate };
}

export interface NotesOptions {
  /** Frames closer than this to the running note join it, in semitones. */
  tolerance?: number;
  /** Notes shorter than this are dropped as slides and squeaks. */
  minDurSec?: number;
}

/**
 * Group a pitch track into notes.
 *
 * A singer does not step between pitches, they slide, and a tracker adds wobble
 * on top of the wobble a voice already has. So frames join the note in progress
 * while they stay within a tolerance of it, and a note only exists once it has
 * lasted long enough to have been meant: shorter than that and it is the slide
 * between two notes rather than a note of its own.
 */
export function notesFromTrack(
  hz: (number | null)[],
  hopSec: number,
  opts: NotesOptions = {}
): MelodyNote[] {
  const tolerance = opts.tolerance ?? 0.7;
  const minDurSec = opts.minDurSec ?? 0.08;
  const notes: MelodyNote[] = [];

  let runMidis: number[] = [];
  let runStart = 0;

  const flush = (endIndex: number) => {
    if (runMidis.length === 0) return;
    const durSec = (endIndex - runStart) * hopSec;
    if (durSec >= minDurSec) {
      // The median, not the mean: the scoop into a note and the fall out of it
      // both pull an average away from the pitch actually held.
      const sorted = [...runMidis].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      notes.push({
        midi: Math.round(median),
        startSec: runStart * hopSec,
        durSec,
      });
    }
    runMidis = [];
  };

  for (let i = 0; i < hz.length; i += 1) {
    const f = hz[i];
    if (!f || !Number.isFinite(f) || f <= 0) {
      flush(i);
      continue;
    }
    const midi = midiOf(f);
    if (runMidis.length === 0) {
      runStart = i;
      runMidis = [midi];
      continue;
    }
    const running = runMidis.reduce((a, b) => a + b, 0) / runMidis.length;
    if (Math.abs(midi - running) <= tolerance) {
      runMidis.push(midi);
    } else {
      flush(i);
      runStart = i;
      runMidis = [midi];
    }
  }
  flush(hz.length);
  return notes;
}

// Krumhansl-Schmuckler profiles: how much each scale degree is used in music
// that is in a key. Correlating a melody's own weights against these, rotated
// to every tonic, is the standard way to name a key and does not need chords.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Time spent on each pitch class, which is what a key is heard from. */
export function pitchClassWeights(notes: MelodyNote[]): number[] {
  const w = new Array(12).fill(0);
  for (const n of notes) w[((n.midi % 12) + 12) % 12] += Math.max(0, n.durSec);
  return w;
}

function correlate(weights: number[], profile: number[], rotation: number): number {
  let score = 0;
  for (let i = 0; i < 12; i += 1) score += weights[(i + rotation) % 12] * profile[i];
  return score;
}

/**
 * The key a melody is in, or null when there is not enough of it to say.
 *
 * Confidence is how far the winner stood above the average of the alternatives,
 * because a melody of three notes fits a dozen keys equally well and saying so
 * is more use than picking one of them and sounding certain.
 */
export function keyFromNotes(notes: MelodyNote[]): MelodyKey | null {
  if (notes.length < 3) return null;
  const weights = pitchClassWeights(notes);
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;

  let best: { tonic: number; scale: ScaleName; score: number } | null = null;
  const scores: number[] = [];
  for (let tonic = 0; tonic < 12; tonic += 1) {
    const major = correlate(weights, MAJOR_PROFILE, tonic);
    const minor = correlate(weights, MINOR_PROFILE, tonic);
    scores.push(major, minor);
    if (!best || major > best.score) best = { tonic, scale: "major", score: major };
    if (!best || minor > best.score) best = { tonic, scale: "minor", score: minor };
  }
  if (!best) return null;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const confidence = best.score > 0 ? Math.max(0, Math.min(1, (best.score - mean) / best.score)) : 0;
  return { tonic: best.tonic, scale: best.scale, confidence };
}

/** The diatonic triads of a key, as pitch-class sets with their symbols. */
function diatonicTriads(key: MelodyKey): { symbol: string; tones: number[] }[] {
  const intervals = SCALE_INTERVALS[key.scale] ?? SCALE_INTERVALS.major;
  const degrees = intervals.length;
  const out: { symbol: string; tones: number[] }[] = [];
  for (let d = 0; d < degrees; d += 1) {
    const root = (key.tonic + intervals[d]) % 12;
    const third = (key.tonic + intervals[(d + 2) % degrees]) % 12;
    const fifth = (key.tonic + intervals[(d + 4) % degrees]) % 12;
    // Named from the intervals it actually has, so a diminished chord in a
    // minor key is not quietly labelled minor.
    const thirdGap = ((third - root) + 12) % 12;
    const fifthGap = ((fifth - root) + 12) % 12;
    const quality =
      thirdGap === 3 && fifthGap === 6 ? "dim" : thirdGap === 3 ? "m" : "";
    out.push({ symbol: `${NOTE_NAMES[root]}${quality}`, tones: [root, third, fifth] });
  }
  return out;
}

export interface ChordSuggestOptions {
  /** How many chords to suggest across the take. */
  segments?: number;
}

/**
 * A chord for each stretch of the melody.
 *
 * Each candidate triad is scored by how long the melody spends on its tones,
 * with the note a segment opens on counted twice: the ear takes the first note
 * of a bar as the one the chord has to agree with, and a passing note halfway
 * through matters far less than the one you land on.
 */
export function suggestChords(
  notes: MelodyNote[],
  key: MelodyKey,
  durationSec: number,
  opts: ChordSuggestOptions = {}
): string[] {
  const segments = Math.max(1, Math.floor(opts.segments ?? 4));
  if (notes.length === 0 || durationSec <= 0) return [];
  const triads = diatonicTriads(key);
  const segLen = durationSec / segments;
  const out: string[] = [];

  for (let s = 0; s < segments; s += 1) {
    const from = s * segLen;
    const to = from + segLen;
    const inSeg = notes.filter((n) => n.startSec < to && n.startSec + n.durSec > from);
    if (inSeg.length === 0) {
      // Nothing sung here: hold the previous chord rather than inventing one.
      out.push(out[out.length - 1] ?? triads[0].symbol);
      continue;
    }
    const first = inSeg.reduce((a, b) => (a.startSec <= b.startSec ? a : b));
    let bestSymbol = triads[0].symbol;
    let bestScore = -Infinity;
    for (const triad of triads) {
      let score = 0;
      for (const n of inSeg) {
        const pc = ((n.midi % 12) + 12) % 12;
        const overlap = Math.min(to, n.startSec + n.durSec) - Math.max(from, n.startSec);
        if (!triad.tones.includes(pc)) continue;
        score += Math.max(0, overlap) * (n === first ? 2 : 1);
      }
      if (score > bestScore) {
        bestScore = score;
        bestSymbol = triad.symbol;
      }
    }
    out.push(bestSymbol);
  }
  return out;
}

/** Everything the studio wants to know about a sung take, in one pass. */
export function analyzeMelody(
  samples: Float32Array,
  sampleRate: number,
  opts: { segments?: number } = {}
): MelodyAnalysis {
  const durationSec = sampleRate > 0 ? samples.length / sampleRate : 0;
  const track = pitchTrack(samples, sampleRate);
  const notes = notesFromTrack(track.hz, track.hopSec);
  const key = keyFromNotes(notes);
  const chords = key ? suggestChords(notes, key, durationSec, opts) : [];
  const range =
    notes.length > 0
      ? {
          low: Math.min(...notes.map((n) => n.midi)),
          high: Math.max(...notes.map((n) => n.midi)),
        }
      : null;
  return { notes, key, chords, range, durationSec };
}
