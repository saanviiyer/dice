import { describe, expect, it } from "vitest";
import {
  MAX_BASS_LANES,
  MAX_BASS_LAYERS,
  addBassLane,
  addBassNote,
  bassStackBars,
  bassStackFromPattern,
  bassStackSteps,
  bassStackVoicesAt,
  duplicateBassLane,
  emptyBassStack,
  moveBassLane,
  normalizeBassLanes,
  removeBassLane,
  updateBassLane,
  bassLayerCount,
  bassNoteAt,
  bassNotesAt,
  bassPatternFromPreset,
  clearBassPattern,
  emptyBassPattern,
  isBassPattern,
  normalizeBassPattern,
  removeBassNote,
  setBassNote,
  setBassPatternBars,
  toggleBassNote,
} from "./bass";
import { STEPS_PER_BAR } from "./drums";

describe("bass patterns", () => {
  it("creates and resizes patterns by tiling the existing phrase", () => {
    const one = setBassNote(emptyBassPattern(1), 3, 36);
    const two = setBassPatternBars(one, 2);
    expect(two.notes).toHaveLength(32);
    expect(two.notes[3]).toEqual([36]);
    expect(two.notes[19]).toEqual([36]);
  });

  it("does not share note arrays between the tiled copies", () => {
    // Tiling with a shared reference would make editing bar two silently edit
    // bar one as well.
    const two = setBassPatternBars(setBassNote(emptyBassPattern(1), 0, 36), 2);
    const edited = addBassNote(two, 16, 43);
    expect(edited.notes[16]).toEqual([36, 43]);
    expect(edited.notes[0]).toEqual([36]);
  });

  it("builds useful key-aware presets", () => {
    const c = bassPatternFromPreset("Root pulse", 0);
    const d = bassPatternFromPreset("Root pulse", 2);
    expect(c.notes[0]).toEqual([36]);
    expect(d.notes[0]).toEqual([38]);
    expect(
      bassPatternFromPreset("808 syncopation", 0).notes.filter((s) => s.length > 0)
    ).toHaveLength(4);
  });

  it("wraps playback, clears, and validates data", () => {
    const pattern = setBassNote(emptyBassPattern(1), 15, 48);
    expect(bassNoteAt(pattern, 31)).toBe(48);
    expect(bassNotesAt(pattern, 31)).toEqual([48]);
    expect(clearBassPattern(pattern).notes.every((s) => s.length === 0)).toBe(true);
    expect(isBassPattern(pattern)).toBe(true);
    expect(isBassPattern({ notes: [[36]] })).toBe(false);
    expect(isBassPattern({ notes: new Array(16).fill([99]) })).toBe(false);
  });
});

describe("layered basslines", () => {
  it("stacks a fifth and an octave onto a root", () => {
    let p = setBassNote(emptyBassPattern(1), 0, 36);
    p = addBassNote(p, 0, 43);
    p = addBassNote(p, 0, 48);
    expect(bassNotesAt(p, 0)).toEqual([36, 43, 48]);
    // The single-note view still gives the foundation.
    expect(bassNoteAt(p, 0)).toBe(36);
  });

  it("keeps a stack ascending and free of duplicates", () => {
    let p = addBassNote(emptyBassPattern(1), 0, 48);
    p = addBassNote(p, 0, 36);
    p = addBassNote(p, 0, 48);
    expect(bassNotesAt(p, 0)).toEqual([36, 48]);
  });

  it("stops at the layer limit rather than growing without bound", () => {
    let p = emptyBassPattern(1);
    for (const midi of [30, 34, 36, 40, 43, 48]) p = addBassNote(p, 0, midi);
    expect(bassLayerCount(p, 0)).toBe(MAX_BASS_LAYERS);
  });

  it("removes one note and leaves the rest", () => {
    let p = setBassNote(emptyBassPattern(1), 0, [36, 43, 48]);
    p = removeBassNote(p, 0, 43);
    expect(bassNotesAt(p, 0)).toEqual([36, 48]);
  });

  it("toggles a note in and out, which is what a grid click does", () => {
    let p = emptyBassPattern(1);
    p = toggleBassNote(p, 4, 40);
    expect(bassNotesAt(p, 4)).toEqual([40]);
    p = toggleBassNote(p, 4, 47);
    expect(bassNotesAt(p, 4)).toEqual([40, 47]);
    p = toggleBassNote(p, 4, 40);
    expect(bassNotesAt(p, 4)).toEqual([47]);
  });

  it("clamps notes into the bass range", () => {
    const p = setBassNote(emptyBassPattern(1), 0, [1, 500]);
    expect(bassNotesAt(p, 0)).toEqual([24, 72]);
  });

  it("never mutates the pattern it was given", () => {
    const before = setBassNote(emptyBassPattern(1), 0, 36);
    const after = addBassNote(before, 0, 43);
    expect(bassNotesAt(before, 0)).toEqual([36]);
    expect(bassNotesAt(after, 0)).toEqual([36, 43]);
  });

  it("ignores edits outside the pattern", () => {
    const p = emptyBassPattern(1);
    expect(addBassNote(p, 99, 36).notes).toHaveLength(STEPS_PER_BAR);
    expect(addBassNote(p, -1, 36).notes.every((s) => s.length === 0)).toBe(true);
  });
});

