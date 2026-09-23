// transcribe.ts - turning a mouth sound into a structured beat.
//
// Beatbox at dice and it writes the pattern into the step sequencer. The point
// is not to keep your recording, it is to work out what you *meant* and hand
// you an editable grid: kick on 1 and 3, snare on 2 and 4, hats on the
// offbeats, at your tempo, quantised to the grid the project already uses.
//
// Four stages, each of which can be inspected on its own:
//
//   1. onsets   - where the hits are, from spectral flux (see ears.ts)
//   2. voices   - what each hit is, from the timbre of the 120 ms after it
//   3. grid     - the tempo and the downbeat the hits imply
//   4. pattern  - hits snapped onto that grid, as a DrumPattern
//
// Everything is pure and synchronous, so the whole transcriber is testable in
// Node against synthesised beatboxing.

import {
  ANALYSIS_CEILING_HZ,
  analyzeSpectrum,
  estimateTempo,
  fft,
  frameSizeFor,
  hann,
  peak,
  rms,
  type Spectrum,
} from "./ears";
import { GHOST, MAX_PATTERN_BARS, type DrumPattern } from "./drums";

/**
 * The voices dice will transcribe into.
 *
 * Deliberately four, not six. A mouth kick, a mouth snare, a hi-hat and a low
 * tom are reliably distinguishable by timbre. A clap and a snare are not: both
 * are a broadband noise burst in the same register, and the difference in a
 * real kit is the room and the layering rather than anything measurable in a
 * beatboxed impression. Guessing between them would put hits in the wrong lane
 * and look like a bug, so those two lanes are left for the user to fill in.
 */
export type TranscribedVoice = "kick" | "snare" | "hat" | "tom";

export const TRANSCRIBED_VOICES: TranscribedVoice[] = ["kick", "snare", "hat", "tom"];

/** What one hit sounded like. */
export interface HitFeatures {
  centroidHz: number;
  /** Share of energy below 250 Hz. */
  lowShare: number;
  /** Share of energy above 6 kHz. */
  airShare: number;
  /** 0 tonal, 1 noise-like. */
  flatness: number;
  /**
   * Energy in the 30-120 ms tail relative to the first 30 ms. Low means a
   * closed hat or a tight snare; high means a kick or a tom ringing on.
   */
  tailRatio: number;
  peak: number;
}

export interface Hit {
  timeSec: number;
  voice: TranscribedVoice;
  /** 0..1, from the hit's peak relative to the loudest hit. */
  velocity: number;
  /** 0..1. Low means the timbre sat between two voices. */
  confidence: number;
  features: HitFeatures;
}

export interface Transcription {
  hits: Hit[];
  bpm: number;
  /** Whether the tempo was measured or supplied by the caller. */
  bpmSource: "measured" | "given" | "assumed";
  /** Seconds from the start of the recording to the first downbeat. */
  phaseSec: number;
  bars: number;
  pattern: DrumPattern;
  /** Hits that were dropped because two landed on the same step of one lane. */
  collapsed: number;
  /** Things the user should know about this transcription, in plain words. */
  notes: string[];
}

