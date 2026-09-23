import { describe, expect, it } from "vitest";
import {
  crossedStrings,
  strum,
  strumDirection,
  strumVelocity,
  stringVoicing,
  sequenceStrum,
  type StrumNote,
} from "./strum";

const C_MAJOR = [60, 64, 67];

describe("stringVoicing", () => {
  it("repeats the chord upward so every string has a note", () => {
    expect(stringVoicing(C_MAJOR, 6)).toEqual([60, 64, 67, 72, 76, 79]);
  });

  it("is always ascending, so string 0 is the lowest", () => {
    const v = stringVoicing([67, 60, 64], 6);
    for (let i = 1; i < v.length; i += 1) expect(v[i]).toBeGreaterThan(v[i - 1]);
  });

  it("handles a four-note chord and fewer strings than notes", () => {
    expect(stringVoicing([60, 64, 67, 71], 6)).toEqual([60, 64, 67, 71, 72, 76]);
    expect(stringVoicing(C_MAJOR, 2)).toEqual([60, 64]);
  });

  it("returns nothing for nothing", () => {
    expect(stringVoicing([], 6)).toEqual([]);
    expect(stringVoicing(C_MAJOR, 0)).toEqual([]);
  });
});

describe("crossedStrings", () => {
  it("crosses every string on a full downward sweep", () => {
    expect(crossedStrings(0, 1, 6)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("returns them high to low on an upstroke", () => {
    expect(crossedStrings(1, 0, 6)).toEqual([5, 4, 3, 2, 1, 0]);
  });

  it("sounds only the strings the sweep actually reached", () => {
    // Strings sit at 1/12, 3/12, 5/12 ... so stopping at 0.5 reaches three.
    expect(crossedStrings(0, 0.5, 6)).toEqual([0, 1, 2]);
  });

  it("does not sound the same string twice when a gesture resumes", () => {
    // A drag reported as two segments meeting at the same point must not
    // re-trigger the string on the boundary.
    const first = crossedStrings(0, 0.5, 6);
    const second = crossedStrings(0.5, 1, 6);
    expect([...first, ...second]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set([...first, ...second]).size).toBe(6);
  });

  it("does nothing when the pointer has not moved", () => {
    expect(crossedStrings(0.5, 0.5, 6)).toEqual([]);
  });
});

describe("strumVelocity", () => {
  it("hits harder the faster you sweep", () => {
    const slow = strumVelocity(1, 1.2);
    const fast = strumVelocity(1, 0.08);
    expect(fast).toBeGreaterThan(slow);
    expect(fast).toBeLessThanOrEqual(1);
  });

  it("keeps a slow sweep clearly audible", () => {
    expect(strumVelocity(1, 5)).toBeGreaterThanOrEqual(0.35);
  });

  it("does not divide by zero", () => {
    expect(strumVelocity(1, 0)).toBe(1);
  });
});

describe("strum", () => {
  it("plays the chord low to high, spread over the time the sweep took", () => {
    const notes = strum({ chord: C_MAJOR, from: 0, to: 1, seconds: 0.24 });
    expect(notes.map((n) => n.midi)).toEqual([60, 64, 67, 72, 76, 79]);
    // Ascending in time, and inside the gesture's own duration.
    for (let i = 1; i < notes.length; i += 1) {
      expect(notes[i].at).toBeGreaterThan(notes[i - 1].at);
    }
    expect(notes[notes.length - 1].at).toBeLessThanOrEqual(0.24);
  });

  it("plays high to low on an upstroke", () => {
    const notes = strum({ chord: C_MAJOR, from: 1, to: 0, seconds: 0.2 });
    expect(notes.map((n) => n.midi)).toEqual([79, 76, 72, 67, 64, 60]);
  });

  it("spreads a wheel jump that reports no duration", () => {
    // Six notes at the same instant is a chord, not a strum.
    const notes = strum({ chord: C_MAJOR, from: 0, to: 1, seconds: 0 });
    expect(notes).toHaveLength(6);
    const gaps = notes.slice(1).map((n, i) => n.at - notes[i].at);
    for (const g of gaps) expect(g).toBeGreaterThan(0);
  });

  it("lets the tail of a strum ring a little softer", () => {
    const notes = strum({ chord: C_MAJOR, from: 0, to: 1, seconds: 0.2 });
    expect(notes[notes.length - 1].velocity).toBeLessThan(notes[0].velocity);
    for (const n of notes) {
      expect(n.velocity).toBeGreaterThan(0);
      expect(n.velocity).toBeLessThanOrEqual(1);
    }
  });

  it("plays nothing when the pointer has not moved, or there is no chord", () => {
    expect(strum({ chord: C_MAJOR, from: 0.5, to: 0.5, seconds: 0.1 })).toEqual([]);
    expect(strum({ chord: [], from: 0, to: 1, seconds: 0.1 })).toEqual([]);
  });

  it("plays only the strings a partial sweep reached", () => {
    const notes = strum({ chord: C_MAJOR, from: 0, to: 0.5, seconds: 0.1 });
    expect(notes.map((n) => n.midi)).toEqual([60, 64, 67]);
  });
});

describe("strumDirection", () => {
  it("names the stroke", () => {
    expect(strumDirection(0, 1)).toBe("down");
    expect(strumDirection(1, 0)).toBe("up");
    expect(strumDirection(0.5, 0.5)).toBe("none");
  });
});

describe("sequencing a scrolled strum", () => {
  const notes = (n: number): StrumNote[] =>
    Array.from({ length: n }, (_, i) => ({ midi: 60 + i, at: 0, velocity: 1 }));

  it("puts the strings one after another rather than on top of each other", () => {
    // A wheel burst hands over several strings with no time between them. The
    // first sounds straight away; the rest queue behind it.
    const { plays } = sequenceStrum(notes(4), 10, 0, 0.028, 0.4);
    const times = plays.map((p) => p.at);
    expect(times).toHaveLength(4);
    times.forEach((at, i) => expect(at).toBeCloseTo(10 + i * 0.028, 6));
  });

  it("queues the next burst behind the one still sounding", () => {
    const first = sequenceStrum(notes(3), 10, 0, 0.028, 0.4);
    // The next events arrive 10ms later; the strings must not overtake.
    const second = sequenceStrum(notes(3), 10.01, first.after, 0.028, 0.4);
    const times = [...first.plays, ...second.plays].map((p) => p.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(0.028 - 1e-9);
    }
  });

  it("keeps a gesture's own timing when it is already slower than the gap", () => {
    // A slow scroll spreads itself; the floor must not pull it back in.
    const spread: StrumNote[] = [
      { midi: 60, at: 0, velocity: 1 },
      { midi: 64, at: 0.09, velocity: 1 },
    ];
    const { plays } = sequenceStrum(spread, 5, 0, 0.028, 0.4);
    expect(plays.map((p) => p.at)).toEqual([5, 5.09]);
  });

  it("stops rather than playing a flurry after the fingers have stopped", () => {
    const { plays, after } = sequenceStrum(notes(40), 0, 0, 0.028, 0.4);
    expect(plays.length).toBeLessThan(40);
    expect(after).toBeLessThanOrEqual(0.4);
    expect(plays.every((p) => p.at <= 0.4)).toBe(true);
  });

  it("returns nothing for nothing, and reports the queue unmoved", () => {
    expect(sequenceStrum([], 3, 2.5, 0.028, 0.4)).toEqual({ plays: [], after: 2.5 });
  });
});
