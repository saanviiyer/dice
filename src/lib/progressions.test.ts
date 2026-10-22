import { describe, expect, it } from "vitest";
import { PROGRESSIONS, progressionInKey, searchProgressions } from "./progressions";
import { parseProgression } from "./music";

describe("the progression library", () => {
  it("writes every progression in a key the chord box can read", () => {
    // The search is only useful if what it hands over parses, so every entry
    // in the library goes through the same parser the studio uses.
    for (const p of PROGRESSIONS) {
      for (const tonic of [0, 5, 7, 11]) {
        const text = progressionInKey(p, tonic);
        const slots = parseProgression(text);
        expect(slots).toHaveLength(p.steps.length);
        expect(slots.every((s) => s.chord !== null)).toBe(true);
      }
    }
  });

  it("puts the four chords in the key it was asked for", () => {
    const axis = PROGRESSIONS.find((p) => p.id === "axis")!;
    expect(progressionInKey(axis, 0)).toBe("C G Am F");
    expect(progressionInKey(axis, 7)).toBe("G D Em C");
  });

  it("keeps sevenths and minors through a transpose", () => {
    const jazz = PROGRESSIONS.find((p) => p.id === "jazz251")!;
    expect(progressionInKey(jazz, 0)).toBe("Dm7 G7 Cmaj7");
    expect(progressionInKey(jazz, 2)).toBe("Em7 A7 Dmaj7");
  });

  it("wraps around the octave rather than running off the top", () => {
    const doowop = PROGRESSIONS.find((p) => p.id === "doowop")!;
    expect(progressionInKey(doowop, 11)).toBe("B G#m E F#");
  });

  it("gives every entry a unique id and a shape", () => {
    const ids = PROGRESSIONS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PROGRESSIONS) {
      expect(p.steps.length).toBeGreaterThan(2);
      expect(p.roman).not.toBe("");
      expect(p.tags.length).toBeGreaterThan(0);
    }
  });
});

describe("searching it", () => {
  const names = (q: string) => searchProgressions(q).map((m) => m.progression.name);

  it("finds a progression by name", () => {
    expect(names("doo-wop")[0]).toBe("Doo-wop");
    expect(names("canon")[0]).toBe("Canon");
  });

  it("finds one by what it sounds like", () => {
    expect(names("sad")).toContain("Minor pop");
    expect(names("jazz")).toContain("Two five one");
    expect(names("flamenco")[0]).toBe("Andalusian cadence");
  });

  it("finds one by its roman numerals", () => {
    expect(names("ii7")).toContain("Two five one");
    expect(names("vi - IV")).toContain("Sensitive female");
  });

  it("puts a name match above a tag match", () => {
    // Someone typing "blues" means the twelve-bar, not whatever else is
    // tagged with it.
    expect(names("blues")[0]).toBe("Twelve-bar blues");
  });

  it("matches a partial word, the way someone types while thinking", () => {
    expect(names("blu")[0]).toBe("Twelve-bar blues");
    expect(names("pach")[0]).toBe("Canon");
  });

  it("offers the common ones when nothing has been typed", () => {
    const empty = searchProgressions("");
    expect(empty).toHaveLength(6);
    expect(empty[0].progression.name).toBe("Four chords");
  });

  it("finds nothing rather than guessing", () => {
    expect(searchProgressions("xyzzy")).toEqual([]);
  });

  it("keeps the list short enough to look at", () => {
    expect(searchProgressions("pop", 3)).toHaveLength(3);
  });
});