export interface TranscribeOptions {
  /** Use the project's tempo instead of measuring one. */
  bpm?: number;
  /** Grid resolution. 4 = sixteenths (the default), 2 = eighths. */
  stepsPerBeat?: number;
  /** Beats per bar. */
  beatsPerBar?: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** The tempo range people actually count a groove in. */
const TEMPO_LO = 75;
const TEMPO_HI = 150;

/**
 * Fold a tempo into the range a groove is normally counted in.
 *
 * Any periodic signal correlates just as well at half and at double its tempo,
 * and someone beatboxing eighth notes produces an onset stream whose strongest
 * period is the eighth, not the beat. Left alone, a 96 BPM groove reports as
 * 192. Halving or doubling into a preferred range is the standard fix and is
 * what a listener does automatically.
 */
export function foldTempo(bpm: number, lo = TEMPO_LO, hi = TEMPO_HI): number {
  if (!(bpm > 0) || !Number.isFinite(bpm)) return 100;
  let out = bpm;
  for (let i = 0; i < 8 && out > hi; i += 1) out /= 2;
  for (let i = 0; i < 8 && out < lo; i += 1) out *= 2;
  return Math.round(out * 10) / 10;
}

// ---------------------------------------------------------------------------
// Stage 1: where are the hits?
// ---------------------------------------------------------------------------

/**
 * Onset window, in seconds. Sample-rate relative for the same reason the
 * spectrum's is: 1024 samples is 46 ms at 22 kHz and 21 ms at 48 kHz, and a
 * 21 ms window barely contains one cycle of a kick.
 */
const ONSET_FRAME_SEC = 0.046;

/**
 * The three registers a drum hit can announce itself in.
 *
 * Onsets are detected in each separately and then merged, because a single
 * broadband flux curve is dominated by whichever voice is loudest. Beatbox a
 * kick under a hat pattern and the kick contributes a few percent of the total
 * flux: against one global threshold it is invisible, and the transcription
 * silently loses the part of the groove that matters most.
 */
const ONSET_BANDS: Array<[number, number]> = [
  [20, 250],
  [250, 6000],
  [6000, 10000],
];

/** Per-frame flux in each register, plus the frame rate. */
export function bandFlux(
  data: Float32Array,
  sampleRate: number
): { flux: Float32Array[]; frameHz: number } {
  const FRAME = frameSizeFor(sampleRate, ONSET_FRAME_SEC);
  const HOP = FRAME / 4;
  const half = FRAME / 2;
  const binHz = sampleRate / FRAME;
  const win = hann(FRAME);
  const frames = Math.max(0, Math.floor((data.length - FRAME) / HOP) + 1);

  const top = Math.min(half - 1, Math.floor(ANALYSIS_CEILING_HZ / binHz));
  const ranges = ONSET_BANDS.map(([lo, hi]) => [
    Math.max(1, Math.floor(lo / binHz)),
    Math.min(top, Math.ceil(hi / binHz)),
  ]);

  const prev = ONSET_BANDS.map(() => new Float32Array(half));
  const flux = ONSET_BANDS.map(() => new Float32Array(Math.max(0, frames - 1)));
  const mags = new Float32Array(half);
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);

  for (let f = 0; f < frames; f += 1) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i += 1) {
      re[i] = data[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < half; b += 1) mags[b] = Math.hypot(re[b], im[b]);

    if (f > 0) {
      ranges.forEach(([lo, hi], k) => {
        let sum = 0;
        for (let b = lo; b <= hi; b += 1) {
          const d = mags[b] - prev[k][b];
          if (d > 0) sum += d;
        }
        flux[k][f - 1] = sum;
      });
    }
    ranges.forEach(([lo, hi], k) => {
      for (let b = lo; b <= hi; b += 1) prev[k][b] = mags[b];
    });
  }

  return { flux, frameHz: sampleRate / HOP };
}

/**
 * Peak-pick one flux curve against a *local* threshold.
 *
 * The threshold is the median of a moving window rather than the mean of the
 * whole signal. A median ignores the peaks themselves, so a busy passage does
 * not raise the bar for the quiet passage next to it, and a groove that gets
 * louder halfway through still transcribes evenly.
 */
export interface FluxPeak {
  /** Frame index of the peak. */
  index: number;
  /** Flux at the peak, relative to the loudest in this band. 0..1. */
  strength: number;
}

