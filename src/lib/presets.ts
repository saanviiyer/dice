// presets.ts - pure sound-design data: the SoundConfig shape, the named preset
// "modes", and small param-mapping helpers. No Web Audio here, so it is fully
// unit-testable. The Synth consumes a SoundConfig via applyConfig().

export type Waveform = "sine" | "sawtooth" | "square" | "triangle";

export type LfoTarget = "off" | "pitch" | "filter" | "amp";

export interface EnvelopeConfig {
  attack: number; // seconds
  decay: number; // seconds
  sustain: number; // 0..1 level
  release: number; // seconds
}

export interface LfoConfig {
  rate: number; // Hz
  depth: number; // 0..1 (mapped per target)
  target: LfoTarget;
}

export interface EffectsConfig {
  reverb: { on: boolean; amount: number };
  delay: { on: boolean; time: number; feedback: number; mix: number };
  distortion: { on: boolean; amount: number };
  chorus: { on: boolean; amount: number };
}

export interface SoundConfig {
  waveform: Waveform;
  /** Unison voices per note (1..7). */
  unison: number;
  /** Unison detune spread in cents. */
  detune: number;
  /** Sub-oscillator (-1 octave) level, 0..1. */
  subLevel: number;
  env: EnvelopeConfig;
  /** Main (hand-Y) filter resonance / Q. */
  resonance: number;
  /** Per-note filter-envelope amount, 0..1 (0 = transparent). */
  filterEnvAmount: number;
  /**
   * A short burst of noise at the start of each note, 0..1.
   *
   * What tells an ear "guitar" or "piano" rather than "synth" is mostly the
   * first few milliseconds: the pick scraping the string, the hammer hitting
   * it. Oscillators and an envelope cannot make that sound, so the transient is
   * its own voice, band-passed above the note and gone in under a tenth of a
   * second. Optional, so a sound saved before instruments existed still loads.
   */
  attackNoise?: number;
  lfo: LfoConfig;
  fx: EffectsConfig;
}

/** Deep-clone a plain-data SoundConfig (so callers can mutate freely). */
export function cloneSound(cfg: SoundConfig): SoundConfig {
  return JSON.parse(JSON.stringify(cfg)) as SoundConfig;
}

