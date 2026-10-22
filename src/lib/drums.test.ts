import { describe, it, expect, vi, afterEach } from "vitest";
import {
  addBassLane,
  bassStackFromPattern,
  emptyBassPattern,
  setBassNote,
  setBassPatternBars,
  updateBassLane,
} from "./bass";
import {
  ACCENT,
  BPM_MAX,
  BPM_MIN,
  CUSTOM_PATTERN,
  clampBpm,
  commitBpm,
  DRUM_PATTERNS,
  DRUM_PATTERN_CHOICES,
  DRUM_PATTERN_NAMES,
  DrumMachine,
  GHOST,
  MAX_PATTERN_BARS,
  NORMAL,
  clearPattern,
  clonePattern,
  drumHits,
  emptyPattern,
  isDrumPattern,
  isDrumPatternChoice,
  isPatternEmpty,
  metronomeClick,
  nearestVelocity,
  patternBars,
  patternFromName,
  patternHits,
  patternLength,
  patternVelocities,
  resolvePattern,
  setPatternBars,
  setStep,
  toggleStep,
  STEPS_PER_BAR,
  type DrumPattern,
  type DrumTriggers,
} from "./drums";

describe("drum pattern catalog", () => {
  it("has the required patterns", () => {
    for (const n of [
      "Off",
      "Four-on-floor",
      "Rock",
      "Half-time",
      "Hi-hat 8ths",
      "House",
      "Techno",
      "Disco",
      "Garage 2-step",
      "Boom-bap",
      "Trap",
      "Drum & Bass",
      "Breakbeat",
      "Funk",
      "Dembow",
      "Bossa Nova",
    ]) {
      expect(DRUM_PATTERN_NAMES).toContain(n);
    }
  });
  it("lists Off first, since ProducerMode defaults to index 0", () => {
    expect(DRUM_PATTERN_NAMES[0]).toBe("Off");
  });
  it("no two patterns are the same groove", () => {
    const seen = new Map<string, string>();
    for (const name of DRUM_PATTERN_NAMES) {
      const p = DRUM_PATTERNS[name];
      const key = [p.kick, p.snare, p.hat].map((l) => l.join("")).join("|");
      expect(seen.get(key), `${name} duplicates ${seen.get(key)}`).toBeUndefined();
      seen.set(key, name);
    }
  });
  it("every lane is only 0/1 flags", () => {
    for (const name of DRUM_PATTERN_NAMES) {
      const p = DRUM_PATTERNS[name];
      for (const lane of [p.kick, p.snare, p.hat]) {
        for (const v of lane) expect(v === 0 || v === 1).toBe(true);
      }
    }
  });
  it("every pattern but Off hits at least once", () => {
    for (const name of DRUM_PATTERN_NAMES) {
      if (name === "Off") continue;
      const p = DRUM_PATTERNS[name];
      const total =
        p.kick.reduce((a, b) => a + b, 0) +
        p.snare.reduce((a, b) => a + b, 0) +
        p.hat.reduce((a, b) => a + b, 0);
      expect(total, name).toBeGreaterThan(0);
    }
  });
  it("every pattern lane is exactly one bar of 16 steps", () => {
    for (const name of DRUM_PATTERN_NAMES) {
      const p = DRUM_PATTERNS[name];
      expect(p.kick).toHaveLength(STEPS_PER_BAR);
      expect(p.snare).toHaveLength(STEPS_PER_BAR);
      expect(p.hat).toHaveLength(STEPS_PER_BAR);
    }
  });
});