export function pickPeaks(flux: Float32Array, frameHz: number, sensitivity = 1.5): FluxPeak[] {
  if (flux.length < 3) return [];
  let globalMax = 0;
  for (let i = 0; i < flux.length; i += 1) if (flux[i] > globalMax) globalMax = flux[i];
  if (!(globalMax > 0)) return [];

  const w = Math.max(2, Math.round(frameHz * 0.15));
  const refractory = Math.max(1, Math.round(frameHz * 0.04));

  // The absolute floor is set from the quiet parts, not from the loudest hit.
  // A floor at some fraction of the peak looks reasonable and quietly throws
  // away every soft hit in a groove with real dynamics: ghost notes on a snare
  // are an order of magnitude below the backbeat and are still notes. The 20th
  // percentile is what the signal does between hits, which is the thing a hit
  // actually has to stand out from.
  const sorted = Array.from(flux).sort((a, b) => a - b);
  const quiet = sorted[Math.floor(sorted.length * 0.2)];
  const floor = quiet * 3 + globalMax * 0.02;

  const out: FluxPeak[] = [];
  let last = -refractory;
  const scratch: number[] = [];
  for (let i = 1; i < flux.length - 1; i += 1) {
    if (flux[i] < floor) continue;
    if (flux[i] < flux[i - 1] || flux[i] <= flux[i + 1]) continue;
    if (i - last < refractory) continue;

    scratch.length = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(flux.length - 1, i + w); j += 1) {
      scratch.push(flux[j]);
    }
    scratch.sort((a, b) => a - b);
    const median = scratch[Math.floor(scratch.length / 2)];
    if (flux[i] > median * sensitivity + floor * 0.5) {
      out.push({ index: i, strength: flux[i] / globalMax });
      last = i;
    }
  }
  return out;
}

/** How close two detections have to be to count as one layered hit. */
const MERGE_SEC = 0.05;
/**
 * A detection this soon after a louder one, and this much weaker, is that hit's
 * tail rather than a new hit. 90 ms is longer than the merge window but still
 * shorter than a sixteenth at any sane tempo.
 */
const TAIL_SEC = 0.09;
const TAIL_RATIO = 0.4;

/**
 * The times of the hits in a recording, in seconds.
 *
 * Detects in each register independently and merges anything within 50 ms into
 * one hit, which is roughly the point below which two drum sounds read as one
 * layered hit rather than two events.
 *
 * It then drops detections that are really the decay of the hit before them: a
 * snare's noise tail and a kick's long fundamental both produce a second, much
 * weaker flux peak 50 to 90 ms later, which would otherwise land on the grid as
 * a phantom sixteenth right after every backbeat. A blanket wider merge window
 * cannot do this job, because a genuine sixteenth at 220 BPM is only 68 ms
 * away; what separates a tail from a real hit is that a tail is much quieter
 * than what produced it.
 *
 * The half-frame offset matters: a flux value at frame i describes the change
 * between frames i and i+1, and each frame is centred half a window after its
 * own start, so the transient it reports sits a frame and a half in. Without
 * the correction every hit lands early and quantising drifts a whole sixteenth.
 */
export function detectHits(data: Float32Array, sampleRate: number): number[] {
  const { flux, frameHz } = bandFlux(data, sampleRate);
  const hopSec = 1 / frameHz;
  const offsetSec = 1.5 * hopSec;

  const all: FluxPeak[] = [];
  for (const curve of flux) {
    for (const peak of pickPeaks(curve, frameHz)) {
      all.push({ index: peak.index * hopSec + offsetSec, strength: peak.strength });
    }
  }
  all.sort((a, b) => a.index - b.index);

  // Merge simultaneous detections across the three registers, keeping the
  // loudest as that hit's strength.
  const merged: FluxPeak[] = [];
  for (const p of all) {
    const last = merged[merged.length - 1];
    if (last && p.index - last.index <= MERGE_SEC) {
      last.strength = Math.max(last.strength, p.strength);
    } else {
      merged.push({ ...p });
    }
  }

  // Then drop the tails.
  const kept: FluxPeak[] = [];
  for (const p of merged) {
    const last = kept[kept.length - 1];
    if (last && p.index - last.index < TAIL_SEC && p.strength < last.strength * TAIL_RATIO) {
      continue;
    }
    kept.push(p);
  }
  return kept.map((p) => p.index);
}

