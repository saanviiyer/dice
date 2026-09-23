import { describe, expect, it } from "vitest";
import {
  classifyHit,
  describeLane,
  describeTranscription,
  hitFeatures,
  inferPhase,
  detectHits,
  explainTempo,
  foldTempo,
  inferTempo,
  pickPeaks,
  readTempo,
  transcribeBeatbox,
  TRANSCRIBED_VOICES,
  type HitFeatures,
} from "./transcribe";
import { analyzeSpectrum } from "./ears";
import { STEPS_PER_BAR } from "./drums";

/**
 * The sample rate a browser actually hands you from a microphone.
 *
 * These tests used to run at 22050, which no real recording uses, and that hid
 * a complete failure at 44.1 and 48 kHz: the analysis windows were fixed in
 * samples rather than seconds, and the top analysis band ran to Nyquist, so
 * every snare classified as a hi-hat on real input while the suite stayed
 * green. Test at the rate users get.
 */
const SR = 48000;

// ---------------------------------------------------------------------------
// Synthesised mouth sounds. These are the shapes a beatboxer actually makes:
// a kick is a pitched low thud, a snare a mid noise burst with a short tail, a
// hat a very short burst of top end, a tom a pitched mid thud that rings.
// ---------------------------------------------------------------------------

let seed = 12345;
/** Rewind the noise, so a fixture does not depend on what ran before it. */
function resetNoise() {
  seed = 12345;
}
/** Deterministic noise, so a failing test fails the same way twice. */
function noise(): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return (seed / 0xffffffff) * 2 - 1;
}

/**
 * A mouth kick: pitch dropping from 110 Hz to 45 Hz.
 *
 * Long enough that the envelope reaches silence on its own. A generator that
 * stops while the waveform is still at a tenth of full scale ends in a step
 * discontinuity, which is a broadband click, which a good onset detector
 * correctly reports as a second hit. The fixture has to decay properly or it is
 * testing the detector against a sound no drum makes.
 */
function addKick(x: Float32Array, at: number, gain = 1, rate = SR) {
  const start = Math.round(at * rate);
  const len = Math.round(rate * 0.35);
  for (let i = 0; i < len && start + i < x.length; i += 1) {
    const t = i / rate;
    const f = 45 + 65 * Math.exp(-t * 40);
    x[start + i] += gain * Math.exp(-t * 16) * Math.sin(2 * Math.PI * f * t);
  }
}

function addSnare(x: Float32Array, at: number, gain = 0.8, rate = SR) {
  const start = Math.round(at * rate);
  const len = Math.round(rate * 0.2);
  // Band-passed noise centred around 2 kHz, plus a little 190 Hz body: that is
  // where a mouth snare actually sits. Simply high-passing noise produces
  // something centred at 6 kHz, which is a hi-hat, not a snare.
  let lp = 0;
  let hpY = 0;
  let hpX = 0;
  for (let i = 0; i < len && start + i < x.length; i += 1) {
    const t = i / rate;
    const n = noise();
    hpY = 0.814 * (hpY + n - hpX); // one-pole high pass, about 800 Hz
    hpX = n;
    lp = lp + 0.533 * (hpY - lp); // one-pole low pass, about 4 kHz
    const body = 0.35 * Math.sin(2 * Math.PI * 190 * t);
    x[start + i] += gain * Math.exp(-t * 30) * (lp * 1.8 + body);
  }
}

function addHat(x: Float32Array, at: number, gain = 0.5, rate = SR) {
  const start = Math.round(at * rate);
  const len = Math.round(rate * 0.06);
  let prev = 0;
  for (let i = 0; i < len && start + i < x.length; i += 1) {
    const t = i / rate;
    const n = noise();
    // Differentiated noise: almost all energy at the very top, gone instantly.
    const d = n - prev;
    prev = n;
    x[start + i] += gain * Math.exp(-t * 190) * d;
  }
}

function addTom(x: Float32Array, at: number, gain = 0.8, rate = SR) {
  const start = Math.round(at * rate);
  const len = Math.round(rate * 0.6);
  for (let i = 0; i < len && start + i < x.length; i += 1) {
    const t = i / rate;
    const f = 300 + 180 * Math.exp(-t * 25);
    x[start + i] += gain * Math.exp(-t * 9) * Math.sin(2 * Math.PI * f * t);
  }
}

