// ears.ts - what the dice producer agent hears.
//
// The agent is a perception/action loop, and this file is the perception half.
// It turns raw mixer audio into numbers a producer would actually reason about:
// how loud each part is, where it sits in the spectrum, how busy it is, whether
// two parts are fighting for the same frequencies, and whether the stereo field
// is lopsided.
//
// Everything here is pure and synchronous: it takes Float32Array sample data
// and returns plain objects. No Web Audio, no DOM, no network, so the whole
// perception layer is unit-testable in Node.

// ---------------------------------------------------------------------------
// FFT (iterative radix-2 Cooley-Tukey, in place)
// ---------------------------------------------------------------------------

/**
 * In-place complex FFT. `re` and `im` must be the same power-of-two length.
 * Small and dependency-free; a 2048-point transform is well under a millisecond
 * and the agent only runs a few hundred of them per analysis pass.
 */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if (n !== im.length) throw new Error("fft: re/im length mismatch");
  if (n === 0 || (n & (n - 1)) !== 0) throw new Error("fft: length must be a power of two");

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + len / 2];
        const bi = im[i + k + len / 2];
        const tr = br * cr - bi * ci;
        const ti = br * ci + bi * cr;
        re[i + k] = ar + tr;
        im[i + k] = ai + ti;
        re[i + k + len / 2] = ar - tr;
        im[i + k + len / 2] = ai - ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Periodic Hann window of length n. */
export function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

// ---------------------------------------------------------------------------
// Level helpers
// ---------------------------------------------------------------------------

/** Full-scale decibels. Silence floors at -120 rather than -Infinity. */
export function dbfs(amplitude: number): number {
  if (!(amplitude > 0)) return -120;
  return Math.max(-120, 20 * Math.log10(amplitude));
}

/** Root-mean-square amplitude of a signal. */
export function rms(x: Float32Array): number {
  if (x.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < x.length; i += 1) sum += x[i] * x[i];
  return Math.sqrt(sum / x.length);
}

/** Absolute peak amplitude. */
export function peak(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i += 1) {
    const a = Math.abs(x[i]);
    if (a > p) p = a;
  }
  return p;
}

/**
 * Loudness of the parts that are actually playing, in dBFS.
 *
 * A plain RMS over a whole take reads far too quiet, because the silence
 * between phrases drags the average down and a sparse vocal then looks buried
 * next to a continuous pad. This gates to the frames above a relative threshold
 * before averaging, which is the idea behind gated loudness measurement and is
 * what makes level comparisons between a vocal and a pad meaningful.
 */
export function gatedLoudnessDb(x: Float32Array, sampleRate: number): number {
  const block = Math.max(1, Math.round(sampleRate * 0.4));
  const hop = Math.max(1, Math.round(block / 4));
  const powers: number[] = [];
  for (let start = 0; start + block <= x.length; start += hop) {
    let sum = 0;
    for (let i = start; i < start + block; i += 1) sum += x[i] * x[i];
    powers.push(sum / block);
  }
  if (powers.length === 0) return dbfs(rms(x));

  const ungated = powers.reduce((a, b) => a + b, 0) / powers.length;
  if (!(ungated > 0)) return -120;
  // Relative gate 10 dB below the ungated mean, the same shape as the
  // relative gate in a loudness meter.
  const gate = ungated * Math.pow(10, -10 / 10);
  const kept = powers.filter((p) => p >= gate);
  const mean = kept.length > 0 ? kept.reduce((a, b) => a + b, 0) / kept.length : ungated;
  return dbfs(Math.sqrt(mean));
}

// ---------------------------------------------------------------------------
// Spectrum
// ---------------------------------------------------------------------------

/**
 * Band edges in Hz. Six bands, named the way a producer names them, because the
 * agent's explanations are written in these terms.
 */
export const BAND_EDGES = [0, 60, 250, 500, 2000, 6000, 10000] as const;