// ---------------------------------------------------------------------------
// Stage 2: what is this hit?
// ---------------------------------------------------------------------------

/** Measure the timbre of the window that starts at a hit. */
export function hitFeatures(
  data: Float32Array,
  sampleRate: number,
  startSec: number
): HitFeatures {
  const start = Math.max(0, Math.round(startSec * sampleRate));
  const windowLen = Math.round(sampleRate * 0.12);
  const slice = data.subarray(start, Math.min(data.length, start + windowLen));

  // analyzeSpectrum needs a full frame; pad a short tail with silence rather
  // than skipping the hit, which would silently drop the last note of a take.
  const need = frameSizeFor(sampleRate);
  const padded =
    slice.length >= need
      ? slice
      : (() => {
          const out = new Float32Array(need);
          out.set(slice);
          return out;
        })();

  const spec = analyzeSpectrum(padded, sampleRate);
  const headLen = Math.round(sampleRate * 0.03);
  const head = slice.subarray(0, Math.min(slice.length, headLen));
  const tail = slice.subarray(Math.min(slice.length, headLen));
  const headRms = rms(head);
  const tailRms = rms(tail);

  return {
    centroidHz: spec.centroidHz,
    lowShare: spec.bands[0] + spec.bands[1],
    airShare: spec.bands[5],
    flatness: spec.flatness,
    tailRatio: headRms > 0 ? tailRms / headRms : 0,
    peak: peak(slice),
  };
}

/**
 * Decide which voice a hit is, and how sure that is.
 *
 * Scored rather than branched: every voice gets a score from the features, the
 * best one wins, and the gap to the runner-up becomes the confidence.
 *
 * The weights lean on the two features that actually separate mouth sounds,
 * which are not the obvious ones. **Tail** is the strongest: a snare rings for
 * a moment and a hi-hat is gone almost instantly, so the energy 30 to 120 ms
 * after the transient tells them apart even when both are bright noise.
 * **Air share** is the second: a hat puts most of its energy above 6 kHz, a
 * snare a fraction of that. Centroid alone is a poor discriminator, because a
 * real mouth snare lands anywhere from 2 to 6 kHz depending on the person and
 * the microphone.
 *
 * Tonality separates the pitched voices from the noisy ones: a tom and a kick
 * are near-sine, a snare and a hat are near-noise, so flatness carries real
 * weight in both directions.
 */
export function classifyHit(f: HitFeatures): { voice: TranscribedVoice; confidence: number } {
  const scores: Record<TranscribedVoice, number> = {
    // A mouth kick: nearly all the energy at the bottom, tonal, with a tail.
    kick: 2.6 * f.lowShare + 1.4 * clamp01((320 - f.centroidHz) / 320) - 1.2 * f.flatness,
    // A mouth snare: broadband noise in the middle that rings for a moment.
    snare:
      1.4 * f.flatness +
      1.6 * clamp01(1 - Math.abs(f.centroidHz - 3800) / 3800) +
      1.8 * clamp01(f.tailRatio * 2.5) -
      1.4 * f.lowShare -
      1.6 * f.airShare,
    // A hat: right at the top, noisy, and gone almost immediately.
    hat:
      2.4 * f.airShare +
      1.2 * clamp01((f.centroidHz - 5000) / 5000) +
      1.8 * clamp01(1 - f.tailRatio * 4) -
      0.6 * f.lowShare,
    // A tom: pitched like a kick but higher, and it rings.
    tom:
      1.7 * clamp01(1 - Math.abs(f.centroidHz - 420) / 420) +
      1.0 * clamp01(f.tailRatio) +
      1.6 * (1 - f.flatness) -
      0.8 * clamp01((f.lowShare - 0.7) * 3),
  };

  const ranked = TRANSCRIBED_VOICES.map((v) => ({ v, s: scores[v] })).sort((a, b) => b.s - a.s);
  const gap = ranked[0].s - ranked[1].s;
  return {
    voice: ranked[0].v,
    // A one-point gap is a clear call; anything under that is a judgement.
    confidence: clamp01(gap),
  };
}