/**
 * A four-on-the-floor loop: kick 1 and 3, snare 2 and 4, hats on the offbeats.
 *
 * The quarter second of lead-in is not padding. Spectral flux compares a frame
 * with the one before it, so a hit at sample zero has nothing to stand out
 * against and cannot be detected at all. Every real recording begins with some
 * silence; a fixture that does not is testing a case that never happens.
 */
const LEAD_IN_SEC = 0.25;

function boomBap(bpm: number, bars = 2, rate = SR): Float32Array {
  // Same groove every time, whatever ran before it in this file.
  resetNoise();
  const beat = 60 / bpm;
  const x = new Float32Array(Math.round((LEAD_IN_SEC + beat * 4 * bars + 0.4) * rate));
  for (let b = 0; b < bars; b += 1) {
    const bar = LEAD_IN_SEC + b * beat * 4;
    addKick(x, bar + 0, 1, rate);
    addKick(x, bar + beat * 2, 1, rate);
    addSnare(x, bar + beat * 1, 0.8, rate);
    addSnare(x, bar + beat * 3, 0.8, rate);
    for (let e = 0; e < 4; e += 1) addHat(x, bar + beat * e + beat / 2, 0.5, rate);
  }
  return x;
}

// ---------------------------------------------------------------------------

describe("detectHits", () => {
  it("finds a quiet kick sitting underneath a busy hat pattern", () => {
    // The regression this exists for: one broadband flux curve is dominated by
    // the hats, and the kick that defines the groove disappears from it.
    const bpm = 96;
    const beat = 60 / bpm;
    const x = new Float32Array(Math.round((LEAD_IN_SEC + beat * 4 + 0.3) * SR));
    for (let e = 0; e < 8; e += 1) addHat(x, LEAD_IN_SEC + (e * beat) / 2, 0.6);
    addKick(x, LEAD_IN_SEC, 0.5);
    addKick(x, LEAD_IN_SEC + beat * 2, 0.5);

    const hits = detectHits(x, SR);
    // The two kicks coincide with hats, so eight events, not ten.
    expect(hits.length).toBe(8);
    expect(hits[0]).toBeLessThan(LEAD_IN_SEC + 0.05);

    const t = transcribeBeatbox(x, SR, { bpm });
    const kicks = t.pattern.kick.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    expect(kicks).toContain(0);
    expect(kicks).toContain(8);
  });

  it("merges hits that land together into one event", () => {
    const x = new Float32Array(SR * 2);
    addKick(x, 0.3);
    addHat(x, 0.305); // 5 ms apart: one layered hit, not two
    expect(detectHits(x, SR).length).toBe(1);
  });

  it("hears nothing in silence", () => {
    expect(detectHits(new Float32Array(SR * 2), SR)).toEqual([]);
  });
});

describe("pickPeaks", () => {
  it("keeps finding hits when the passage gets louder", () => {
    // A global threshold would miss every hit in the quiet half.
    const frameHz = 86;
    const flux = new Float32Array(frameHz * 8);
    for (let i = 0; i < 16; i += 1) {
      // Offset from frame zero: a peak in the very first frame has no previous
      // frame to stand out from and is unreachable by design.
      const at = Math.round((i + 0.5) * frameHz * 0.5);
      flux[at] = i < 8 ? 0.3 : 3;
    }
    expect(pickPeaks(flux, frameHz).length).toBe(16);
  });

  it("finds nothing in a flat curve", () => {
    expect(pickPeaks(new Float32Array(500).fill(1), 86)).toEqual([]);
    expect(pickPeaks(new Float32Array(500), 86)).toEqual([]);
  });
});

describe("hitFeatures", () => {
  it("hears a kick as low, tonal and ringing", () => {
    const x = new Float32Array(SR);
    addKick(x, 0);
    const f = hitFeatures(x, SR, 0);
    expect(f.lowShare).toBeGreaterThan(0.7);
    expect(f.centroidHz).toBeLessThan(400);
    expect(f.peak).toBeGreaterThan(0.3);
  });

  it("hears a hat as top-end and instantly gone", () => {
    const x = new Float32Array(SR);
    addHat(x, 0);
    const f = hitFeatures(x, SR, 0);
    expect(f.centroidHz).toBeGreaterThan(4000);
    expect(f.tailRatio).toBeLessThan(0.2);
  });

  it("pads a hit at the very end instead of dropping it", () => {
    // Less than one analysis frame of audio left after the onset.
    const x = new Float32Array(Math.round(SR * 0.05));
    addHat(x, 0);
    const f = hitFeatures(x, SR, 0);
    expect(Number.isFinite(f.centroidHz)).toBe(true);
    expect(f.peak).toBeGreaterThan(0);
  });
});