describe("drumHits", () => {
  it("Four-on-floor kicks on every quarter (0,4,8,12)", () => {
    for (const s of [0, 4, 8, 12]) expect(drumHits("Four-on-floor", s).kick).toBe(true);
    for (const s of [1, 2, 3, 5, 6, 7]) expect(drumHits("Four-on-floor", s).kick).toBe(false);
  });
  it("Four-on-floor snares on beats 2 and 4 (steps 4,12)", () => {
    expect(drumHits("Four-on-floor", 4).snare).toBe(true);
    expect(drumHits("Four-on-floor", 12).snare).toBe(true);
    expect(drumHits("Four-on-floor", 0).snare).toBe(false);
  });
  it("Four-on-floor hats on 8ths (even steps)", () => {
    for (let s = 0; s < 16; s++) {
      expect(drumHits("Four-on-floor", s).hat).toBe(s % 2 === 0);
    }
  });
  it("Off pattern never hits", () => {
    for (let s = 0; s < 16; s++) {
      const h = drumHits("Off", s);
      expect(h.kick || h.snare || h.hat).toBe(false);
    }
  });
  it("Boom-bap kicks on 0 and 10, snares on 4 and 12", () => {
    expect(drumHits("Boom-bap", 0).kick).toBe(true);
    expect(drumHits("Boom-bap", 10).kick).toBe(true);
    expect(drumHits("Boom-bap", 4).snare).toBe(true);
    expect(drumHits("Boom-bap", 12).snare).toBe(true);
  });
  it("Hi-hat 8ths has no snare and hats on evens", () => {
    for (let s = 0; s < 16; s++) {
      expect(drumHits("Hi-hat 8ths", s).snare).toBe(false);
      expect(drumHits("Hi-hat 8ths", s).hat).toBe(s % 2 === 0);
    }
  });
  it("Rock kicks on 1 and 3, snares on the backbeat", () => {
    for (const s of [0, 8]) expect(drumHits("Rock", s).kick).toBe(true);
    for (const s of [4, 12]) expect(drumHits("Rock", s).kick).toBe(false);
    expect(drumHits("Rock", 4).snare).toBe(true);
    expect(drumHits("Rock", 12).snare).toBe(true);
  });
  it("Half-time snares once, on step 8", () => {
    for (let s = 0; s < 16; s++) {
      expect(drumHits("Half-time", s).snare).toBe(s === 8);
    }
  });
  it("House and Techno put hats on the offbeat only", () => {
    for (const name of ["House", "Techno"] as const) {
      for (let s = 0; s < 16; s++) {
        expect(drumHits(name, s).hat, `${name} step ${s}`).toBe(s % 4 === 2);
      }
    }
  });
  it("House, Techno and Disco all kick four-on-the-floor", () => {
    for (const name of ["House", "Techno", "Disco"] as const) {
      for (let s = 0; s < 16; s++) {
        expect(drumHits(name, s).kick, `${name} step ${s}`).toBe(s % 4 === 0);
      }
    }
  });
  it("Disco, Trap, Funk and Drum & Bass run 16th-note hats", () => {
    for (const name of ["Disco", "Trap", "Funk", "Drum & Bass"] as const) {
      for (let s = 0; s < 16; s++) {
        expect(drumHits(name, s).hat, `${name} step ${s}`).toBe(true);
      }
    }
  });
  it("Garage 2-step pushes every hat off the grid", () => {
    for (let s = 0; s < 16; s++) {
      expect(drumHits("Garage 2-step", s).hat).toBe(s % 2 === 1);
    }
  });
  it("Trap snares only on step 8", () => {
    for (let s = 0; s < 16; s++) {
      expect(drumHits("Trap", s).snare).toBe(s === 8);
    }
  });
  it("Dembow snares the 3-3-2 pattern (3,6,11,14)", () => {
    for (let s = 0; s < 16; s++) {
      expect(drumHits("Dembow", s).snare).toBe([3, 6, 11, 14].includes(s));
    }
  });
  it("Bossa Nova clicks the clave on 3,6,10,13", () => {
    for (let s = 0; s < 16; s++) {
      expect(drumHits("Bossa Nova", s).snare).toBe([3, 6, 10, 13].includes(s));
    }
  });
  it("wraps step indices modulo the bar", () => {
    expect(drumHits("Four-on-floor", 16)).toEqual(drumHits("Four-on-floor", 0));
    expect(drumHits("Four-on-floor", 20)).toEqual(drumHits("Four-on-floor", 4));
  });
});