/**
 * The top of the analysis band.
 *
 * Fixed, and deliberately below the Nyquist of every rate this has to handle.
 * Band shares are fractions of the total, so letting the top band run to
 * Nyquist made every feature depend on the recording's sample rate: the same
 * snare measured at 48 kHz has an air band far wider than at 22 kHz, its share
 * inflates, and it classifies as a hi-hat. Ten kilohertz sits under 22 kHz's
 * Nyquist of 11 kHz, so the analysed band is now identical for every recording.
 *
 * It also makes the features robust to things outside our control: Opus, which
 * is what MediaRecorder produces, low-passes somewhere above this depending on
 * bitrate, and cheap microphones roll off early. A hi-hat is still obvious from
 * its 6 to 10 kHz energy, so nothing that matters is lost.
 */
export const ANALYSIS_CEILING_HZ = 10000;
export const BAND_NAMES = ["sub", "low", "low-mid", "mid", "high-mid", "air"] as const;
export type BandName = (typeof BAND_NAMES)[number];

export interface Spectrum {
  /** Average magnitude per FFT bin (first half only). */
  mags: Float32Array;
  /** Hz per bin. */
  binHz: number;
  /** Energy share per band, sums to 1 (all zero for silence). */
  bands: number[];
  centroidHz: number;
  /** Wiener entropy, 0 = tonal, 1 = noise-like. */
  flatness: number;
  /** Per-frame spectral flux, used for onsets and tempo. */
  flux: Float32Array;
  fluxHz: number;
  /**
   * Mean flux as a fraction of the average per-frame spectral magnitude: how
   * much of the spectrum actually changes frame to frame.
   *
   * This is the transient gate, and it earns its place. Spectral flux is a
   * relative measure, so a sustained tone still produces a flux signal (window
   * beating against the hop), and thresholding it relative to its own mean will
   * happily report onsets and a tempo for a held pad. The ratio is absolute:
   * a drum loop sits near 0.5, a sung line near 0.03, a held sine near zero.
   */
  fluxRatio: number;
}

/**
 * Analysis window length, in seconds rather than samples.
 *
 * A window fixed in samples is a different length in time at every sample rate:
 * 2048 samples is 93 ms at 22 kHz but only 43 ms at 48 kHz, which halves the
 * frequency resolution exactly where a kick lives. Deriving the window from the
 * rate keeps the time and frequency resolution the same for every recording.
 */
const FRAME_SEC = 0.093;
/** Cap on analysed frames, so a five-minute stem still analyses instantly. */
const MAX_FRAMES = 600;

/** Nearest power of two to `n`, which the FFT requires. */
export function pow2Near(n: number, min = 256, max = 8192): number {
  const p = Math.pow(2, Math.round(Math.log2(Math.max(1, n))));
  return Math.max(min, Math.min(max, p));
}

/** The FFT size to analyse a signal at this sample rate with. */
export function frameSizeFor(sampleRate: number, seconds = FRAME_SEC): number {
  return pow2Near(sampleRate * seconds);
}