// ---------------------------------------------------------------------------
// Stage 3: what grid are these hits on?
// ---------------------------------------------------------------------------

/**
 * A tempo for these onsets.
 *
 * Prefers the caller's tempo, because a beat transcribed against the project's
 * own BPM will line up with everything else in the session, and a measured
 * tempo that is 3 BPM off will not. Falls back to the flux autocorrelation, and
 * then to the median gap between hits read as an eighth note, which is what a
 * person beatboxing a simple groove actually produces.
 */
export function inferTempo(
  spec: Spectrum,
  onsets: number[],
  given?: number
): { bpm: number; source: Transcription["bpmSource"] } {
  if (given && given > 20 && given < 300) return { bpm: given, source: "given" };

  const measured = estimateTempo(spec);
  if (measured) return { bpm: foldTempo(measured), source: "measured" };

  if (onsets.length >= 3) {
    const gaps = [];
    for (let i = 1; i < onsets.length; i += 1) gaps.push(onsets[i] - onsets[i - 1]);
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    if (median > 0.05) {
      // Read the typical gap as an eighth note, then fold into range.
      return { bpm: foldTempo(30 / median), source: "assumed" };
    }
  }
  return { bpm: 100, source: "assumed" };
}

/**
 * Where beat one is.
 *
 * Anchored on the first hit rather than searched for. A recording of someone
 * beatboxing starts when they start, and the thing they hit first is beat one:
 * that is both what they meant and the only reading they can predict. Searching
 * every sub-position of a bar for the lowest quantisation error instead finds
 * alignments that are numerically better and musically wrong, because any two
 * offsets a whole step apart score identically.
 *
 * The anchor is then nudged by up to half a step to minimise the weighted grid
 * error across the remaining hits, so one slightly early first hit does not
 * drag the whole pattern along with it.
 */