describe("normalizeBassPattern", () => {
  it("reads a bassline saved before layers existed", () => {
    // One note or null per step: an old project must open sounding the same.
    const legacy = { notes: new Array(STEPS_PER_BAR).fill(null) };
    legacy.notes[0] = 36;
    legacy.notes[8] = 43;
    const p = normalizeBassPattern(legacy)!;
    expect(bassNotesAt(p, 0)).toEqual([36]);
    expect(bassNotesAt(p, 8)).toEqual([43]);
    expect(bassNotesAt(p, 1)).toEqual([]);
    expect(isBassPattern(p)).toBe(true);
  });

  it("reads the layered shape unchanged", () => {
    const p = setBassNote(emptyBassPattern(1), 0, [36, 43]);
    expect(normalizeBassPattern(p)).toEqual(p);
  });

  it("rejects junk", () => {
    expect(normalizeBassPattern(null)).toBeNull();
    expect(normalizeBassPattern({ notes: "nope" })).toBeNull();
    expect(normalizeBassPattern({ notes: [1, 2, 3] })).toBeNull();
    expect(normalizeBassPattern({ notes: new Array(16).fill("x") })).toBeNull();
  });
});

describe("stacked basslines", () => {
  const stack = () => bassStackFromPattern(setBassNote(emptyBassPattern(1), 0, 36));

  it("starts as one lane holding the bassline it was given", () => {
    const lanes = stack();
    expect(lanes).toHaveLength(1);
    expect(bassNotesAt(lanes[0].pattern, 0)).toEqual([36]);
    expect(lanes[0].muted).toBe(false);
    expect(lanes[0].gain).toBe(1);
    expect(emptyBassStack(2)[0].pattern.notes).toHaveLength(2 * STEPS_PER_BAR);
  });

  it("adds a lane the length of the stack, so the layers line up", () => {
    // A one-bar lane added under a four-bar line would wrap against it from the
    // first bar, which reads as a bug rather than as a part.
    const long = updateBassLane(stack(), "bass-1", {
      pattern: setBassPatternBars(emptyBassPattern(1), 4),
    });
    const lanes = addBassLane(long);
    expect(lanes).toHaveLength(2);
    expect(lanes[1].pattern.notes).toHaveLength(4 * STEPS_PER_BAR);
    expect(lanes[1].id).not.toBe(lanes[0].id);
  });

  it("stops at the lane limit rather than dropping the oldest part", () => {
    let lanes = stack();
    for (let i = 0; i < MAX_BASS_LANES + 3; i++) lanes = addBassLane(lanes);
    expect(lanes).toHaveLength(MAX_BASS_LANES);
    expect(bassNotesAt(lanes[0].pattern, 0)).toEqual([36]);
  });

  it("duplicates a lane underneath itself without sharing its notes", () => {
    const lanes = duplicateBassLane(stack(), "bass-1");
    expect(lanes).toHaveLength(2);
    expect(bassNotesAt(lanes[1].pattern, 0)).toEqual([36]);
    const edited = updateBassLane(lanes, lanes[1].id, {
      pattern: setBassNote(lanes[1].pattern, 0, 48),
    });
    expect(bassNotesAt(edited[0].pattern, 0)).toEqual([36]);
    expect(bassNotesAt(edited[1].pattern, 0)).toEqual([48]);
  });

  it("keeps the last lane, because the stack must have somewhere to write", () => {
    const one = stack();
    expect(removeBassLane(one, "bass-1")).toHaveLength(1);
    const two = addBassLane(one);
    expect(removeBassLane(two, two[1].id).map((l) => l.id)).toEqual(["bass-1"]);
    expect(removeBassLane(two, "nope")).toHaveLength(2);
  });

  it("edits one lane and leaves the others alone", () => {
    const lanes = updateBassLane(addBassLane(stack()), "bass-1", {
      name: "  Sub  ",
      muted: true,
      gain: 4,
    });
    expect(lanes[0]).toMatchObject({ name: "Sub", muted: true, gain: 1 });
    expect(lanes[1]).toMatchObject({ name: "Bass 2", muted: false, gain: 1 });
    expect(updateBassLane(lanes, "bass-1", { name: "   " })[0].name).toBe("Bass 1");
    expect(updateBassLane(lanes, "bass-1", { gain: -2 })[0].gain).toBe(0);
  });

  it("reorders lanes, and does nothing at either end", () => {
    const lanes = addBassLane(stack());
    expect(moveBassLane(lanes, "bass-1", 1).map((l) => l.id)).toEqual(["bass-2", "bass-1"]);
    expect(moveBassLane(lanes, "bass-1", -1).map((l) => l.id)).toEqual(["bass-1", "bass-2"]);
    expect(moveBassLane(lanes, "bass-2", 1).map((l) => l.id)).toEqual(["bass-1", "bass-2"]);
  });

  it("hands every lane's notes to the scheduler with that lane's level", () => {
    let lanes = addBassLane(stack(), setBassNote(emptyBassPattern(1), 0, 48));
    lanes = updateBassLane(lanes, lanes[1].id, { gain: 0.5 });
    expect(bassStackVoicesAt(lanes, 0)).toEqual([
      { midi: 36, gain: 1 },
      { midi: 48, gain: 0.5 },
    ]);
  });

  it("leaves muted and silent lanes out of the schedule", () => {
    const lanes = addBassLane(stack(), setBassNote(emptyBassPattern(1), 0, 48));
    expect(bassStackVoicesAt(updateBassLane(lanes, "bass-1", { muted: true }), 0)).toEqual([
      { midi: 48, gain: 1 },
    ]);
    expect(bassStackVoicesAt(updateBassLane(lanes, "bass-2", { gain: 0 }), 0)).toEqual([
      { midi: 36, gain: 1 },
    ]);
  });

  it("wraps each lane at its own length, so a short lane repeats under a long one", () => {
    const long = setBassNote(setBassPatternBars(emptyBassPattern(1), 2), 16, 48);
    const lanes = addBassLane(stack(), long);
    expect(bassStackBars(lanes)).toBe(2);
    expect(bassStackSteps(lanes)).toBe(2 * STEPS_PER_BAR);
    // The one-bar sub comes round again on bar two; the two-bar line does not.
    expect(bassStackVoicesAt(lanes, 16).map((v) => v.midi)).toEqual([36, 48]);
  });
});