/** Average magnitude spectrum, band split, centroid, flatness and flux. */
export function analyzeSpectrum(x: Float32Array, sampleRate: number): Spectrum {
  const FRAME = frameSizeFor(sampleRate);
  const HOP = FRAME / 4;
  const half = FRAME / 2;
  const binHz = sampleRate / FRAME;
  // Never look above the ceiling, so band shares mean the same thing at every
  // sample rate.
  const topBin = Math.min(half - 1, Math.floor(ANALYSIS_CEILING_HZ / binHz));
  const mags = new Float32Array(half);
  const win = hann(FRAME);

  const total = Math.max(0, Math.floor((x.length - FRAME) / HOP) + 1);
  // Stride over the file rather than truncating it, so the analysis describes
  // the whole take and not just its first few seconds.
  const stride = total > MAX_FRAMES ? Math.ceil(total / MAX_FRAMES) : 1;
  const frames: Float32Array[] = [];

  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  let count = 0;
  for (let f = 0; f < total; f += stride) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i += 1) {
      re[i] = x[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const frame = new Float32Array(half);
    for (let b = 0; b < half; b += 1) {
      const m = Math.hypot(re[b], im[b]);
      frame[b] = m;
      mags[b] += m;
    }
    frames.push(frame);
    count += 1;
  }
  if (count > 0) for (let b = 0; b < half; b += 1) mags[b] /= count;

  // Spectral flux: half-wave rectified frame-to-frame increase.
  const flux = new Float32Array(Math.max(0, frames.length - 1));
  for (let f = 1; f < frames.length; f += 1) {
    let sum = 0;
    for (let b = 0; b <= topBin; b += 1) {
      const d = frames[f][b] - frames[f - 1][b];
      if (d > 0) sum += d;
    }
    flux[f - 1] = sum;
  }

  // Band energies (power), normalised to shares.
  const bands = new Array(BAND_NAMES.length).fill(0);
  let totalPower = 0;
  for (let b = 1; b <= topBin; b += 1) {
    const hz = b * binHz;
    const p = mags[b] * mags[b];
    totalPower += p;
    for (let k = 0; k < BAND_NAMES.length; k += 1) {
      if (hz >= BAND_EDGES[k] && hz < BAND_EDGES[k + 1]) {
        bands[k] += p;
        break;
      }
    }
  }
  if (totalPower > 0) for (let k = 0; k < bands.length; k += 1) bands[k] /= totalPower;

  // Centroid and flatness over the magnitude spectrum.
  let num = 0;
  let den = 0;
  let logSum = 0;
  let linSum = 0;
  let nz = 0;
  for (let b = 1; b <= topBin; b += 1) {
    const m = mags[b];
    num += b * binHz * m;
    den += m;
    if (m > 0) {
      logSum += Math.log(m);
      linSum += m;
      nz += 1;
    }
  }
  const centroidHz = den > 0 ? num / den : 0;
  const flatness =
    nz > 0 && linSum > 0 ? Math.exp(logSum / nz) / (linSum / nz) : 0;

  let magSum = 0;
  for (let b = 0; b <= topBin; b += 1) magSum += mags[b];
  const fluxMean =
    flux.length > 0 ? flux.reduce((a, b) => a + b, 0) / flux.length : 0;

  return {
    mags,
    binHz,
    bands,
    centroidHz,
    flatness: Math.max(0, Math.min(1, flatness)),
    flux,
    fluxHz: sampleRate / HOP,
    fluxRatio: magSum > 0 ? fluxMean / magSum : 0,
  };
}

/** Below this share of the spectrum changing per frame, there are no transients. */
export const TRANSIENT_FLOOR = 0.02;
/** A tempo claim needs a real pulse, not just some movement. */
export const PULSE_FLOOR = 0.05;

/**
 * The times, in seconds, of the transients in a signal.
 *
 * Adaptively thresholded spectral-flux peaks with a refractory period, so one
 * transient is counted once. Returns nothing for material with no transients at
 * all, rather than finding "onsets" in the numerical wobble of a sustained note.
 *
 * The half-frame offset matters: a flux value at frame i describes the change
 * between frames i and i+1, and each frame is centred half a window after its
 * own start, so the transient it reports sits a frame and a half into the
 * signal. Without that correction every hit lands early, and a transcription
 * quantised from it drifts a whole sixteenth at fast tempos.
 */
