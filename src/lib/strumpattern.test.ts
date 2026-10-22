import { describe, expect, it } from "vitest";
import {
  STRUM_PATTERNS,
  chordIndexAt,
  strokeAt,
  strokeSeconds,
  strokeSweep,
} from "./strumpattern";
import { STEPS_PER_BAR } from "./drums";

describe("strum patterns", () => {
  it("keeps every stroke inside the bar", () => {
    for (const p of STRUM_PATTERNS) {
      expect(p.strokes.length).toBeGreaterThan(0);
      for (const s of p.strokes) {
        expect(s.step).toBeGreaterThanOrEqual(0);
        expect(s.step).toBeLessThan(STEPS_PER_BAR);
        expect(s.velocity).toBeGreaterThan(0);
        expect(s.velocity).toBeLessThanOrEqual(1);
      }
      // Two strokes on one sixteenth would be one stroke played twice.
      expect(new Set(p.strokes.map((s) => s.step)).size).toBe(p.strokes.length);
    }
  });

  it("starts on the plainest pattern", () => {
    const first = STRUM_PATTERNS[0];
    expect(first.strokes.map((s) => s.step)).toEqual([0, 4, 8, 12]);
    expect(first.strokes.every((s) => s.direction === "down")).toBe(true);
  });

  it("finds the stroke on a step and nothing between them", () => {
    const beats = STRUM_PATTERNS[0];
    expect(strokeAt(beats, 0)?.direction).toBe("down");
    expect(strokeAt(beats, 4)?.direction).toBe("down");
    expect(strokeAt(beats, 5)).toBeNull();
  });

  it("repeats the pattern bar after bar", () => {
    const beats = STRUM_PATTERNS[0];
    expect(strokeAt(beats, STEPS_PER_BAR)).not.toBeNull();
    expect(strokeAt(beats, STEPS_PER_BAR * 3 + 4)).not.toBeNull();
    expect(strokeAt(beats, STEPS_PER_BAR + 5)).toBeNull();
  });

  it("plays up strokes softer than down strokes", () => {
    // A hand coming back up catches fewer strings, at an angle.
    for (const p of STRUM_PATTERNS) {
      const downs = p.strokes.filter((s) => s.direction === "down");
      const ups = p.strokes.filter((s) => s.direction === "up");
      if (downs.length === 0 || ups.length === 0) continue;
      const loudestUp = Math.max(...ups.map((s) => s.velocity));
      const loudestDown = Math.max(...downs.map((s) => s.velocity));
      expect(loudestUp).toBeLessThan(loudestDown);
    }
  });
});

describe("following a progression", () => {
  it("gives each chord a bar, then starts again", () => {
    expect(chordIndexAt(0, 4)).toBe(0);
    expect(chordIndexAt(STEPS_PER_BAR, 4)).toBe(1);
    expect(chordIndexAt(STEPS_PER_BAR * 3 + 15, 4)).toBe(3);
    expect(chordIndexAt(STEPS_PER_BAR * 4, 4)).toBe(0);
  });

  it("can hold a chord for more than a bar", () => {
    expect(chordIndexAt(STEPS_PER_BAR, 4, 2)).toBe(0);
    expect(chordIndexAt(STEPS_PER_BAR * 2, 4, 2)).toBe(1);
  });

  it("has nothing to play when there are no chords", () => {
    expect(chordIndexAt(0, 0)).toBe(-1);
  });
});

describe("the stroke itself", () => {
  it("runs low to high on the way down and back on the way up", () => {
    expect(strokeSweep("down")).toEqual({ from: 0, to: 1 });
    expect(strokeSweep("up")).toEqual({ from: 1, to: 0 });
  });

  it("crosses the strings faster at a faster tempo", () => {
    expect(strokeSeconds(180, "down")).toBeLessThan(strokeSeconds(70, "down"));
    expect(strokeSeconds(120, "up")).toBeLessThan(strokeSeconds(120, "down"));
  });

  it("stays inside a range that still reads as one strum", () => {
    for (const bpm of [20, 70, 120, 300, 0, Number.NaN]) {
      for (const dir of ["down", "up"] as const) {
        const secs = strokeSeconds(bpm, dir);
        expect(secs).toBeGreaterThanOrEqual(0.012);
        expect(secs).toBeLessThanOrEqual(0.09);
      }
    }
  });
});
