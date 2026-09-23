import { describe, expect, it } from "vitest";
import { EXAMPLE_BEAT, formatBeat, laneAliases, parseBeat } from "./beatnotation";
import { ACCENT, GHOST, MAX_PATTERN_BARS, NORMAL, STEPS_PER_BAR, emptyPattern } from "./drums";

const hits = (lane: number[]) => lane.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);

describe("parseBeat", () => {
  it("reads the worked example the editor ships with", () => {
    const { pattern, bars, issues } = parseBeat(EXAMPLE_BEAT);
    expect(issues).toEqual([]);
    expect(bars).toBe(1);
    expect(hits(pattern!.kick)).toEqual([0, 4, 8, 12]);
    expect(hits(pattern!.snare)).toEqual([4, 12]);
    expect(hits(pattern!.hat)).toEqual([2, 6, 10, 14]);
  });

  it("accepts the short names people actually type", () => {
    const { pattern } = parseBeat("k x...\nsn ..x.\nhh .x.x");
    expect(hits(pattern!.kick)).toContain(0);
    expect(hits(pattern!.snare)).toContain(2);
    expect(hits(pattern!.hat)).toContain(1);
  });

  it("treats a short lane as a loop", () => {
    // "x." is what someone means by "hats on every other step", not one hat.
    const { pattern } = parseBeat("hat x.");
    expect(hits(pattern!.hat)).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
  });

  it("ignores bar lines, colons and blank lines", () => {
    const a = parseBeat("kick: x...x...|x...x...");
    const b = parseBeat("\n\nkick x...x...x...x...\n\n");
    expect(hits(a.pattern!.kick)).toEqual(hits(b.pattern!.kick));
    expect(a.issues).toEqual([]);
  });

  it("accepts the other characters people reach for", () => {
    const { pattern, issues } = parseBeat("kick X-*-o-_-1---.---");
    expect(issues).toEqual([]);
    // `_` is a rest and `1` is a hit, so the hits land at 0, 2, 4 and 8.
    expect(hits(pattern!.kick)).toEqual([0, 2, 4, 8]);
  });

  it("skips comments", () => {
    const { pattern, issues } = parseBeat("// the groove\nkick x...\n# and that is it");
    expect(issues).toEqual([]);
    expect(hits(pattern!.kick)).toContain(0);
  });

  it("grows to the number of bars that were typed", () => {
    const { pattern, bars } = parseBeat(`kick ${"x...".repeat(8)}`);
    expect(bars).toBe(2);
    expect(pattern!.kick.length).toBe(2 * STEPS_PER_BAR);
    expect(hits(pattern!.kick)).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
  });

  it("stops at the sequencer's maximum and says it did", () => {
    const { pattern, bars, issues } = parseBeat(`kick ${"x...".repeat(40)}`);
    expect(bars).toBe(MAX_PATTERN_BARS);
    expect(pattern!.kick.length).toBe(MAX_PATTERN_BARS * STEPS_PER_BAR);
    expect(issues.map((i) => i.message).join(" ")).toMatch(/cut off/);
  });

  it("continues a lane named again, so long parts can be written a bar a line", () => {
    const { pattern, bars } = parseBeat(
      ["kick x...x...x...x...", "kick x.......x.......", "hat  ..x...x...x...x.", "hat  ..x...x...x...x."].join("\n")
    );
    expect(bars).toBe(2);
    // Bar one from the first kick line, bar two from the second.
    expect(hits(pattern!.kick)).toEqual([0, 4, 8, 12, 16, 24]);
  });

  it("names the lane it does not recognise, and keeps the rest", () => {
    const { pattern, issues } = parseBeat("kick x...\ncowbell x...");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ line: 2 });
    expect(issues[0].message).toMatch(/cowbell/);
    // The good line still made it through.
    expect(hits(pattern!.kick)).toContain(0);
  });

  it("names the character it does not recognise", () => {
    const { issues } = parseBeat("kick x..?");
    expect(issues[0].message).toMatch(/"\?" is not a step/);
  });

  it("complains about a lane with nothing on it", () => {
    const { issues } = parseBeat("kick");
    expect(issues[0].message).toMatch(/no steps/);
  });

  it("returns nothing for nothing", () => {
    expect(parseBeat("").pattern).toBeNull();
    expect(parseBeat("\n\n  \n").pattern).toBeNull();
    expect(parseBeat("").issues).toEqual([]);
  });
});

describe("velocity in notation", () => {
  it("reads X as an accent, x as normal and o as a ghost note", () => {
    const { pattern } = parseBeat("snare Xxo.");
    expect(pattern!.snare.slice(0, 4)).toEqual([ACCENT, NORMAL, GHOST, 0]);
  });

  it("writes the velocities back out as the same glyphs", () => {
    const text = formatBeat(parseBeat("snare Xxo.").pattern!);
    expect(text).toMatch(/snare +Xxo\./);
  });

  it("round-trips a pattern with dynamics", () => {
    const { pattern } = parseBeat("kick  X..o|x..o\nsnare ..X.|..x.");
    expect(parseBeat(formatBeat(pattern!)).pattern).toEqual(pattern);
  });

  it("snaps a measured velocity to the nearest glyph when writing out", () => {
    // A beatboxed take carries continuous velocities; the notation has three
    // levels, so writing it out is the one lossy step in the round-trip.
    const p = emptyPattern(1);
    p.kick[0] = 0.95;
    p.kick[4] = 0.68;
    p.kick[8] = 0.31;
    expect(formatBeat(p)).toMatch(/kick +X\.\.\.x\.\.\.o/);
  });
});

describe("formatBeat", () => {
  it("round-trips a pattern through text and back", () => {
    const { pattern } = parseBeat(EXAMPLE_BEAT);
    const again = parseBeat(formatBeat(pattern!));
    expect(again.pattern).toEqual(pattern);
  });

  it("round-trips a two-bar pattern, bar lines and all", () => {
    const { pattern } = parseBeat(`kick ${"x...".repeat(8)}\nhat ${"..x.".repeat(8)}`);
    const round = parseBeat(formatBeat(pattern!));
    expect(round.pattern).toEqual(pattern);
  });

  it("leaves empty lanes out", () => {
    const { pattern } = parseBeat("kick x...");
    const text = formatBeat(pattern!);
    expect(text).toMatch(/^kick/m);
    expect(text).not.toMatch(/shaker/);
  });

  it("writes nothing for an empty pattern", () => {
    expect(formatBeat(emptyPattern(1))).toBe("");
  });
});

describe("laneAliases", () => {
  it("lists the short names first, so the help text is useful", () => {
    const kick = laneAliases("kick");
    expect(kick[0].length).toBeLessThanOrEqual(kick[kick.length - 1].length);
    expect(kick).toContain("k");
    expect(kick).toContain("kick");
  });
});