export function onsetTimes(spec: Spectrum): number[] {
  const { flux, fluxHz } = spec;
  if (flux.length < 3) return [];
  if (spec.fluxRatio < TRANSIENT_FLOOR) return [];

  const mean = flux.reduce((a, b) => a + b, 0) / flux.length;
  let varSum = 0;
  for (let i = 0; i < flux.length; i += 1) varSum += (flux[i] - mean) ** 2;
  const sd = Math.sqrt(varSum / flux.length);
  const thresh = mean + sd;

  const refractory = Math.max(1, Math.round(fluxHz * 0.05));
  const hopSec = 1 / fluxHz;
  const offsetSec = 1.5 * hopSec;

  const out: number[] = [];
  let last = -refractory;
  for (let i = 1; i < flux.length - 1; i += 1) {
    if (
      flux[i] > thresh &&
      flux[i] >= flux[i - 1] &&
      flux[i] > flux[i + 1] &&
      i - last >= refractory
    ) {
      out.push(Math.max(0, i * hopSec + offsetSec));
      last = i;
    }
  }
  return out;
}

/** Onsets per second. */
export function onsetRate(spec: Spectrum): number {
  const times = onsetTimes(spec);
  if (spec.flux.length < 3) return 0;
  return times.length / (spec.flux.length / spec.fluxHz);
}

/**
 * Tempo estimate in BPM, or null when nothing periodic stands out.
 * Deliberately conservative: a wrong tempo is worse than none, because the
 * agent uses it to decide whether a part is rhythmic at all.
 *
 * Three things this gets right that a plain autocorrelation peak does not:
 *
 *  - It only runs on material with a real pulse (`fluxRatio`), so a held pad
 *    never reports a tempo.
 *  - It normalises by the envelope's variance and its full length rather than
 *    by the overlap at each lag. Normalising by the overlap inflates long lags.
 *  - It then prefers the fastest sub-multiple of the winning lag that is nearly
 *    as strong. A pulse whose true period is not a whole number of frames
 *    correlates better at twice its period than at its period, which is exactly
 *    how a 120 BPM loop gets reported as 60.
 */
export function estimateTempo(spec: Spectrum): number | null {
  const { flux, fluxHz } = spec;
  if (flux.length < fluxHz * 4) return null;
  if (spec.fluxRatio < PULSE_FLOOR) return null;

  const n = flux.length;
  const mean = flux.reduce((a, b) => a + b, 0) / n;
  const env = Float32Array.from(flux, (v) => v - mean);

  let variance = 0;
  for (let i = 0; i < n; i += 1) variance += env[i] * env[i];
  variance /= n;
  if (!(variance > 0)) return null;

  const minLag = Math.round((60 / 180) * fluxHz); // 180 BPM
  const maxLag = Math.round((60 / 60) * fluxHz); // 60 BPM
  if (maxLag >= n || minLag < 1) return null;

  const r = new Float64Array(maxLag + 1);
  let best = -Infinity;
  let bestLag = 0;
  let sum = 0;
  let count = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let acc = 0;
    for (let i = 0; i + lag < n; i += 1) acc += env[i] * env[i + lag];
    r[lag] = acc / (n * variance);
    sum += r[lag];
    count += 1;
    if (r[lag] > best) {
      best = r[lag];
      bestLag = lag;
    }
  }
  if (bestLag === 0 || count === 0) return null;

  // A real pulse correlates with itself; numerical wobble does not.
  const avg = sum / count;
  if (best < 0.2 || best < Math.max(0, avg) * 1.5) return null;

  // Octave correction: if half (or a third of) the winning lag is nearly as
  // strong, the faster reading is the fundamental.
  for (const divisor of [2, 3]) {
    const target = bestLag / divisor;
    if (target < minLag) continue;
    let localBest = -Infinity;
    let localLag = 0;
    for (let lag = Math.floor(target) - 1; lag <= Math.ceil(target) + 1; lag += 1) {
      if (lag < minLag || lag > maxLag) continue;
      if (r[lag] > localBest) {
        localBest = r[lag];
        localLag = lag;
      }
    }
    if (localLag > 0 && localBest >= best * 0.75) {
      bestLag = localLag;
      best = localBest;
      break;
    }
  }

  const bpm = (60 * fluxHz) / bestLag;
  return Math.round(bpm * 10) / 10;
}