const P: Record<string, SoundConfig> = {
  // Instruments first. None of these are samples - there is no sample library
  // in a 4MB web app - they are the same subtractive voice pointed at the parts
  // of a real instrument an ear actually listens for: the attack transient, how
  // fast the body decays, and how much top is left when it does.
  // Guitars. What separates one from another is mostly three things: how much
  // pick you hear, how long the note holds after it, and how hard the amp is
  // being pushed. The waveform matters less than any of them.
  "Acoustic guitar": {
    waveform: "sawtooth",
    unison: 2,
    detune: 5,
    subLevel: 0,
    // Struck, not swelled: instant attack, a long decay to almost nothing, and
    // just enough sustain that a held chord does not vanish mid-strum.
    env: { attack: 0.004, decay: 0.9, sustain: 0.06, release: 0.5 },
    resonance: 1.2,
    filterEnvAmount: 0.55,
    attackNoise: 0.35,
    lfo: { rate: 5, depth: 0, target: "off" },
    fx: {
      reverb: { on: true, amount: 0.18 },
      delay: { on: false, time: 0.3, feedback: 0.3, mix: 0.2 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: false, amount: 0.3 },
    },
  },

  "Nylon guitar": {
    waveform: "triangle",
    unison: 2,
    detune: 3,
    subLevel: 0.05,
    env: { attack: 0.006, decay: 0.8, sustain: 0.05, release: 0.45 },
    resonance: 0.9,
    filterEnvAmount: 0.4,
    // A fingertip on a nylon string is a much softer thing than a plectrum on
    // a steel one, and that is nearly the whole difference.
    attackNoise: 0.16,
    lfo: { rate: 5, depth: 0, target: "off" },
    fx: {
      reverb: { on: true, amount: 0.22 },
      delay: { on: false, time: 0.3, feedback: 0.3, mix: 0.2 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: false, amount: 0.3 },
    },
  },

  "Electric guitar": {
    waveform: "sawtooth",
    unison: 1,
    detune: 0,
    subLevel: 0.1,
    // A clean electric rings on where an acoustic has already died away.
    env: { attack: 0.004, decay: 1.4, sustain: 0.28, release: 0.6 },
    resonance: 1.5,
    filterEnvAmount: 0.35,
    attackNoise: 0.2,
    lfo: { rate: 5, depth: 0, target: "off" },
    fx: {
      reverb: { on: true, amount: 0.15 },
      delay: { on: false, time: 0.28, feedback: 0.28, mix: 0.18 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: true, amount: 0.2 },
    },
  },

  "Rock guitar": {
    waveform: "sawtooth",
    unison: 2,
    detune: 8,
    subLevel: 0.15,
    // Distortion compresses, so a driven note holds far longer than a clean one
    // and the pick matters less: the amp is doing the shouting.
    env: { attack: 0.005, decay: 1.8, sustain: 0.55, release: 0.5 },
    resonance: 2,
    filterEnvAmount: 0.25,
    attackNoise: 0.14,
    lfo: { rate: 5, depth: 0, target: "off" },
    fx: {
      reverb: { on: true, amount: 0.12 },
      delay: { on: false, time: 0.25, feedback: 0.3, mix: 0.2 },
      distortion: { on: true, amount: 0.55 },
      chorus: { on: false, amount: 0.3 },
    },
  },

  "Muted guitar": {
    waveform: "triangle",
    unison: 1,
    detune: 0,
    subLevel: 0.1,
    // A palm mute is a chunk: all attack, no ring.
    env: { attack: 0.003, decay: 0.16, sustain: 0, release: 0.12 },
    resonance: 1.5,
    filterEnvAmount: 0.5,
    attackNoise: 0.4,
    lfo: { rate: 5, depth: 0, target: "off" },
    fx: {
      reverb: { on: false, amount: 0.1 },
      delay: { on: false, time: 0.25, feedback: 0.3, mix: 0.2 },
      distortion: { on: true, amount: 0.25 },
      chorus: { on: false, amount: 0.3 },
    },
  },

  Piano: {
    waveform: "triangle",
    unison: 2,
    detune: 3,
    // The octave under carries the weight of the low strings.
    subLevel: 0.15,
    env: { attack: 0.003, decay: 1.4, sustain: 0.12, release: 0.8 },
    resonance: 0.8,
    filterEnvAmount: 0.45,
    attackNoise: 0.25,
    lfo: { rate: 5, depth: 0, target: "off" },
    fx: {
      reverb: { on: true, amount: 0.25 },
      delay: { on: false, time: 0.3, feedback: 0.3, mix: 0.2 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: false, amount: 0.3 },
    },
  },

  "E-piano": {
    waveform: "sine",
    unison: 2,
    detune: 6,
    subLevel: 0.2,
    env: { attack: 0.006, decay: 0.9, sustain: 0.25, release: 0.6 },
    resonance: 0.6,
    filterEnvAmount: 0.3,
    attackNoise: 0.12,
    lfo: { rate: 5, depth: 0, target: "off" },
    fx: {
      reverb: { on: true, amount: 0.2 },
      delay: { on: false, time: 0.3, feedback: 0.3, mix: 0.2 },
      distortion: { on: false, amount: 0.2 },
      // The wobble is most of what makes a Rhodes sound like a Rhodes.
      chorus: { on: true, amount: 0.35 },
    },
  },

  Strings: {
    waveform: "sawtooth",
    unison: 5,
    detune: 14,
    subLevel: 0.05,
    // Bowed, so it arrives rather than lands, and it holds while you hold it.
    env: { attack: 0.35, decay: 0.4, sustain: 0.85, release: 0.9 },
    resonance: 1.2,
    filterEnvAmount: 0.1,
    attackNoise: 0,
    lfo: { rate: 5.5, depth: 0.06, target: "pitch" },
    fx: {
      reverb: { on: true, amount: 0.45 },
      delay: { on: false, time: 0.3, feedback: 0.3, mix: 0.2 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: true, amount: 0.4 },
    },
  },

  "Rock organ": {
    waveform: "sine",
    unison: 3,
    detune: 5,
    subLevel: 0.5,
    env: { attack: 0.008, decay: 0.0, sustain: 1.0, release: 0.06 },
    resonance: 0.9,
    filterEnvAmount: 0,
    // The drive and the wobble together are what a rotary cabinet through a
    // pushed amp sounds like from the cheap seats.
    lfo: { rate: 6.5, depth: 0.1, target: "amp" },
    fx: {
      reverb: { on: true, amount: 0.15 },
      delay: { on: false, time: 0.3, feedback: 0.3, mix: 0.2 },
      distortion: { on: true, amount: 0.3 },
      chorus: { on: true, amount: 0.35 },
    },
  },

  "Pizzicato strings": {
    waveform: "sawtooth",
    unison: 3,
    detune: 10,
    subLevel: 0,
    env: { attack: 0.004, decay: 0.35, sustain: 0, release: 0.25 },
    resonance: 1.4,
    filterEnvAmount: 0.45,
    attackNoise: 0.25,
    lfo: { rate: 5, depth: 0, target: "off" },
    fx: {
      reverb: { on: true, amount: 0.3 },
      delay: { on: false, time: 0.3, feedback: 0.3, mix: 0.2 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: false, amount: 0.3 },
    },
  },

  Harp: {
    waveform: "triangle",
    unison: 2,
    detune: 4,
    subLevel: 0.05,
    env: { attack: 0.003, decay: 1.6, sustain: 0, release: 1.0 },
    resonance: 0.8,
    filterEnvAmount: 0.3,
    attackNoise: 0.15,
    lfo: { rate: 5, depth: 0, target: "off" },
    fx: {
      reverb: { on: true, amount: 0.4 },
      delay: { on: false, time: 0.3, feedback: 0.3, mix: 0.2 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: false, amount: 0.3 },
    },
  },

  Brass: {
    waveform: "sawtooth",
    unison: 3,
    detune: 9,
    subLevel: 0.1,
    // Brass arrives rather than lands, and it brightens as it does: the filter
    // envelope is doing most of the work here, not the oscillators.
    env: { attack: 0.07, decay: 0.5, sustain: 0.7, release: 0.35 },
    resonance: 1.1,
    filterEnvAmount: 0.75,
    attackNoise: 0.08,
    lfo: { rate: 5, depth: 0.04, target: "pitch" },
    fx: {
      reverb: { on: true, amount: 0.25 },
      delay: { on: false, time: 0.3, feedback: 0.3, mix: 0.2 },
      distortion: { on: true, amount: 0.12 },
      chorus: { on: false, amount: 0.3 },
    },
  },

  Clav: {
    waveform: "square",
    unison: 1,
    detune: 0,
    subLevel: 0,
    env: { attack: 0.002, decay: 0.3, sustain: 0.05, release: 0.2 },
    resonance: 2.5,
    filterEnvAmount: 0.6,
    attackNoise: 0.22,
    lfo: { rate: 5, depth: 0, target: "off" },
    fx: {
      reverb: { on: true, amount: 0.12 },
      delay: { on: false, time: 0.25, feedback: 0.3, mix: 0.2 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: false, amount: 0.3 },
    },
  },

  Marimba: {
    waveform: "sine",
    unison: 2,
    detune: 4,
    subLevel: 0.1,
    env: { attack: 0.002, decay: 0.5, sustain: 0.0, release: 0.35 },
    resonance: 0.8,
    filterEnvAmount: 0.35,
    attackNoise: 0.3,
    lfo: { rate: 5, depth: 0, target: "off" },
    fx: {
      reverb: { on: true, amount: 0.3 },
      delay: { on: false, time: 0.3, feedback: 0.3, mix: 0.2 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: false, amount: 0.3 },
    },
  },

  // "Basic" reproduces the original synth voice (2 saws, detune 6, simple env,
  // no effects) so first load / reset sounds like it always did.
  Basic: {
    waveform: "sawtooth",
    unison: 2,
    detune: 6,
    subLevel: 0,
    env: { attack: 0.02, decay: 0.12, sustain: 0.7, release: 0.25 },
    resonance: 0.9,
    filterEnvAmount: 0,
    lfo: { rate: 5, depth: 0, target: "off" },
    fx: {
      reverb: { on: false, amount: 0.3 },
      delay: { on: false, time: 0.3, feedback: 0.35, mix: 0.25 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: false, amount: 0.4 },
    },
  },

  "Warm Pad": {
    waveform: "sawtooth",
    unison: 3,
    detune: 12,
    subLevel: 0.1,
    env: { attack: 0.8, decay: 0.4, sustain: 0.8, release: 1.5 },
    resonance: 3,
    filterEnvAmount: 0,
    lfo: { rate: 0.3, depth: 0.15, target: "filter" },
    fx: {
      reverb: { on: true, amount: 0.4 },
      delay: { on: false, time: 0.4, feedback: 0.3, mix: 0.2 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: true, amount: 0.5 },
    },
  },

  Pluck: {
    waveform: "triangle",
    unison: 1,
    detune: 0,
    subLevel: 0,
    env: { attack: 0.005, decay: 0.18, sustain: 0.0, release: 0.15 },
    resonance: 6,
    filterEnvAmount: 0.5,
    lfo: { rate: 5, depth: 0, target: "off" },
    fx: {
      reverb: { on: true, amount: 0.15 },
      delay: { on: false, time: 0.25, feedback: 0.3, mix: 0.2 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: false, amount: 0.4 },
    },
  },

  Chiptune: {
    waveform: "square",
    unison: 1,
    detune: 0,
    subLevel: 0,
    env: { attack: 0.001, decay: 0.05, sustain: 0.6, release: 0.02 },
    resonance: 0.5,
    filterEnvAmount: 0,
    lfo: { rate: 6, depth: 0.1, target: "pitch" },
    fx: {
      reverb: { on: false, amount: 0.3 },
      delay: { on: false, time: 0.3, feedback: 0.35, mix: 0.25 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: false, amount: 0.4 },
    },
  },

  "Supersaw Lead": {
    waveform: "sawtooth",
    unison: 7,
    detune: 25,
    subLevel: 0.15,
    env: { attack: 0.02, decay: 0.2, sustain: 0.8, release: 0.3 },
    resonance: 2,
    filterEnvAmount: 0.2,
    lfo: { rate: 5, depth: 0, target: "off" },
    fx: {
      reverb: { on: true, amount: 0.2 },
      delay: { on: true, time: 0.25, feedback: 0.3, mix: 0.2 },
      distortion: { on: true, amount: 0.15 },
      chorus: { on: true, amount: 0.3 },
    },
  },

  Bell: {
    waveform: "sine",
    unison: 2,
    detune: 8,
    subLevel: 0,
    env: { attack: 0.002, decay: 1.2, sustain: 0.0, release: 1.8 },
    resonance: 1,
    filterEnvAmount: 0,
    lfo: { rate: 5, depth: 0.05, target: "pitch" },
    fx: {
      reverb: { on: true, amount: 0.5 },
      delay: { on: false, time: 0.3, feedback: 0.3, mix: 0.2 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: true, amount: 0.2 },
    },
  },

  Organ: {
    waveform: "sine",
    unison: 3,
    detune: 4,
    subLevel: 0.5,
    env: { attack: 0.01, decay: 0.0, sustain: 1.0, release: 0.08 },
    resonance: 0.7,
    filterEnvAmount: 0,
    lfo: { rate: 6, depth: 0.06, target: "amp" },
    fx: {
      reverb: { on: true, amount: 0.2 },
      delay: { on: false, time: 0.3, feedback: 0.3, mix: 0.2 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: true, amount: 0.3 },
    },
  },

  "Sub Bass": {
    waveform: "sine",
    unison: 1,
    detune: 0,
    subLevel: 0.8,
    env: { attack: 0.01, decay: 0.15, sustain: 0.7, release: 0.12 },
    resonance: 1,
    filterEnvAmount: 0.3,
    lfo: { rate: 5, depth: 0, target: "off" },
    fx: {
      reverb: { on: false, amount: 0.3 },
      delay: { on: false, time: 0.3, feedback: 0.35, mix: 0.25 },
      distortion: { on: true, amount: 0.1 },
      chorus: { on: false, amount: 0.4 },
    },
  },

  Dream: {
    waveform: "triangle",
    unison: 5,
    detune: 15,
    subLevel: 0.1,
    env: { attack: 1.2, decay: 0.6, sustain: 0.7, release: 2.5 },
    resonance: 2,
    filterEnvAmount: 0,
    lfo: { rate: 0.2, depth: 0.2, target: "filter" },
    fx: {
      reverb: { on: true, amount: 0.6 },
      delay: { on: true, time: 0.5, feedback: 0.45, mix: 0.35 },
      distortion: { on: false, amount: 0.2 },
      chorus: { on: true, amount: 0.5 },
    },
  },
};