describe("classifyHit", () => {
  const cases: Array<[string, (x: Float32Array) => void, string]> = [
    ["a mouth kick", (x) => addKick(x, 0), "kick"],
    ["a mouth snare", (x) => addSnare(x, 0), "snare"],
    ["a hi-hat", (x) => addHat(x, 0), "hat"],
    ["a tom", (x) => addTom(x, 0), "tom"],
  ];

  for (const [label, make, expected] of cases) {
    it(`calls ${label} a ${expected}`, () => {
      const x = new Float32Array(SR);
      make(x);
      expect(classifyHit(hitFeatures(x, SR, 0)).voice).toBe(expected);
    });
  }

  it("always returns one of the four lanes it claims to transcribe", () => {
    const flat: HitFeatures = {
      centroidHz: 1000,
      lowShare: 0.25,
      airShare: 0.25,
      flatness: 0.5,
      tailRatio: 0.5,
      peak: 0.5,
    };
    const { voice, confidence } = classifyHit(flat);
    expect(TRANSCRIBED_VOICES).toContain(voice);
    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThanOrEqual(1);
  });

  it("reports low confidence for a sound between two voices", () => {
    // A bright, noisy hit with some tail sits genuinely between a snare and a
    // hat, and the panel flags those for you to check. A clean mouth kick does
    // not, and should not be flagged.
    const between = {
      centroidHz: 5600,
      lowShare: 0.05,
      airShare: 0.45,
      flatness: 0.78,
      tailRatio: 0.12,
      peak: 0.6,
    };
    const clear = classifyHit(hitFeaturesOf((x) => addKick(x, 0)));
    expect(classifyHit(between).confidence).toBeLessThan(0.6);
    expect(classifyHit(between).confidence).toBeLessThan(clear.confidence);
    expect(clear.confidence).toBeGreaterThan(0.9);
  });

  function hitFeaturesOf(make: (x: Float32Array) => void): HitFeatures {
    const x = new Float32Array(SR);
    make(x);
    return hitFeatures(x, SR, 0);
  }
});

describe("inferTempo", () => {
  it("prefers the tempo the project already has", () => {
    const spec = analyzeSpectrum(boomBap(96), SR);
    expect(inferTempo(spec, [0, 0.5, 1], 128)).toEqual({ bpm: 128, source: "given" });
  });

  it("ignores a nonsense tempo from the caller", () => {
    const spec = analyzeSpectrum(boomBap(96), SR);
    expect(inferTempo(spec, [0, 0.5, 1], 4).source).not.toBe("given");
  });

  it("falls back to the gaps between hits when nothing is periodic enough", () => {
    const silent = analyzeSpectrum(new Float32Array(SR * 5), SR);
    // Hits every 0.3 s read as eighths, so 100 BPM.
    const onsets = [0, 0.3, 0.6, 0.9, 1.2, 1.5];
    const out = inferTempo(silent, onsets);
    expect(out.source).toBe("assumed");
    expect(out.bpm).toBeCloseTo(100, 0);
  });

  it("folds a doubled or halved reading back into the range people count in", () => {
    // Beatboxing eighth notes at 96 BPM produces a 192 BPM onset pulse.
    expect(foldTempo(192)).toBe(96);
    expect(foldTempo(59.9)).toBe(119.8);
    expect(foldTempo(120)).toBe(120);
    expect(foldTempo(0)).toBe(100);
  });
});

describe("inferPhase", () => {
  it("finds a downbeat that is late in the recording", () => {
    const stepSec = 0.125;
    const offset = 0.25;
    const onsets = [0, 4, 8, 12].map((s) => offset + s * stepSec);
    const phase = inferPhase(onsets, [1, 1, 1, 1], stepSec, STEPS_PER_BAR);
    // The hits are already on the grid, so any phase that keeps them there is
    // correct; what matters is that they still quantise cleanly.
    for (const t of onsets) {
      const rel = (t - phase) / stepSec;
      expect(Math.abs(rel - Math.round(rel))).toBeLessThan(0.06);
    }
  });

  it("returns zero for no hits", () => {
    expect(inferPhase([], [], 0.125, STEPS_PER_BAR)).toBe(0);
  });
});