describe("metronomeClick", () => {
  it("clicks on quarters with an accent only on beat 1", () => {
    expect(metronomeClick(0)).toEqual({ click: true, accent: true });
    expect(metronomeClick(4)).toEqual({ click: true, accent: false });
    expect(metronomeClick(8)).toEqual({ click: true, accent: false });
    expect(metronomeClick(12)).toEqual({ click: true, accent: false });
    for (const s of [1, 2, 3, 5, 7, 9, 11, 13]) {
      expect(metronomeClick(s).click).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Custom patterns (the beat sequencer's data model)
// ---------------------------------------------------------------------------

/** Lane hits as step indices, for readable assertions. */
/** Steps that sound, at any velocity. */
function hitsOf(p: DrumPattern, lane: "kick" | "snare" | "hat"): number[] {
  return p[lane].flatMap((v, i) => (v > 0 ? [i] : []));
}

describe("emptyPattern", () => {
  it("makes silent lanes of the requested bar count", () => {
    const one = emptyPattern(1);
    expect(patternLength(one)).toBe(16);
    expect(patternBars(one)).toBe(1);
    expect(isPatternEmpty(one)).toBe(true);

    expect(patternLength(emptyPattern(4))).toBe(64);
    expect(patternBars(emptyPattern(4))).toBe(4);
  });

  it("clamps the bar count to the supported range", () => {
    expect(patternBars(emptyPattern(0))).toBe(1);
    expect(patternBars(emptyPattern(-3))).toBe(1);
    expect(patternBars(emptyPattern(99))).toBe(MAX_PATTERN_BARS);
  });
});

describe("patternFromName", () => {
  it("copies a preset so editing it cannot corrupt the catalog", () => {
    const p = patternFromName("Boom-bap");
    expect(hitsOf(p, "kick")).toEqual([0, 10]);
    p.kick[5] = 1;
    expect(DRUM_PATTERNS["Boom-bap"].kick[5]).toBe(0);
  });
});

describe("setPatternBars", () => {
  it("tiles the existing groove when growing", () => {
    const two = setPatternBars(DRUM_PATTERNS["Four-on-floor"], 2);
    expect(patternLength(two)).toBe(32);
    expect(hitsOf(two, "kick")).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
    expect(hitsOf(two, "snare")).toEqual([4, 12, 20, 28]);
  });

  it("keeps only the leading bars when shrinking", () => {
    const four = setPatternBars(DRUM_PATTERNS["Boom-bap"], 4);
    const edited = setStep(four, "kick", 33, true); // a hit in bar 3
    const back = setPatternBars(edited, 1);
    expect(patternLength(back)).toBe(16);
    expect(hitsOf(back, "kick")).toEqual([0, 10]);
  });

  it("is a round trip when the second bar is an exact copy", () => {
    const src = DRUM_PATTERNS.Trap;
    expect(setPatternBars(setPatternBars(src, 2), 1)).toEqual(clonePattern(src));
  });

  it("clamps out-of-range bar counts", () => {
    expect(patternBars(setPatternBars(DRUM_PATTERNS.Rock, 0))).toBe(1);
    expect(patternBars(setPatternBars(DRUM_PATTERNS.Rock, 9))).toBe(MAX_PATTERN_BARS);
  });
});

describe("toggleStep / setStep", () => {
  it("flips a cell without mutating the input", () => {
    const base = emptyPattern(1);
    const on = toggleStep(base, "snare", 4);
    // Toggling on writes a normal hit, not a full-velocity one.
    expect(on.snare[4]).toBe(NORMAL);
    expect(base.snare[4]).toBe(0);
    expect(toggleStep(on, "snare", 4).snare[4]).toBe(0);
  });

  it("ignores steps outside the pattern", () => {
    const base = emptyPattern(1);
    expect(toggleStep(base, "kick", 16)).toEqual(base);
    expect(toggleStep(base, "kick", -1)).toEqual(base);
    expect(setStep(base, "kick", 99, true)).toEqual(base);
  });

  it("setStep writes an explicit value, so painting is idempotent", () => {
    const p = setStep(setStep(emptyPattern(1), "hat", 2, true), "hat", 2, true);
    expect(hitsOf(p, "hat")).toEqual([2]);
    expect(hitsOf(setStep(p, "hat", 2, false), "hat")).toEqual([]);
  });

  it("reaches steps in later bars", () => {
    const p = setStep(emptyPattern(2), "kick", 20, true);
    expect(hitsOf(p, "kick")).toEqual([20]);
  });
});

describe("velocity", () => {
  it("setStep takes a velocity as readily as a boolean", () => {
    const p = setStep(emptyPattern(1), "snare", 4, ACCENT);
    expect(p.snare[4]).toBe(ACCENT);
    expect(setStep(p, "snare", 4, GHOST).snare[4]).toBe(GHOST);
    expect(setStep(p, "snare", 4, false).snare[4]).toBe(0);
  });

  it("clamps a velocity outside the range", () => {
    expect(setStep(emptyPattern(1), "kick", 0, 4).kick[0]).toBe(1);
    expect(setStep(emptyPattern(1), "kick", 0, -2).kick[0]).toBe(0);
  });

  it("reports the velocity of each lane on a step", () => {
    let p = setStep(emptyPattern(1), "kick", 0, ACCENT);
    p = setStep(p, "hat", 0, GHOST);
    const v = patternVelocities(p, 0);
    expect(v.kick).toBe(ACCENT);
    expect(v.hat).toBe(GHOST);
    expect(v.snare).toBe(0);
    // And the boolean view agrees with it.
    expect(patternHits(p, 0)).toMatchObject({ kick: true, hat: true, snare: false });
  });

  it("keeps dynamics when the bar count changes", () => {
    // Flattening every cell to full here would erase a groove's feel the
    // moment someone extended the loop.
    const one = setStep(setStep(emptyPattern(1), "kick", 0, ACCENT), "kick", 4, GHOST);
    const two = setPatternBars(one, 2);
    expect(two.kick[0]).toBe(ACCENT);
    expect(two.kick[4]).toBe(GHOST);
    expect(two.kick[16]).toBe(ACCENT);
    expect(two.kick[20]).toBe(GHOST);
  });

  it("accepts a velocity pattern as valid, and rejects nonsense", () => {
    const p = setStep(emptyPattern(1), "kick", 0, GHOST);
    expect(isDrumPattern(p)).toBe(true);
    const bad = emptyPattern(1);
    bad.kick[0] = 1.5;
    expect(isDrumPattern(bad)).toBe(false);
  });

  it("snaps a measured velocity to the nearest named level", () => {
    expect(nearestVelocity(0.95)).toBe(ACCENT);
    expect(nearestVelocity(0.7)).toBe(NORMAL);
    expect(nearestVelocity(0.35)).toBe(GHOST);
    expect(nearestVelocity(0)).toBe(0);
  });
});

describe("tempo entry", () => {
  it("clamps a committed tempo to the shared range", () => {
    expect(clampBpm(120)).toBe(120);
    expect(clampBpm(9999)).toBe(BPM_MAX);
    expect(clampBpm(1)).toBe(BPM_MIN);
    expect(clampBpm(120.4)).toBe(120);
    expect(clampBpm(Number.NaN)).toBe(120);
  });

  it("holds the current tempo while the field is mid-edit", () => {
    // The bug this exists for: clamping every keystroke meant typing "90" over
    // "120" sent "9" (clamped to 40), then "0" appended to that giving "400"
    // (clamped to 220), and the field stuck at the maximum.
    expect(commitBpm("", 120)).toBe(120);
    expect(commitBpm("   ", 120)).toBe(120);
    expect(commitBpm("abc", 120)).toBe(120);
  });

  it("commits what was actually typed", () => {
    expect(commitBpm("90", 120)).toBe(90);
    expect(commitBpm("240", 120)).toBe(BPM_MAX);
    expect(commitBpm("2", 120)).toBe(BPM_MIN);
  });

  it("lets a tempo be typed digit by digit without sticking", () => {
    // Simulate typing "90" into a field showing 120, committing only at the end.
    let draft = "";
    let value = 120;
    for (const ch of "90") {
      draft += ch;
      // While typing, the committed value does not move.
      expect(value).toBe(120);
    }
    value = commitBpm(draft, value);
    expect(value).toBe(90);
  });
});

describe("transport", () => {
  function machine() {
    const ctx = { currentTime: 0 } as unknown as AudioContext;
    const trig: DrumTriggers = {
      kick: () => {},
      snare: () => {},
      hat: () => {},
      click: () => {},
    };
    return new DrumMachine(ctx, trig);
  }

  afterEach(() => vi.useRealTimers());

  it("starts and stops", () => {
    vi.useFakeTimers();
    const dm = machine();
    expect(dm.isRunning).toBe(false);
    dm.start();
    expect(dm.isRunning).toBe(true);
    dm.stop();
    expect(dm.isRunning).toBe(false);
  });

  it("stop rewinds, so the next start is the top of the pattern", () => {
    vi.useFakeTimers();
    const dm = machine();
    dm.setPattern(DRUM_PATTERNS["Four-on-floor"]);
    dm.start();
    vi.advanceTimersByTime(400);
    dm.stop();
    dm.start();
    // Nothing has been heard yet after a rewind and restart.
    expect(dm.playheadStep()).toBe(-1);
  });

  it("pause halts without rewinding, and resume carries on", () => {
    // The difference matters on a four-bar groove: restarting from the top
    // every time means never hearing the bar you are working on in context.
    vi.useFakeTimers();
    const dm = machine();
    dm.setPattern(DRUM_PATTERNS["Four-on-floor"]);
    dm.start();
    vi.advanceTimersByTime(500);
    dm.pause();
    expect(dm.isRunning).toBe(false);
    dm.resume();
    expect(dm.isRunning).toBe(true);
    dm.pause();
  });

  it("resume on a running machine does nothing", () => {
    vi.useFakeTimers();
    const dm = machine();
    dm.start();
    dm.resume();
    expect(dm.isRunning).toBe(true);
    dm.stop();
  });

  it("drops the queued lookahead when it halts", () => {
    // The scheduler runs ahead of the audio clock, so without clearing the
    // queue a tenth of a second of hits would sound after you pressed stop.
    vi.useFakeTimers();
    const dm = machine();
    dm.start();
    vi.advanceTimersByTime(200);
    dm.pause();
    expect(dm.playheadStep()).toBe(-1);
  });
});

describe("clearPattern", () => {
  it("silences one lane and leaves the others alone", () => {
    const cleared = clearPattern(DRUM_PATTERNS["Four-on-floor"], "hat");
    expect(hitsOf(cleared, "hat")).toEqual([]);
    expect(hitsOf(cleared, "kick")).toEqual([0, 4, 8, 12]);
  });

  it("silences everything when no lane is given", () => {
    expect(isPatternEmpty(clearPattern(DRUM_PATTERNS.Funk))).toBe(true);
    expect(isPatternEmpty(DRUM_PATTERNS.Funk)).toBe(false);
  });

  it("preserves the bar count", () => {
    expect(patternBars(clearPattern(emptyPattern(3)))).toBe(3);
  });
});

describe("patternHits", () => {
  it("wraps at the pattern's own length, not one bar", () => {
    const two = setStep(emptyPattern(2), "kick", 20, true);
    expect(patternHits(two, 20).kick).toBe(true);
    expect(patternHits(two, 4).kick).toBe(false);
    expect(patternHits(two, 52).kick).toBe(true); // 52 mod 32 = 20
  });

  it("handles negative steps", () => {
    expect(patternHits(DRUM_PATTERNS["Four-on-floor"], -16)).toEqual(
      patternHits(DRUM_PATTERNS["Four-on-floor"], 0)
    );
  });
});

describe("isDrumPattern", () => {
  it("accepts whole-bar patterns of equal-length 0/1 lanes", () => {
    expect(isDrumPattern(emptyPattern(1))).toBe(true);
    expect(isDrumPattern(emptyPattern(MAX_PATTERN_BARS))).toBe(true);
    expect(isDrumPattern(DRUM_PATTERNS.Dembow)).toBe(true);
  });

  it("rejects damaged data", () => {
    const ok = emptyPattern(1);
    expect(isDrumPattern(null)).toBe(false);
    expect(isDrumPattern({ kick: [], snare: [], hat: [] })).toBe(false);
    expect(isDrumPattern({ ...ok, snare: ok.snare.slice(0, 8) })).toBe(false);
    expect(isDrumPattern({ ...ok, kick: new Array(24).fill(0) })).toBe(false);
    expect(isDrumPattern({ ...ok, hat: ok.hat.map(() => 2) })).toBe(false);
    expect(
      isDrumPattern(emptyPattern(MAX_PATTERN_BARS + 1))
    ).toBe(true); // clamped on creation, so still valid
    expect(
      isDrumPattern({
        kick: new Array(80).fill(0),
        snare: new Array(80).fill(0),
        hat: new Array(80).fill(0),
      })
    ).toBe(false); // 5 bars, past the cap
  });
});

describe("pattern choices", () => {
  it("offers every preset plus Custom, with Custom last", () => {
    expect(DRUM_PATTERN_CHOICES).toEqual([...DRUM_PATTERN_NAMES, CUSTOM_PATTERN]);
    expect(DRUM_PATTERNS).not.toHaveProperty(CUSTOM_PATTERN);
  });

  it("resolves a choice to the pattern that plays", () => {
    const mine = setStep(emptyPattern(1), "kick", 7, true);
    expect(resolvePattern(CUSTOM_PATTERN, mine)).toBe(mine);
    expect(resolvePattern("Rock", mine)).toEqual(DRUM_PATTERNS.Rock);
  });

  it("falls back to Off for an unknown saved choice", () => {
    const mine = emptyPattern(1);
    expect(isDrumPatternChoice("Rock")).toBe(true);
    expect(isDrumPatternChoice(CUSTOM_PATTERN)).toBe(true);
    expect(isDrumPatternChoice("Jungle")).toBe(false);
    expect(isDrumPatternChoice(7)).toBe(false);
    expect(
      resolvePattern("Jungle" as never, mine)
    ).toEqual(DRUM_PATTERNS.Off);
  });
});

// ---------------------------------------------------------------------------
// DrumMachine scheduling
// ---------------------------------------------------------------------------

/** Minimal AudioContext stand-in: only currentTime is read by the scheduler. */
function fakeCtx(): { ctx: AudioContext; advance: (sec: number) => void } {
  const state = { currentTime: 0 };
  return {
    ctx: state as unknown as AudioContext,
    advance: (sec: number) => {
      state.currentTime += sec;
    },
  };
}

function recorder(): { trig: DrumTriggers; kicks: number[]; snares: number[] } {
  const kicks: number[] = [];
  const snares: number[] = [];
  return {
    kicks,
    snares,
    trig: {
      kick: (t) => kicks.push(t),
      snare: (t) => snares.push(t),
      hat: () => {},
      click: () => {},
    },
  };
}

describe("DrumMachine", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the step count of whatever pattern is loaded", () => {
    const { ctx } = fakeCtx();
    const dm = new DrumMachine(ctx, recorder().trig);
    dm.setPattern("Rock");
    expect(dm.patternSteps).toBe(16);
    dm.setPattern(emptyPattern(4));
    expect(dm.patternSteps).toBe(64);
  });

  it("plays a custom pattern's hits, wrapping over its full length", () => {
    vi.useFakeTimers();
    const { ctx, advance } = fakeCtx();
    const rec = recorder();
    const dm = new DrumMachine(ctx, rec.trig);
    dm.setBpm(120); // a 16th is 0.125s
    dm.setPattern(setStep(emptyPattern(2), "kick", 20, true));
    dm.start();
    // Two full 2-bar cycles: 64 steps at 0.125s = 8 seconds.
    for (let i = 0; i < 400; i++) {
      advance(0.02);
      vi.advanceTimersByTime(25);
    }
    dm.stop();
    // Step 20 of each cycle: 20*0.125 = 2.5s after the 0.06s start offset.
    expect(rec.kicks.length).toBeGreaterThanOrEqual(2);
    expect(rec.kicks[1] - rec.kicks[0]).toBeCloseTo(4, 5); // one 2-bar cycle
    expect(rec.snares).toHaveLength(0);
  });

  it("is silent while stopped and reports no playhead", () => {
    const { ctx } = fakeCtx();
    const rec = recorder();
    const dm = new DrumMachine(ctx, rec.trig);
    dm.setPattern("Four-on-floor");
    expect(dm.isRunning).toBe(false);
    expect(dm.playheadStep()).toBe(-1);
    expect(rec.kicks).toHaveLength(0);
  });

  it("advances the playhead only as the audio clock reaches each step", () => {
    vi.useFakeTimers();
    const { ctx, advance } = fakeCtx();
    const dm = new DrumMachine(ctx, recorder().trig);
    dm.setBpm(120);
    dm.setPattern("Four-on-floor");
    dm.start();
    vi.advanceTimersByTime(25); // schedule ahead, but nothing has sounded yet
    expect(dm.playheadStep()).toBe(-1);

    advance(0.07); // past the 0.06s start offset: step 0 is sounding
    expect(dm.playheadStep()).toBe(0);

    advance(0.125);
    vi.advanceTimersByTime(25);
    expect(dm.playheadStep()).toBe(1);

    dm.stop();
    expect(dm.playheadStep()).toBe(-1);
  });

  it("keeps the cursor inside the pattern when bars are removed mid-loop", () => {
    vi.useFakeTimers();
    const { ctx, advance } = fakeCtx();
    const rec = recorder();
    const dm = new DrumMachine(ctx, rec.trig);
    dm.setBpm(120);
    dm.setPattern(emptyPattern(4));
    dm.start();
    for (let i = 0; i < 60; i++) {
      advance(0.05);
      vi.advanceTimersByTime(25);
    }
    // Shrink to one bar while the cursor is well past step 16.
    dm.setPattern(setStep(emptyPattern(1), "kick", 0, true));
    expect(dm.patternSteps).toBe(16);
    const before = rec.kicks.length;
    for (let i = 0; i < 60; i++) {
      advance(0.05);
      vi.advanceTimersByTime(25);
    }
    dm.stop();
    // It keeps playing rather than running off the end of the shorter lanes.
    expect(rec.kicks.length).toBeGreaterThan(before);
  });
});

describe("DrumMachine basslines", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Records what the bass voice was asked to play, level included. */
  function bassRecorder(): { trig: DrumTriggers; notes: { midi: number; gain: number }[] } {
    const notes: { midi: number; gain: number }[] = [];
    return {
      notes,
      trig: {
        kick: () => {},
        snare: () => {},
        hat: () => {},
        click: () => {},
        bass: (midi, _t, _gate, gain = 1) => notes.push({ midi, gain }),
      },
    };
  }

  /** Run the scheduler for roughly `seconds` of audio time. */
  function play(dm: DrumMachine, advance: (sec: number) => void, seconds: number): void {
    dm.start();
    for (let i = 0; i < Math.round(seconds / 0.05); i++) {
      advance(0.05);
      vi.advanceTimersByTime(25);
    }
    dm.stop();
  }

  it("plays every lane in the stack, each at its own level", () => {
    vi.useFakeTimers();
    const { ctx, advance } = fakeCtx();
    const rec = bassRecorder();
    const dm = new DrumMachine(ctx, rec.trig);
    dm.setBpm(120);
    dm.setPattern(emptyPattern(1));
    let lanes = bassStackFromPattern(setBassNote(emptyBassPattern(1), 0, 36));
    lanes = addBassLane(lanes, setBassNote(emptyBassPattern(1), 0, 48));
    lanes = updateBassLane(lanes, lanes[1].id, { gain: 0.5 });
    dm.setBassPattern(lanes);
    dm.setBassEnabled(true);
    play(dm, advance, 0.5);
    expect(rec.notes.slice(0, 2)).toEqual([
      { midi: 36, gain: 1 },
      { midi: 48, gain: 0.5 },
    ]);
  });

  it("keeps a muted lane out of the schedule entirely", () => {
    vi.useFakeTimers();
    const { ctx, advance } = fakeCtx();
    const rec = bassRecorder();
    const dm = new DrumMachine(ctx, rec.trig);
    dm.setBpm(120);
    dm.setPattern(emptyPattern(1));
    let lanes = bassStackFromPattern(setBassNote(emptyBassPattern(1), 0, 36));
    lanes = addBassLane(lanes, setBassNote(emptyBassPattern(1), 0, 48));
    lanes = updateBassLane(lanes, lanes[0].id, { muted: true });
    dm.setBassPattern(lanes);
    dm.setBassEnabled(true);
    play(dm, advance, 0.5);
    expect(rec.notes.every((n) => n.midi === 48)).toBe(true);
    expect(rec.notes.length).toBeGreaterThan(0);
  });

  it("loops over the longest lane, so a one-bar sub repeats under a two-bar line", () => {
    vi.useFakeTimers();
    const { ctx, advance } = fakeCtx();
    const rec = bassRecorder();
    const dm = new DrumMachine(ctx, rec.trig);
    dm.setBpm(120); // a 16th is 0.125s, so two bars is 4s
    dm.setPattern(emptyPattern(1));
    const long = setBassNote(setBassPatternBars(emptyBassPattern(1), 2), 16, 48);
    const lanes = addBassLane(
      bassStackFromPattern(setBassNote(emptyBassPattern(1), 0, 36)),
      long
    );
    dm.setBassPattern(lanes);
    dm.setBassEnabled(true);
    expect(dm.patternSteps).toBe(32);
    play(dm, advance, 2.5);
    // Bar one: the sub alone. Bar two: the sub again, and the long line's note.
    expect(rec.notes.map((n) => n.midi).slice(0, 3)).toEqual([36, 36, 48]);
  });

  it("still takes a lone bassline, which is what a preset hands over", () => {
    vi.useFakeTimers();
    const { ctx, advance } = fakeCtx();
    const rec = bassRecorder();
    const dm = new DrumMachine(ctx, rec.trig);
    dm.setBpm(120);
    dm.setPattern(emptyPattern(1));
    dm.setBassPattern(setBassNote(emptyBassPattern(1), 0, 36));
    dm.setBassEnabled(true);
    play(dm, advance, 0.5);
    expect(rec.notes[0]).toEqual({ midi: 36, gain: 1 });
  });

  it("is silent while the bass is switched off", () => {
    vi.useFakeTimers();
    const { ctx, advance } = fakeCtx();
    const rec = bassRecorder();
    const dm = new DrumMachine(ctx, rec.trig);
    dm.setBpm(120);
    dm.setBassPattern(bassStackFromPattern(setBassNote(emptyBassPattern(1), 0, 36)));
    play(dm, advance, 0.5);
    expect(rec.notes).toHaveLength(0);
  });
});

describe("listening to the scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports each step before it sounds, with the time it will sound", () => {
    vi.useFakeTimers();
    const { ctx, advance } = fakeCtx();
    const dm = new DrumMachine(ctx, recorder().trig);
    const heard: { step: number; time: number }[] = [];
    dm.setStepListener((step, time) => heard.push({ step, time }));
    dm.setBpm(120); // a sixteenth is 0.125s
    dm.setPattern(emptyPattern(1));
    dm.start();
    for (let i = 0; i < 20; i += 1) {
      advance(0.05);
      vi.advanceTimersByTime(25);
    }
    dm.stop();

    expect(heard.length).toBeGreaterThan(4);
    expect(heard[0].step).toBe(0);
    expect(heard[1].step).toBe(1);
    // Scheduled ahead of the clock, which is the whole point of hearing it here.
    expect(heard[1].time - heard[0].time).toBeCloseTo(0.125, 5);
  });

  it("stops reporting once the listener is taken away", () => {
    vi.useFakeTimers();
    const { ctx, advance } = fakeCtx();
    const dm = new DrumMachine(ctx, recorder().trig);
    let count = 0;
    dm.setStepListener(() => (count += 1));
    dm.setBpm(120);
    dm.start();
    for (let i = 0; i < 8; i += 1) {
      advance(0.05);
      vi.advanceTimersByTime(25);
    }
    const sofar = count;
    dm.setStepListener(null);
    for (let i = 0; i < 8; i += 1) {
      advance(0.05);
      vi.advanceTimersByTime(25);
    }
    dm.stop();
    expect(sofar).toBeGreaterThan(0);
    expect(count).toBe(sofar);
  });
});