// ---------------------------------------------------------------------------
// Per-track analysis
// ---------------------------------------------------------------------------

/** What the agent knows about one track. */
export interface TrackAnalysis {
  id: number;
  name: string;
  /** The part this track plays, as classified by `classifyPart`. */
  part: PartKind;
  loudnessDb: number;
  peakDb: number;
  /** Peak minus loudness: high means dynamic, low means dense or squashed. */
  crestDb: number;
  bands: number[];
  /** The band carrying the most energy. */
  dominantBand: BandName;
  centroidHz: number;
  flatness: number;
  onsetsPerSec: number;
  tempoBpm: number | null;
  /** Fraction of samples at or above 0.999 full scale. */
  clippedFraction: number;
  silent: boolean;
  durationSec: number;
  /** Mixer state at analysis time, so the planner can reason about deltas. */
  volume: number;
  pan: number;
  tone: number;
  lowCut: number;
  space: number;
  muted: boolean;
}

export type PartKind = "vocal" | "drums" | "bass" | "harmonic" | "unknown";

/** Anything the agent needs to know about a mixer track that is not audio. */
export interface TrackMeta {
  id: number;
  name: string;
  role: string;
  volume: number;
  pan: number;
  tone: number;
  /** Channel EQ low cut in Hz; 20 means open. */
  lowCut: number;
  space: number;
  muted: boolean;
}

const VOCAL_WORDS = /(vocal|voice|vox|take|lead|harmon|stack|choir|double|sing)/i;
const DRUM_WORDS = /(beat|drum|kick|snare|hat|perc|clap|rhythm)/i;
const BASS_WORDS = /(bass|sub|808)/i;
const HARMONIC_WORDS = /(pad|chord|key|piano|synth|arp|guitar|string|melod)/i;

/**
 * Decide what part a track plays, from its name and role first and its measured
 * spectrum second. Names are trusted when they are explicit because the user
 * chose them; the audio is the tie-breaker for generically named loops.
 */
export function classifyPart(
  meta: Pick<TrackMeta, "name" | "role">,
  measured: {
    centroidHz: number;
    bands: number[];
    flatness: number;
    onsetsPerSec: number;
  }
): PartKind {
  const text = `${meta.role} ${meta.name}`;
  if (VOCAL_WORDS.test(text)) return "vocal";
  if (DRUM_WORDS.test(text)) return "drums";
  if (BASS_WORDS.test(text)) return "bass";
  if (HARMONIC_WORDS.test(text)) return "harmonic";

  const { centroidHz, bands, flatness, onsetsPerSec } = measured;
  const lowShare = bands[0] + bands[1];
  if (lowShare > 0.6 && centroidHz < 350) return "bass";
  if (flatness > 0.28 && onsetsPerSec > 2.2) return "drums";
  // No onset requirement here: a held pad has no transients at all, and
  // requiring some would push every sustained part into "unknown".
  if (centroidHz > 450 && centroidHz < 6000) return "harmonic";
  return "unknown";
}

/** Analyse one track's audio together with its mixer state. */
export function analyzeTrack(
  meta: TrackMeta,
  data: Float32Array,
  sampleRate: number
): TrackAnalysis {
  const pk = peak(data);
  const spec = analyzeSpectrum(data, sampleRate);
  const loudnessDb = gatedLoudnessDb(data, sampleRate);
  const onsetsPerSec = onsetRate(spec);
  const tempoBpm = estimateTempo(spec);

  let clipped = 0;
  for (let i = 0; i < data.length; i += 1) if (Math.abs(data[i]) >= 0.999) clipped += 1;

  let domIdx = 0;
  for (let i = 1; i < spec.bands.length; i += 1) {
    if (spec.bands[i] > spec.bands[domIdx]) domIdx = i;
  }

  const part = classifyPart(meta, {
    centroidHz: spec.centroidHz,
    bands: spec.bands,
    flatness: spec.flatness,
    onsetsPerSec,
  });

  return {
    id: meta.id,
    name: meta.name,
    part,
    loudnessDb,
    peakDb: dbfs(pk),
    crestDb: dbfs(pk) - loudnessDb,
    bands: spec.bands,
    dominantBand: BAND_NAMES[domIdx],
    centroidHz: spec.centroidHz,
    flatness: spec.flatness,
    onsetsPerSec,
    tempoBpm,
    clippedFraction: data.length > 0 ? clipped / data.length : 0,
    silent: pk < 1e-4,
    durationSec: sampleRate > 0 ? data.length / sampleRate : 0,
    volume: meta.volume,
    pan: meta.pan,
    tone: meta.tone,
    lowCut: meta.lowCut,
    space: meta.space,
    muted: meta.muted,
  };
}

