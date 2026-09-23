import { describe, expect, it } from "vitest";
import {
  cleanProjectName,
  isDiceProject,
  newProjectId,
  projectSummary,
  removeSummary,
  sanitizeCompositionState,
  sanitizeDrumState,
  sanitizeIndex,
  savedAgo,
  upsertSummary,
  type ProjectSummary,
} from "./projectStore";
import { CUSTOM_PATTERN, emptyPattern, setStep } from "./drums";
import { addBassLane, bassPatternFromPreset, bassStackFromPattern, updateBassLane } from "./bass";
import { createArrangement } from "./arrangement";

describe("cleanProjectName", () => {
  it("trims, removes control characters and supplies a fallback", () => {
    expect(cleanProjectName("  Night\u0000 Drive  ")).toBe("Night  Drive");
    expect(cleanProjectName("   ")).toBe("Untitled project");
  });

  it("caps project names at 80 characters", () => {
    expect(cleanProjectName("x".repeat(120))).toHaveLength(80);
  });
});

describe("isDiceProject", () => {
  const valid = {
    version: 1,
    name: "Demo",
    savedAt: "2026-08-17T00:00:00.000Z",
    bpm: 120,
    bars: 2,
    mixer: { version: 1, loopDurationSec: 0, tracks: [] },
  };

  it("accepts a versioned project and rejects malformed input", () => {
    expect(isDiceProject(valid)).toBe(true);
    expect(isDiceProject({ ...valid, bpm: Number.NaN })).toBe(false);
    expect(isDiceProject({ ...valid, mixer: { tracks: [] } })).toBe(false);
    expect(isDiceProject(null)).toBe(false);
  });
});

describe("sanitizeDrumState", () => {
  const custom = setStep(emptyPattern(2), "kick", 20, true);

  it("accepts a saved choice and beat", () => {
    expect(sanitizeDrumState({ choice: CUSTOM_PATTERN, custom })).toEqual({
      choice: CUSTOM_PATTERN,
      custom,
    });
    expect(sanitizeDrumState({ choice: "Boom-bap", custom })?.choice).toBe("Boom-bap");
  });

  it("returns null for missing or damaged drum state", () => {
    expect(sanitizeDrumState(undefined)).toBeNull();
    expect(sanitizeDrumState({ choice: "Jungle", custom })).toBeNull();
    expect(sanitizeDrumState({ choice: CUSTOM_PATTERN })).toBeNull();
    expect(
      sanitizeDrumState({ choice: CUSTOM_PATTERN, custom: { kick: [1], snare: [], hat: [] } })
    ).toBeNull();
  });

  it("a damaged beat does not invalidate the project that carries it", () => {
    const project = {
      version: 1 as const,
      name: "Demo",
      savedAt: "2026-08-17T00:00:00.000Z",
      bpm: 120,
      bars: 2,
      mixer: { version: 1 as const, loopDurationSec: 0, tracks: [] },
      drums: { choice: "Jungle", custom: null } as never,
    };
    expect(isDiceProject(project)).toBe(true);
    expect(sanitizeDrumState(project.drums)).toBeNull();
  });

  it("still loads projects saved before the sequencer existed", () => {
    const old = {
      version: 1,
      name: "Old",
      savedAt: "2026-08-17T00:00:00.000Z",
      bpm: 96,
      bars: 4,
      mixer: { version: 1, loopDurationSec: 0, tracks: [] },
    };
    expect(isDiceProject(old)).toBe(true);
  });

  it("upgrades original three-lane custom beats", () => {
    const legacy = { kick: new Array(16).fill(0), snare: new Array(16).fill(0), hat: new Array(16).fill(0) };
    const restored = sanitizeDrumState({ choice: CUSTOM_PATTERN, custom: legacy });
    expect(restored?.custom.clap).toEqual(new Array(16).fill(0));
    expect(restored?.custom.tom).toEqual(new Array(16).fill(0));
    expect(restored?.custom.shaker).toEqual(new Array(16).fill(0));
  });
});