export function inferPhase(
  onsets: number[],
  velocities: number[],
  stepSec: number,
  _stepsPerBar: number
): number {
  if (onsets.length === 0) return 0;
  const anchor = onsets[0];
  if (onsets.length === 1) return anchor;

  let best = anchor;
  let bestCost = Infinity;
  const tries = 21;
  for (let i = 0; i < tries; i += 1) {
    const phase = anchor + (i / (tries - 1) - 0.5) * stepSec;
    let cost = 0;
    onsets.forEach((t, k) => {
      const rel = (t - phase) / stepSec;
      cost += Math.abs(rel - Math.round(rel)) * (velocities[k] ?? 1);
    });
    if (cost < bestCost) {
      bestCost = cost;
      best = phase;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Stage 4: the pattern
// ---------------------------------------------------------------------------

function emptyLanes(steps: number): DrumPattern {
  return {
    kick: new Array(steps).fill(0),
    snare: new Array(steps).fill(0),
    clap: new Array(steps).fill(0),
    hat: new Array(steps).fill(0),
    tom: new Array(steps).fill(0),
    shaker: new Array(steps).fill(0),
  };
}

/**
 * Transcribe a recording of beatboxing into an editable drum pattern.
 *
 * Returns the hits it heard as well as the grid it snapped them to, so the
 * panel can tell the user what it did rather than just handing over a pattern
 * that appeared from nowhere.
 */
export function transcribeBeatbox(
  data: Float32Array,
  sampleRate: number,
  opts: TranscribeOptions = {}
): Transcription {
  const stepsPerBeat = opts.stepsPerBeat ?? 4;
  const beatsPerBar = opts.beatsPerBar ?? 4;
  const stepsPerBar = stepsPerBeat * beatsPerBar;
  const notes: string[] = [];

  const spec = analyzeSpectrum(data, sampleRate);
  const onsets = detectHits(data, sampleRate);

  if (onsets.length === 0) {
    notes.push("I could not hear any distinct hits in that.");
    return {
      hits: [],
      bpm: opts.bpm ?? 100,
      bpmSource: opts.bpm ? "given" : "assumed",
      phaseSec: 0,
      bars: 1,
      pattern: emptyLanes(stepsPerBar),
      collapsed: 0,
      notes,
    };
  }

  // Stage 2.
  const raw = onsets.map((t) => {
    const f = hitFeatures(data, sampleRate, t);
    const { voice, confidence } = classifyHit(f);
    return { timeSec: t, voice, confidence, features: f };
  });

  const loudest = Math.max(...raw.map((h) => h.features.peak), 1e-6);
  const hits: Hit[] = raw.map((h) => ({
    ...h,
    velocity: clamp01(h.features.peak / loudest),
  }));

  // Stage 3.
  const { bpm, source } = inferTempo(
    spec,
    hits.map((h) => h.timeSec),
    opts.bpm
  );
  const stepSec = 60 / bpm / stepsPerBeat;
  const phaseSec = inferPhase(
    hits.map((h) => h.timeSec),
    hits.map((h) => h.velocity),
    stepSec,
    stepsPerBar
  );

  // Stage 4.
  const lastStep = Math.max(
    0,
    ...hits.map((h) => Math.round((h.timeSec - phaseSec) / stepSec))
  );
  const bars = Math.min(MAX_PATTERN_BARS, Math.max(1, Math.ceil((lastStep + 1) / stepsPerBar)));
  const totalSteps = bars * stepsPerBar;
  const pattern = emptyLanes(totalSteps);

  let collapsed = 0;
  let dropped = 0;
  for (const h of hits) {
    const step = Math.round((h.timeSec - phaseSec) / stepSec);
    if (step < 0 || step >= totalSteps) {
      dropped += 1;
      continue;
    }
    const lane = pattern[h.voice];
    if (lane[step] > 0) collapsed += 1;
    // Keep the velocity that was actually played. A beatboxed groove is mostly
    // dynamics, and flattening every hit to full is what makes a transcription
    // sound like a drum machine instead of like the person who played it.
    lane[step] = Math.max(lane[step], Math.max(GHOST, h.velocity));
  }

  if (source === "assumed") {
    notes.push(
      `I could not lock onto a clear tempo, so I read it as about ${Math.round(bpm)} BPM.`
    );
  }
  if (collapsed > 0) {
    notes.push(
      `${collapsed} hit${collapsed === 1 ? "" : "s"} landed on a step that was already taken, so ${
        collapsed === 1 ? "it" : "they"
      } merged.`
    );
  }
  if (dropped > 0) {
    notes.push(
      `${dropped} hit${dropped === 1 ? "" : "s"} fell outside ${bars} bar${
        bars === 1 ? "" : "s"
      } and did not make it in.`
    );
  }
  const unsure = hits.filter((h) => h.confidence < 0.25).length;
  if (unsure > 0) {
    notes.push(
      `${unsure} hit${unsure === 1 ? " was" : "s were"} between two sounds, so check ${
        unsure === 1 ? "that one" : "those"
      } in the grid.`
    );
  }

  return {
    hits,
    bpm: Math.round(bpm * 10) / 10,
    bpmSource: source,
    phaseSec,
    bars,
    pattern,
    collapsed,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Saying it out loud
// ---------------------------------------------------------------------------

const VOICE_LABEL: Record<TranscribedVoice, string> = {
  kick: "kick",
  snare: "snare",
  hat: "hat",
  tom: "tom",
};

/**
 * Where a lane's hits fall, in the language a musician uses: "1 and 3", "the
 * offbeats", "every 16th". Positions are counted in beats from the downbeat.
 */
export function describeLane(lane: number[], stepsPerBeat: number, beatsPerBar: number): string {
  const steps = lane.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  if (steps.length === 0) return "";

  const stepsPerBar = stepsPerBeat * beatsPerBar;
  const onBeat = steps.every((s) => s % stepsPerBeat === 0);
  const offBeat = steps.every((s) => s % stepsPerBeat === stepsPerBeat / 2);

  if (onBeat && steps.length === stepsPerBar / stepsPerBeat * (lane.length / stepsPerBar)) {
    return "on every beat";
  }
  if (offBeat) return "on the offbeats";
  if (steps.length === lane.length) return "on every step";

  if (onBeat) {
    const beats = [...new Set(steps.map((s) => ((s / stepsPerBeat) % beatsPerBar) + 1))].sort(
      (a, b) => a - b
    );
    if (beats.length === 1) return `on ${beats[0]}`;
    return `on ${beats.slice(0, -1).join(", ")} and ${beats[beats.length - 1]}`;
  }
  return `${steps.length} hits`;
}

/** The transcription as a sentence, for the chat panel to say back. */
export function describeTranscription(
  t: Transcription,
  stepsPerBeat = 4,
  beatsPerBar = 4
): string {
  if (t.hits.length === 0) return "I could not hear any distinct hits in that.";

  const parts: string[] = [];
  for (const voice of TRANSCRIBED_VOICES) {
    const where = describeLane(t.pattern[voice], stepsPerBeat, beatsPerBar);
    if (where) parts.push(`${VOICE_LABEL[voice]} ${where}`);
  }

  const tempo =
    t.bpmSource === "given"
      ? `at your ${Math.round(t.bpm)} BPM`
      : `at about ${Math.round(t.bpm)} BPM`;
  const shape = `${t.bars} bar${t.bars === 1 ? "" : "s"} ${tempo}`;

  if (parts.length === 0) return `I heard ${t.hits.length} hits over ${shape}.`;
  return `I heard ${shape}: ${parts.join(", ")}.`;
}


// ---------------------------------------------------------------------------
// Smart tempo
// ---------------------------------------------------------------------------

export interface TempoReading {
  bpm: number;
  /**
   * 0..1. How much of the spectrum moves frame to frame, which is what tells a
   * played part from a held one. Below `PULSE_FLOOR` there is no pulse to read.
   */
  strength: number;
  /** How many transients it found, and over how long. */
  hits: number;
  seconds: number;
  /** True when the reading is worth acting on. */
  usable: boolean;
}

/**
 * Read the tempo of a recording, the way Logic's Smart Tempo does: play
 * something in freely, and let the project take its tempo from the performance
 * rather than making the performance chase a click.
 *
 * Conservative on purpose. It reports `usable: false` rather than a number it
 * does not believe, because silently retuning a whole project to a wrong tempo
 * is far worse than saying nothing: every part already recorded would end up
 * fighting a grid that moved under it.
 */
export function readTempo(data: Float32Array, sampleRate: number): TempoReading {
  const seconds = sampleRate > 0 ? data.length / sampleRate : 0;
  const spec = analyzeSpectrum(data, sampleRate);
  const hits = detectHits(data, sampleRate).length;
  const measured = estimateTempo(spec);
  const bpm = measured != null ? foldTempo(measured) : 0;

  return {
    bpm,
    strength: Math.round(spec.fluxRatio * 1000) / 1000,
    hits,
    seconds: Math.round(seconds * 10) / 10,
    // Four hits over at least two seconds is the least that can establish a
    // pulse; below that a "tempo" is an accident of two transients.
    usable: bpm > 0 && hits >= 4 && seconds >= 2,
  };
}

/** Why a tempo reading was rejected, in words. */
export function explainTempo(r: TempoReading): string {
  if (r.usable) return `about ${Math.round(r.bpm)} BPM from ${r.hits} hits.`;
  if (r.seconds < 2) return "That is too short to read a tempo from.";
  if (r.hits < 4) return "I could not hear enough distinct hits to find a pulse.";
  return "There is no steady pulse in that, so I would only be guessing.";
}