// ---------------------------------------------------------------------------
// Session analysis
// ---------------------------------------------------------------------------

/** Two parts competing for the same band, loudly enough to matter. */
export interface MaskingPair {
  maskedId: number;
  maskerId: number;
  band: BandName;
  /** How much of the band the masker occupies relative to the masked part. */
  severity: number;
}

export interface SessionAnalysis {
  tracks: TrackAnalysis[];
  /** Loudest audible parts summed, in dBFS. */
  mixLoudnessDb: number;
  mixPeakDb: number;
  /** -1 fully left .. 1 fully right, energy weighted. */
  stereoBalance: number;
  /** Spread of audible track loudness, in dB. */
  loudnessSpreadDb: number;
  masking: MaskingPair[];
  /**
   * How many parts are on the bottom that have no business being there. The
   * loudest bass legitimately owns it and the drums legitimately share it, so
   * neither counts; anything else down there does.
   */
  lowEndCrowding: number;
  /** The ids behind `lowEndCrowding`, loudest share of the bottom first. */
  lowEndExtras: number[];
  tempoBpm: number | null;
  counts: Record<PartKind, number>;
}

/** Tracks the listener can currently hear. */
function audible(t: TrackAnalysis): boolean {
  return !t.muted && !t.silent && t.volume > 0.001;
}

/** Effective loudness of a track as it sits in the mix, with its fader applied. */
export function effectiveLoudnessDb(t: TrackAnalysis): number {
  return t.loudnessDb + dbfs(Math.max(t.volume, 1e-6));
}

/**
 * Find parts fighting the same band. Only reported when both parts are audible,
 * both put real energy in the band, and the masker is not quieter than the
 * masked part; a quiet pad under a loud vocal is not a problem to fix.
 */
export function findMasking(tracks: TrackAnalysis[]): MaskingPair[] {
  const out: MaskingPair[] = [];
  const live = tracks.filter(audible);
  for (const masked of live) {
    // Only vocals and bass are worth protecting; everything else is arrangement.
    if (masked.part !== "vocal" && masked.part !== "bass") continue;
    const mLoud = effectiveLoudnessDb(masked);
    for (const masker of live) {
      if (masker.id === masked.id) continue;
      if (masker.part === masked.part) continue;
      const kLoud = effectiveLoudnessDb(masker);
      if (kLoud < mLoud - 3) continue;
      for (let b = 0; b < BAND_NAMES.length; b += 1) {
        const a = masked.bands[b];
        const c = masker.bands[b];
        if (a < 0.12 || c < 0.12) continue;
        // A kick and a bass overlapping at the bottom is how records are made,
        // not a defect. It is also the one collision this mixer cannot fix
        // properly: separating them wants a high-pass or sidechain compression,
        // and the only move available is turning the kick down, which is
        // usually the wrong answer. Reporting it would have the agent chasing a
        // problem it cannot solve on every mix that has drums in it.
        // Only the bass side of this is reachable: the outer loop protects
        // vocals and bass, and drums are never the protected part.
        if (b <= 1 && masked.part === "bass" && masker.part === "drums") continue;
        // Severity grows with the shared energy and with how far the masker is
        // above the part it is covering.
        const severity = Math.min(a, c) * (1 + Math.max(0, kLoud - mLoud) / 6);
        if (severity > 0.14) {
          out.push({
            maskedId: masked.id,
            maskerId: masker.id,
            band: BAND_NAMES[b],
            severity: Math.round(severity * 1000) / 1000,
          });
        }
      }
    }
  }
  return out.sort((x, y) => y.severity - x.severity);
}