describe("sanitizeCompositionState", () => {
  const bass = bassPatternFromPreset("Root pulse", 0);
  const composition = { bassOn: true, bass, arrangement: createArrangement(8) };

  it("accepts bass and arrangement data without risking the main project", () => {
    expect(sanitizeCompositionState(composition)).toMatchObject(composition);
    expect(sanitizeCompositionState({ ...composition, bassOn: "yes" })).toBeNull();
  });

  it("opens a project saved before basslines could be stacked, as one lane", () => {
    const restored = sanitizeCompositionState(composition)!;
    expect(restored.bassLanes).toHaveLength(1);
    expect(restored.bassLanes[0].pattern).toEqual(bass);
  });

  it("restores a whole stack of basslines", () => {
    const lanes = updateBassLane(
      addBassLane(bassStackFromPattern(bass)),
      "bass-2",
      { name: "Octave", gain: 0.5 }
    );
    const restored = sanitizeCompositionState({ ...composition, bassLanes: lanes })!;
    expect(restored.bassLanes).toEqual(lanes);
  });

  it("falls back to the single bassline when the stack is damaged", () => {
    // The foundation is sitting right there in `bass`, so a corrupt stack must
    // not cost someone their bassline as well as their layers.
    const restored = sanitizeCompositionState({
      ...composition,
      bassLanes: [{ pattern: { notes: "nope" } }],
    })!;
    expect(restored.bassLanes).toHaveLength(1);
    expect(restored.bassLanes[0].pattern).toEqual(bass);
  });
});


describe("the projects index", () => {
  const card = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
    id: "a",
    name: "Take one",
    savedAt: "2026-08-24T12:00:00.000Z",
    bpm: 120,
    tracks: 3,
    ...over,
  });

  it("summarises a project without carrying its audio", () => {
    const project = {
      version: 1 as const,
      name: "  Loud one  ",
      savedAt: "2026-08-24T12:00:00.000Z",
      bpm: 128.4,
      bars: 2,
      mixer: { version: 1 as const, loopDurationSec: 4, tracks: [{}, {}] },
    } as never;
    const s = projectSummary("p1", project);
    expect(s).toEqual({
      id: "p1",
      name: "Loud one",
      savedAt: "2026-08-24T12:00:00.000Z",
      bpm: 128,
      tracks: 2,
    });
    // Crucially, no audio came along for the ride.
    expect(JSON.stringify(s)).not.toMatch(/channels|buffer/);
  });

  it("puts a re-saved project back at the front", () => {
    const index = [card({ id: "a" }), card({ id: "b" }), card({ id: "c" })];
    const next = upsertSummary(index, card({ id: "c", name: "Newer" }));
    expect(next.map((s) => s.id)).toEqual(["c", "a", "b"]);
    expect(next).toHaveLength(3);
    expect(next[0].name).toBe("Newer");
  });

  it("adds a project it has not seen", () => {
    expect(upsertSummary([card({ id: "a" })], card({ id: "z" })).map((s) => s.id)).toEqual([
      "z",
      "a",
    ]);
  });

  it("removes a project", () => {
    const index = [card({ id: "a" }), card({ id: "b" })];
    expect(removeSummary(index, "a").map((s) => s.id)).toEqual(["b"]);
    expect(removeSummary(index, "nope")).toHaveLength(2);
  });

  it("drops corrupt entries rather than blanking the whole list", () => {
    const mixed = [card({ id: "good" }), null, { id: 5 }, { id: "x" }, card({ id: "also" })];
    expect(sanitizeIndex(mixed).map((s) => s.id)).toEqual(["good", "also"]);
    expect(sanitizeIndex("nonsense")).toEqual([]);
    expect(sanitizeIndex(undefined)).toEqual([]);
  });

  it("makes ids that sort in the order projects were created", () => {
    const a = newProjectId(1_000_000, () => 0.1);
    const b = newProjectId(2_000_000, () => 0.1);
    expect(a < b).toBe(true);
    expect(a).not.toBe(newProjectId(1_000_000, () => 0.9));
  });
});

describe("savedAgo", () => {
  const now = Date.parse("2026-08-24T12:00:00.000Z");
  const at = (mins: number) => new Date(now - mins * 60000).toISOString();

  it("says how long ago a project was saved", () => {
    expect(savedAgo(at(0), now)).toBe("just now");
    expect(savedAgo(at(5), now)).toBe("5 min ago");
    expect(savedAgo(at(90), now)).toBe("2 hours ago");
    expect(savedAgo(at(60), now)).toBe("1 hour ago");
    expect(savedAgo(at(60 * 48), now)).toBe("2 days ago");
  });

  it("says nothing rather than NaN for a bad timestamp", () => {
    expect(savedAgo("not a date", now)).toBe("");
  });
});