describe("transcribeBeatbox", () => {
  it("turns a beatboxed boom bap into the pattern that was played", () => {
    const t = transcribeBeatbox(boomBap(96, 2), SR, { bpm: 96 });

    expect(t.bpm).toBe(96);
    expect(t.bpmSource).toBe("given");
    expect(t.bars).toBe(2);

    const kicks = t.pattern.kick.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    const snares = t.pattern.snare.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    const hats = t.pattern.hat.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);

    // Kick on beats 1 and 3 of each bar: steps 0, 8, 16, 24.
    expect(kicks).toEqual([0, 8, 16, 24]);
    // Snare on 2 and 4: steps 4, 12, 20, 28.
    expect(snares).toEqual([4, 12, 20, 28]);
    // Hats on every offbeat eighth: steps 2, 6, 10, ...
    expect(hats).toEqual([2, 6, 10, 14, 18, 22, 26, 30]);
  });

  it("works at a different tempo", () => {
    const t = transcribeBeatbox(boomBap(132, 1), SR, { bpm: 132 });
    const kicks = t.pattern.kick.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    expect(kicks).toEqual([0, 8]);
  });

  it("measures a tempo when the project does not supply one", () => {
    const t = transcribeBeatbox(boomBap(120, 2), SR);
    expect(t.bpmSource).not.toBe("given");
    expect(Math.abs(t.bpm - 120)).toBeLessThan(12);
  });

  it("leaves clap and shaker empty rather than guessing", () => {
    const t = transcribeBeatbox(boomBap(96, 1), SR, { bpm: 96 });
    expect(t.pattern.clap.every((v) => v === 0)).toBe(true);
    expect(t.pattern.shaker.every((v) => v === 0)).toBe(true);
  });

  it("gives every lane the same length, as the sequencer requires", () => {
    const t = transcribeBeatbox(boomBap(96, 2), SR, { bpm: 96 });
    const lengths = new Set(Object.values(t.pattern).map((l) => l.length));
    expect(lengths.size).toBe(1);
    expect(t.pattern.kick.length).toBe(2 * STEPS_PER_BAR);
  });

  it("never exceeds the sequencer's four-bar maximum", () => {
    const t = transcribeBeatbox(boomBap(96, 8), SR, { bpm: 96 });
    expect(t.bars).toBeLessThanOrEqual(4);
    expect(t.pattern.kick.length).toBeLessThanOrEqual(4 * STEPS_PER_BAR);
    // And it says so rather than silently truncating.
    expect(t.notes.join(" ")).toMatch(/did not make it in/);
  });

  it("says so plainly when there is nothing to hear", () => {
    const t = transcribeBeatbox(new Float32Array(SR * 2), SR, { bpm: 100 });
    expect(t.hits).toHaveLength(0);
    expect(t.notes[0]).toMatch(/could not hear/);
    expect(t.pattern.kick.every((v) => v === 0)).toBe(true);
  });

  it("scales velocity against the loudest hit", () => {
    const beat = 60 / 96;
    const x = new Float32Array(Math.round((LEAD_IN_SEC + beat * 4 + 0.3) * SR));
    addKick(x, LEAD_IN_SEC, 1);
    addKick(x, LEAD_IN_SEC + beat * 2, 0.35);
    const t = transcribeBeatbox(x, SR, { bpm: 96 });
    expect(t.hits.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...t.hits.map((h) => h.velocity))).toBeCloseTo(1, 5);
    expect(Math.min(...t.hits.map((h) => h.velocity))).toBeLessThan(0.75);
  });
});

describe("describeLane", () => {
  it("names the beats a lane lands on", () => {
    const lane = new Array(16).fill(0);
    lane[0] = 1;
    lane[8] = 1;
    expect(describeLane(lane, 4, 4)).toBe("on 1 and 3");
  });

  it("recognises the offbeats", () => {
    const lane = new Array(16).fill(0);
    for (const i of [2, 6, 10, 14]) lane[i] = 1;
    expect(describeLane(lane, 4, 4)).toBe("on the offbeats");
  });

  it("says nothing about an empty lane", () => {
    expect(describeLane(new Array(16).fill(0), 4, 4)).toBe("");
  });
});

