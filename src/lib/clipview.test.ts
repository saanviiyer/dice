import { describe, expect, it } from "vitest";
import {
  STEP_ON_THRESHOLD,
  clipLook,
  isStacked,
  stepsForBars,
  stepsFromPeaks,
} from "./clipview";

describe("clipLook", () => {
  it("draws generated parts as blocks", () => {
    for (const role of ["beat", "drums", "pad", "bass", "arp", "chords"]) {
      expect(clipLook({ kind: "stem", role }), role).toBe("block");
    }
  });

  it("draws anything recorded as a performance", () => {
    // Someone beatboxing a drum part is still a performance, and the waveform
    // is what tells them which take it was.
    expect(clipLook({ kind: "loop", role: "beat" })).toBe("performance");
    expect(clipLook({ kind: "loop", role: "mic" })).toBe("performance");
    expect(clipLook({ kind: "loop", role: "vocal-stack" })).toBe("performance");
  });

  it("draws imported audio as a performance", () => {
    expect(clipLook({ kind: "stem", role: "imported" })).toBe("performance");
  });

  it("does not care about case", () => {
    expect(clipLook({ kind: "stem", role: "Beat" })).toBe("block");
  });
});

describe("isStacked", () => {
  it("recognises a vocal stack", () => {
    expect(isStacked({ role: "vocal-stack" })).toBe(true);
    expect(isStacked({ role: "mic" })).toBe(false);
  });
});

describe("stepsFromPeaks", () => {
  it("keeps the loudest sample in each step, not the average", () => {
    // A sharp transient occupying one sample of a step must survive; averaging
    // would smear it into nothing.
    const peaks = [0, 0, 1, 0, 0, 0, 0, 0];
    expect(stepsFromPeaks(peaks, 2)).toEqual([1, 0]);
  });

  it("normalises against the loudest step, so a quiet part still reads", () => {
    const steps = stepsFromPeaks([0.02, 0, 0.01, 0], 2);
    expect(steps[0]).toBe(1);
    expect(steps[1]).toBeLessThan(1);
  });

  it("returns the requested number of steps whatever it is given", () => {
    expect(stepsFromPeaks([1, 2, 3], 16)).toHaveLength(16);
    expect(stepsFromPeaks(new Array(400).fill(0.5), 16)).toHaveLength(16);
  });

  it("survives an empty or broken waveform", () => {
    expect(stepsFromPeaks([], 8)).toEqual(new Array(8).fill(0));
    expect(stepsFromPeaks([Number.NaN, Number.NaN], 4).every((v) => v === 0)).toBe(true);
    expect(stepsFromPeaks([0.5], 0)).toHaveLength(1);
  });

  it("marks a four-on-the-floor pattern where the hits are", () => {
    // One loud sample every four, over sixteen steps.
    const peaks = Array.from({ length: 64 }, (_, i) => (i % 16 === 0 ? 1 : 0));
    const steps = stepsFromPeaks(peaks, 16);
    const on = steps.map((v, i) => (v > STEP_ON_THRESHOLD ? i : -1)).filter((i) => i >= 0);
    expect(on).toEqual([0, 4, 8, 12]);
  });
});

describe("stepsForBars", () => {
  it("gives sixteen steps a bar, and never fewer than one bar's worth", () => {
    expect(stepsForBars(1)).toBe(16);
    expect(stepsForBars(4)).toBe(64);
    expect(stepsForBars(0)).toBe(16);
    expect(stepsForBars(-3)).toBe(16);
  });
});