export type PresetName = keyof typeof P & string;

export const PRESETS: Record<string, SoundConfig> = P;

export const PRESET_NAMES: string[] = Object.keys(P);

/**
 * The catalogue, split for the picker.
 *
 * "Sounds" used to be one flat list of synth patches, which is fine until you
 * are looking for a guitar: an instrument and a patch are different questions
 * and a single list answers neither. Every preset belongs to exactly one group -
 * a test holds that, so a new sound cannot quietly go missing from the picker.
 */
export const PRESET_GROUPS: { label: string; names: string[] }[] = [
  {
    label: "Guitars",
    names: [
      "Acoustic guitar",
      "Nylon guitar",
      "Electric guitar",
      "Rock guitar",
      "Muted guitar",
    ],
  },
  { label: "Keys", names: ["Piano", "E-piano", "Clav", "Organ", "Rock organ"] },
  {
    label: "Strings, brass & mallets",
    names: ["Strings", "Pizzicato strings", "Brass", "Harp", "Marimba", "Bell"],
  },
  {
    label: "Synths",
    names: ["Basic", "Warm Pad", "Pluck", "Chiptune", "Supersaw Lead", "Sub Bass", "Dream"],
  },
];

/**
 * Names that used to mean something and still should.
 *
 * The sound someone picked is remembered by name, so renaming one would leave
 * them on Basic the next time they opened the app with no idea why. "Guitar"
 * became a family of five; the plain name still resolves to the one it meant.
 */
const ALIASES: Record<string, string> = { Guitar: "Acoustic guitar" };

/** The current name for a preset, following any rename. */
export function resolvePresetName(name: string): string {
  return ALIASES[name] ?? name;
}

/** Return a fresh, mutable copy of a preset (falls back to Basic). */
export function getPreset(name: string): SoundConfig {
  const p = P[resolvePresetName(name)] ?? P.Basic;
  return cloneSound(p);
}

export const DEFAULT_PRESET = "Basic";

/** The default sound (a copy, so it can be mutated). */
export function defaultSound(): SoundConfig {
  return getPreset(DEFAULT_PRESET);
}

/**
 * Unison detune offsets (cents) for `count` voices spread symmetrically over
 * `spread` cents. 1 voice -> [0]; N voices span [-spread/2, +spread/2].
 */
export function unisonDetunes(count: number, spread: number): number[] {
  const n = Math.max(1, Math.floor(count));
  if (n === 1) return [0];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push((i / (n - 1) - 0.5) * spread);
  }
  return out;
}