describe("normalizeBassLanes", () => {
  it("opens a project saved before basslines could be stacked", () => {
    const legacy = { notes: new Array(STEPS_PER_BAR).fill(null) };
    legacy.notes[0] = 36;
    const lanes = normalizeBassLanes(legacy)!;
    expect(lanes).toHaveLength(1);
    expect(bassNotesAt(lanes[0].pattern, 0)).toEqual([36]);
  });

  it("reads a stack back, repairing the parts it can", () => {
    const lanes = normalizeBassLanes([
      { id: "bass-1", name: "Sub", pattern: emptyBassPattern(1), muted: "yes", gain: 9 },
      { pattern: emptyBassPattern(1) },
    ])!;
    expect(lanes[0]).toMatchObject({ id: "bass-1", name: "Sub", muted: false, gain: 1 });
    expect(lanes[1]).toMatchObject({ id: "bass-2", name: "Bass 2" });
  });

  it("never lets two lanes share an id, which would edit both at once", () => {
    const lanes = normalizeBassLanes([
      { id: "same", pattern: emptyBassPattern(1) },
      { id: "same", pattern: emptyBassPattern(1) },
    ])!;
    expect(new Set(lanes.map((l) => l.id)).size).toBe(2);
  });

  it("keeps at most the lane limit, and rejects junk", () => {
    const many = new Array(MAX_BASS_LANES + 2).fill({ pattern: emptyBassPattern(1) });
    expect(normalizeBassLanes(many)).toHaveLength(MAX_BASS_LANES);
    expect(normalizeBassLanes([])).toBeNull();
    expect(normalizeBassLanes(null)).toBeNull();
    expect(normalizeBassLanes([{ pattern: { notes: "nope" } }])).toBeNull();
    expect(normalizeBassLanes(["nope"])).toBeNull();
  });
});
