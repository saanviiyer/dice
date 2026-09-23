import { describe, expect, it } from "vitest";
import {
  analyzeSession,
  analyzeSpectrum,
  analyzeTrack,
  classifyPart,
  dbfs,
  effectiveLoudnessDb,
  estimateTempo,
  fft,
  findMasking,
  gatedLoudnessDb,
  onsetRate,
  peak,
  rms,
  type TrackAnalysis,
  type TrackMeta,
} from "./ears";

const SR = 22050;

/** A steady sine, for spectrum tests. */
function sine(hz: number, seconds: number, amp = 0.5, sr = SR): Float32Array {
  const x = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < x.length; i += 1) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr);
  return x;
}

/** Short decaying clicks at a fixed rate, for onset and tempo tests. */
function clicks(perSec: number, seconds: number, sr = SR): Float32Array {
  const x = new Float32Array(Math.round(seconds * sr));
  const period = Math.round(sr / perSec);
  for (let start = 0; start < x.length; start += period) {
    for (let i = 0; i < Math.min(400, x.length - start); i += 1) {
      // Broadband transient so spectral flux sees it.
      x[start + i] = (Math.random() * 2 - 1) * Math.exp(-i / 60);
    }
  }
  return x;
}

function meta(over: Partial<TrackMeta> = {}): TrackMeta {
  return {
    id: 1,
    name: "track",
    role: "loop",
    volume: 1,
    pan: 0,
    tone: 1,
    lowCut: 20,
    space: 0,
    muted: false,
    ...over,
  };
}

describe("fft", () => {
  it("turns an impulse into a flat magnitude spectrum", () => {
    const n = 64;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    re[0] = 1;
    fft(re, im);
    for (let i = 0; i < n; i += 1) {
      expect(Math.hypot(re[i], im[i])).toBeCloseTo(1, 5);
    }
  });

  it("puts a bin-aligned sine in exactly that bin", () => {
    const n = 64;
    const k = 7;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let i = 0; i < n; i += 1) re[i] = Math.cos((2 * Math.PI * k * i) / n);
    fft(re, im);
    const mags = Array.from({ length: n / 2 }, (_, i) => Math.hypot(re[i], im[i]));
    let best = 0;
    mags.forEach((m, i) => {
      if (m > mags[best]) best = i;
    });
    expect(best).toBe(k);
  });

  it("rejects a non power-of-two length", () => {
    expect(() => fft(new Float32Array(6), new Float32Array(6))).toThrow();
  });
});