describe("describeTranscription", () => {
  it("says back what it heard, in musician's language", () => {
    const t = transcribeBeatbox(boomBap(96, 1), SR, { bpm: 96 });
    const said = describeTranscription(t);
    expect(said).toMatch(/1 bar at your 96 BPM/);
    expect(said).toMatch(/kick on 1 and 3/);
    expect(said).toMatch(/snare on 2 and 4/);
    expect(said).toMatch(/hat on the offbeats/);
  });
});


describe("readTempo", () => {
  it("reads the tempo of a played-in groove", () => {
    const r = readTempo(boomBap(120, 3), SR);
    expect(r.usable).toBe(true);
    expect(Math.abs(r.bpm - 120)).toBeLessThan(12);
    expect(r.hits).toBeGreaterThan(8);
    expect(explainTempo(r)).toMatch(/BPM from \d+ hits/);
  });

  it("refuses a held note rather than inventing a tempo", () => {
    // Retuning a whole project to a wrong tempo is far worse than saying
    // nothing: every part already recorded would fight a grid that moved.
    const x = new Float32Array(SR * 6);
    for (let i = 0; i < x.length; i += 1) x[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / SR);
    const r = readTempo(x, SR);
    expect(r.usable).toBe(false);
    expect(explainTempo(r)).toMatch(/pulse|guessing|hits/);
  });

  it("refuses a clip too short to establish a pulse", () => {
    const r = readTempo(boomBap(120, 1).slice(0, Math.round(SR * 1.2)), SR);
    expect(r.usable).toBe(false);
    expect(explainTempo(r)).toMatch(/too short/);
  });

  it("refuses silence", () => {
    const r = readTempo(new Float32Array(SR * 5), SR);
    expect(r.usable).toBe(false);
    expect(r.hits).toBe(0);
  });

  it("reports what it measured even when it will not act on it", () => {
    const r = readTempo(new Float32Array(SR * 5), SR);
    expect(r.seconds).toBeCloseTo(5, 0);
    expect(typeof r.strength).toBe("number");
  });
});


describe("sample rates", () => {
  // The regression this exists for: analysis windows fixed in samples are a
  // different length in time at every rate, and a top band that runs to Nyquist
  // makes every share depend on the rate. Both were invisible until someone
  // recorded at 48 kHz.
  const RATES = [22050, 44100, 48000];

  it("hears the same hits whatever the recording rate", () => {
    for (const rate of RATES) {
      const hits = detectHits(boomBap(96, 2, rate), rate);
      expect(hits.length, `rate ${rate}`).toBeGreaterThanOrEqual(15);
      expect(hits.length, `rate ${rate}`).toBeLessThanOrEqual(17);
    }
  });

  it("classifies each voice the same whatever the recording rate", () => {
    for (const rate of RATES) {
      const one = (
        make: (x: Float32Array, at: number, gain?: number, rate?: number) => void
      ) => {
        resetNoise();
        const x = new Float32Array(rate);
        make(x, 0, undefined, rate);
        return classifyHit(hitFeatures(x, rate, 0)).voice;
      };
      expect(one(addKick), `kick at ${rate}`).toBe("kick");
      expect(one(addSnare), `snare at ${rate}`).toBe("snare");
      expect(one(addHat), `hat at ${rate}`).toBe("hat");
      expect(one(addTom), `tom at ${rate}`).toBe("tom");
    }
  });

  it("measures a snare's brightness consistently across rates", () => {
    // A snare's air share used to nearly double between 22 and 48 kHz purely
    // because the band was wider, which is what tipped it into "hat".
    const airs = RATES.map((rate) => {
      resetNoise();
      const x = new Float32Array(rate);
      addSnare(x, 0, 0.8, rate);
      return hitFeatures(x, rate, 0).airShare;
    });
    const spread = Math.max(...airs) - Math.min(...airs);
    expect(spread).toBeLessThan(0.2);
  });

  it("transcribes the same groove at 44.1 and 48 kHz", () => {
    for (const rate of [44100, 48000]) {
      const t = transcribeBeatbox(boomBap(96, 2, rate), rate, { bpm: 96 });
      const at = (lane: number[]) => lane.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
      expect(at(t.pattern.kick), `kick at ${rate}`).toEqual([0, 8, 16, 24]);
      expect(at(t.pattern.snare), `snare at ${rate}`).toEqual([4, 12, 20, 28]);
      expect(at(t.pattern.hat), `hat at ${rate}`).toEqual([2, 6, 10, 14, 18, 22, 26, 30]);
    }
  });
});
