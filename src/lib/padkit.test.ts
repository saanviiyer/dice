import { describe, expect, it } from "vitest";
import {
  PADS,
  PAD_KEYS,
  padBars,
  padForKey,
  padsCoverAllLanes,
  quantizeStep,
  velocityFor,
  withHit,
} from "./padkit";
import { ACCENT, DRUM_LANES, GHOST, NORMAL, STEPS_PER_BAR, emptyPattern } from "./drums";

describe("the pad layout", () => {
  it("gives every sequencer lane exactly one key", () => {
    expect(padsCoverAllLanes()).toBe(true);
    expect(PADS).toHaveLength(DRUM_LANES.length);
    expect(PADS.map((p) => p.voice)).toEqual(DRUM_LANES);
  });

  it("stays off the keys the studio already binds", () => {
    // Space, R (record), M (metronome) and Escape belong to the transport.
    for (const taken of ["r", "m", " ", "escape"]) {
      expect(PAD_KEYS).not.toContain(taken);
    }
  });

  it("is reachable without moving your hands", () => {
    const homeRow = "asdfghjkl;";
    for (const key of PAD_KEYS) expect(homeRow).toContain(key);
  });

  it("looks a key up whatever case it arrives in", () => {
    expect(padForKey("a")?.voice).toBe("kick");
    expect(padForKey("A")?.voice).toBe("kick");
    expect(padForKey("q")).toBeNull();
  });
});

describe("quantizeStep", () => {
  it("snaps to the nearest sixteenth", () => {
    expect(quantizeStep(4.2, 16)).toBe(4);
    expect(quantizeStep(4.6, 16)).toBe(5);
  });

  it("wraps a hit played just before the downbeat onto the downbeat", () => {
    // The regression this exists for: 15.7 is a hair early for the next bar,
    // and belongs on step 0, not on step 16 (which does not exist) or step 15.
    expect(quantizeStep(15.7, 16)).toBe(0);
    expect(quantizeStep(31.6, 32)).toBe(0);
  });

  it("snaps to eighths and quarters when asked", () => {
    expect(quantizeStep(3.4, 16, 2)).toBe(4);
    expect(quantizeStep(3.4, 16, 4)).toBe(4);
    // 5.9 is nearer quarter-note step 4 than step 8, so it goes back, not on.
    expect(quantizeStep(5.9, 16, 4)).toBe(4);
    expect(quantizeStep(6.5, 16, 4)).toBe(8);
    // And a coarse grid still wraps rather than running off the end.
    expect(quantizeStep(15.0, 16, 4)).toBe(0);
  });

  it("survives a nonsense cycle length", () => {
    expect(quantizeStep(3, 0)).toBe(0);
  });
});

describe("withHit", () => {
  it("writes a hit without touching the pattern it was given", () => {
    const before = emptyPattern(1);
    const after = withHit(before, "snare", 4);
    expect(after.snare[4]).toBe(NORMAL);
    expect(before.snare[4]).toBe(0);
  });

  it("records the velocity it was played at", () => {
    expect(withHit(emptyPattern(1), "snare", 4, ACCENT).snare[4]).toBe(ACCENT);
    expect(withHit(emptyPattern(1), "snare", 4, GHOST).snare[4]).toBe(GHOST);
  });

  it("lets a louder pass win, and does not let a softer one undo it", () => {
    // Playing a part in twice and hitting the accent harder the second time
    // should keep the accent, not average it away.
    const accented = withHit(emptyPattern(1), "kick", 0, ACCENT);
    expect(withHit(accented, "kick", 0, GHOST).kick[0]).toBe(ACCENT);
    const ghosted = withHit(emptyPattern(1), "kick", 0, GHOST);
    expect(withHit(ghosted, "kick", 0, ACCENT).kick[0]).toBe(ACCENT);
  });

  it("clamps a velocity outside the range", () => {
    expect(withHit(emptyPattern(1), "kick", 0, 9).kick[0]).toBe(1);
    expect(withHit(emptyPattern(1), "kick", 0, -1).kick[0]).toBe(0);
  });

  it("ignores a step outside the pattern rather than growing it", () => {
    const p = withHit(emptyPattern(1), "kick", 99);
    expect(p.kick).toHaveLength(STEPS_PER_BAR);
    expect(p.kick.every((v) => v === 0)).toBe(true);
  });
});

describe("velocityFor", () => {
  it("makes shift the accent", () => {
    expect(velocityFor(true)).toBe(ACCENT);
    expect(velocityFor(false)).toBe(NORMAL);
    expect(velocityFor(true)).toBeGreaterThan(velocityFor(false));
  });
});

describe("padBars", () => {
  it("counts the bars a pattern spans", () => {
    expect(padBars(emptyPattern(1))).toBe(1);
    expect(padBars(emptyPattern(4))).toBe(4);
  });
});