describe("levels", () => {
  it("measures rms and peak of a sine", () => {
    const x = sine(440, 0.5, 0.5);
    expect(rms(x)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    expect(peak(x)).toBeCloseTo(0.5, 2);
  });

  it("floors silence instead of returning -Infinity", () => {
    expect(dbfs(0)).toBe(-120);
    expect(Number.isFinite(dbfs(0))).toBe(true);
  });

  it("gated loudness ignores the gaps a sparse take leaves", () => {
    // Half a second of tone, then two seconds of silence: a sparse phrase.
    const sparse = new Float32Array(SR * 3);
    sparse.set(sine(440, 0.5, 0.5), 0);
    const gated = gatedLoudnessDb(sparse, SR);
    const plain = dbfs(rms(sparse));
    expect(gated).toBeGreaterThan(plain + 3);
    // And it lands near the loudness of the part that is actually sounding.
    expect(gated).toBeGreaterThan(-16);
  });
});

describe("spectrum", () => {
  it("puts a low sine in the low bands and a high sine in the air band", () => {
    const low = analyzeSpectrum(sine(90, 1.5), SR);
    const high = analyzeSpectrum(sine(8000, 1.5), SR);
    expect(low.bands[1]).toBeGreaterThan(0.5); // 60-250 Hz
    expect(high.bands[5]).toBeGreaterThan(0.5); // 6 kHz and up
    expect(low.centroidHz).toBeLessThan(high.centroidHz);
  });

  it("reads a sine as tonal and noise as flat", () => {
    const tone = analyzeSpectrum(sine(440, 1.5), SR);
    const noise = new Float32Array(SR * 1.5);
    for (let i = 0; i < noise.length; i += 1) noise[i] = Math.random() * 2 - 1;
    expect(analyzeSpectrum(noise, SR).flatness).toBeGreaterThan(tone.flatness + 0.2);
  });

  it("counts onsets at roughly the rate they were made", () => {
    const spec = analyzeSpectrum(clicks(4, 4), SR);
    const rate = onsetRate(spec);
    expect(rate).toBeGreaterThan(3);
    expect(rate).toBeLessThan(5.5);
  });

  it("recovers the tempo of a steady pulse", () => {
    const spec = analyzeSpectrum(clicks(2, 8), SR); // 2 Hz = 120 BPM
    const bpm = estimateTempo(spec);
    expect(bpm).not.toBeNull();
    expect(Math.abs((bpm as number) - 120)).toBeLessThan(8);
  });

  it("returns no tempo for a steady tone rather than inventing one", () => {
    const spec = analyzeSpectrum(sine(440, 8), SR);
    expect(estimateTempo(spec)).toBeNull();
  });

  it("finds no onsets in a sustained tone", () => {
    // Spectral flux is relative, so a held note still produces a flux signal.
    // The transient gate is what stops it being read as a busy part.
    const spec = analyzeSpectrum(sine(440, 8), SR);
    expect(spec.fluxRatio).toBeLessThan(0.02);
    expect(onsetRate(spec)).toBe(0);
  });

  it("hears transients in a pulse but not in a held note", () => {
    expect(analyzeSpectrum(clicks(4, 4), SR).fluxRatio).toBeGreaterThan(0.2);
    expect(analyzeSpectrum(sine(440, 4), SR).fluxRatio).toBeLessThan(0.01);
  });
});

describe("classifyPart", () => {
  it("trusts an explicit name", () => {
    const measured = { centroidHz: 3000, bands: [0, 0, 0, 1, 0, 0], flatness: 0.1, onsetsPerSec: 1 };
    expect(classifyPart({ name: "Take 2", role: "vocal" }, measured)).toBe("vocal");
    expect(classifyPart({ name: "lofi beat", role: "stem" }, measured)).toBe("drums");
    expect(classifyPart({ name: "808 line", role: "stem" }, measured)).toBe("bass");
    expect(classifyPart({ name: "warm pad", role: "stem" }, measured)).toBe("harmonic");
  });

  it("falls back to the audio for a generically named loop", () => {
    expect(
      classifyPart(
        { name: "Loop 1", role: "loop" },
        { centroidHz: 120, bands: [0.4, 0.4, 0.1, 0.1, 0, 0], flatness: 0.05, onsetsPerSec: 1 }
      )
    ).toBe("bass");
    expect(
      classifyPart(
        { name: "Loop 2", role: "loop" },
        { centroidHz: 4000, bands: [0.1, 0.1, 0.2, 0.2, 0.2, 0.2], flatness: 0.4, onsetsPerSec: 5 }
      )
    ).toBe("drums");
  });
});

describe("analyzeTrack", () => {
  it("describes a bright sustained tone", () => {
    const a = analyzeTrack(meta({ name: "pad", role: "pad" }), sine(3000, 2, 0.4), SR);
    expect(a.part).toBe("harmonic");
    expect(a.silent).toBe(false);
    expect(a.centroidHz).toBeGreaterThan(2000);
    expect(a.peakDb).toBeGreaterThan(a.loudnessDb - 0.01);
    expect(a.durationSec).toBeCloseTo(2, 1);
  });

  it("flags silence", () => {
    const a = analyzeTrack(meta(), new Float32Array(SR), SR);
    expect(a.silent).toBe(true);
  });

  it("flags a clipped take", () => {
    const x = sine(440, 1, 2); // amplitude 2, hard clipped by the measurement
    for (let i = 0; i < x.length; i += 1) x[i] = Math.max(-1, Math.min(1, x[i]));
    expect(analyzeTrack(meta(), x, SR).clippedFraction).toBeGreaterThan(0.05);
  });
});

// ---------------------------------------------------------------------------

function fakeAnalysis(over: Partial<TrackAnalysis>): TrackAnalysis {
  return {
    id: 1,
    name: "t",
    part: "harmonic",
    loudnessDb: -18,
    peakDb: -6,
    crestDb: 12,
    bands: [0, 0, 0, 1, 0, 0],
    dominantBand: "mid",
    centroidHz: 1000,
    flatness: 0.1,
    onsetsPerSec: 1,
    tempoBpm: null,
    clippedFraction: 0,
    silent: false,
    durationSec: 4,
    volume: 1,
    pan: 0,
    tone: 1,
    lowCut: 20,
    space: 0,
    muted: false,
    ...over,
  };
}

describe("findMasking", () => {
  it("reports a loud pad sitting on top of a vocal in the same band", () => {
    const vocal = fakeAnalysis({ id: 1, name: "vox", part: "vocal", loudnessDb: -18 });
    const pad = fakeAnalysis({ id: 2, name: "pad", part: "harmonic", loudnessDb: -14 });
    const pairs = findMasking([vocal, pad]);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs[0]).toMatchObject({ maskedId: 1, maskerId: 2, band: "mid" });
  });

  it("does not report a part that is already well under the vocal", () => {
    const vocal = fakeAnalysis({ id: 1, name: "vox", part: "vocal", loudnessDb: -12 });
    const pad = fakeAnalysis({ id: 2, name: "pad", part: "harmonic", loudnessDb: -30 });
    expect(findMasking([vocal, pad])).toHaveLength(0);
  });

  it("ignores muted parts", () => {
    const vocal = fakeAnalysis({ id: 1, name: "vox", part: "vocal" });
    const pad = fakeAnalysis({ id: 2, name: "pad", loudnessDb: -12, muted: true });
    expect(findMasking([vocal, pad])).toHaveLength(0);
  });
});

describe("analyzeSession", () => {
  it("hears a lopsided stereo picture", () => {
    const l = fakeAnalysis({ id: 1, pan: -1 });
    const r = fakeAnalysis({ id: 2, pan: 1, loudnessDb: -30 });
    expect(analyzeSession([l, r]).stereoBalance).toBeLessThan(-0.5);
  });

  it("counts parts and reports the level spread", () => {
    const s = analyzeSession([
      fakeAnalysis({ id: 1, part: "vocal", loudnessDb: -10 }),
      fakeAnalysis({ id: 2, part: "drums", loudnessDb: -30 }),
      fakeAnalysis({ id: 3, part: "bass", loudnessDb: -20 }),
    ]);
    expect(s.counts.vocal).toBe(1);
    expect(s.counts.drums).toBe(1);
    expect(s.loudnessSpreadDb).toBeGreaterThan(6);
  });

  it("applies the fader when comparing track levels", () => {
    const t = fakeAnalysis({ loudnessDb: -12, volume: 0.5 });
    expect(effectiveLoudnessDb(t)).toBeCloseTo(-18, 1);
  });

  it("returns a silent picture for an empty mix", () => {
    const s = analyzeSession([]);
    expect(s.mixLoudnessDb).toBe(-120);
    expect(s.masking).toHaveLength(0);
  });
});