/** Roll per-track analyses up into the picture the planner reasons over. */
export function analyzeSession(tracks: TrackAnalysis[]): SessionAnalysis {
  const live = tracks.filter(audible);

  // Sum powers to estimate the mix, rather than taking the loudest part.
  let power = 0;
  let peakLin = 0;
  let left = 0;
  let right = 0;
  for (const t of live) {
    const lin = Math.pow(10, effectiveLoudnessDb(t) / 20);
    power += lin * lin;
    peakLin = Math.max(peakLin, Math.pow(10, (t.peakDb + dbfs(Math.max(t.volume, 1e-6))) / 20));
    // Equal-power pan split.
    const theta = ((t.pan + 1) / 2) * (Math.PI / 2);
    left += (lin * Math.cos(theta)) ** 2;
    right += (lin * Math.sin(theta)) ** 2;
  }
  const mixLoudnessDb = live.length > 0 ? dbfs(Math.sqrt(power)) : -120;
  const mixPeakDb = live.length > 0 ? dbfs(peakLin) : -120;
  const stereoBalance = left + right > 0 ? (right - left) / (right + left) : 0;

  const louds = live.map(effectiveLoudnessDb);
  let spread = 0;
  if (louds.length > 1) {
    const m = louds.reduce((a, b) => a + b, 0) / louds.length;
    spread = Math.sqrt(louds.reduce((a, b) => a + (b - m) ** 2, 0) / louds.length);
  }

  // Who is on the bottom, and who is allowed to be. A kick and a bass sharing
  // the low end is how records are made; a third part down there is the problem.
  const lowHeavy = live
    .filter((t) => t.bands[0] + t.bands[1] > 0.45)
    .sort((a, b) => b.bands[0] + b.bands[1] - (a.bands[0] + a.bands[1]));
  const anchor = lowHeavy
    .filter((t) => t.part === "bass")
    .sort((a, b) => effectiveLoudnessDb(b) - effectiveLoudnessDb(a))[0];
  const lowEndExtras = lowHeavy
    .filter((t) => t.part !== "drums" && t.part !== "vocal" && t.id !== anchor?.id)
    .map((t) => t.id);

  // The mix tempo is the most common estimate among rhythmic parts.
  const tempos = live
    .filter((t) => t.part === "drums" || t.part === "bass")
    .map((t) => t.tempoBpm)
    .filter((v): v is number => v != null);
  const tempoBpm =
    tempos.length > 0
      ? Math.round((tempos.reduce((a, b) => a + b, 0) / tempos.length) * 10) / 10
      : (live.map((t) => t.tempoBpm).find((v): v is number => v != null) ?? null);

  const counts: Record<PartKind, number> = {
    vocal: 0,
    drums: 0,
    bass: 0,
    harmonic: 0,
    unknown: 0,
  };
  for (const t of live) counts[t.part] += 1;

  return {
    tracks,
    mixLoudnessDb: Math.round(mixLoudnessDb * 10) / 10,
    mixPeakDb: Math.round(mixPeakDb * 10) / 10,
    stereoBalance: Math.round(stereoBalance * 1000) / 1000,
    loudnessSpreadDb: Math.round(spread * 10) / 10,
    masking: findMasking(tracks),
    lowEndCrowding: lowEndExtras.length,
    lowEndExtras,
    tempoBpm,
    counts,
  };
}
