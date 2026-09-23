import { describe, expect, it, vi } from "vitest";
import type { SessionAnalysis, TrackAnalysis, TrackMeta } from "./ears";
import { analyzeSession, analyzeTrack } from "./ears";
import {
  describeSession,
  diagnose,
  interpretGoal,
  offlinePlanner,
  projectTrack,
  proposeFix,
  remotePlanner,
  runProducerAgent,
  scoreMix,
  summarizeRun,
  type AgentEvent,
  type Goal,
  type Planner,
} from "./producerAgent";
import { toolSchemas, type AgentMixerPort } from "./producerTools";

const SR = 22050;

// ---------------------------------------------------------------------------
// Synthetic parts
// ---------------------------------------------------------------------------

/** A sung line: harmonic stack, phrased with gaps. */
function voxLike(amp: number, seconds = 6): Float32Array {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i += 1) {
    const t = i / SR;
    const phrase = t % 2 < 1.3 ? 1 : 0;
    x[i] =
      phrase *
      amp *
      (Math.sin(2 * Math.PI * 330 * t) +
        0.6 * Math.sin(2 * Math.PI * 660 * t) +
        0.35 * Math.sin(2 * Math.PI * 1320 * t));
  }
  return x;
}

/** A held pad, sitting in the same midrange as the voice. */
function padLike(amp: number, seconds = 6): Float32Array {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i += 1) {
    const t = i / SR;
    x[i] = amp * (Math.sin(2 * Math.PI * 520 * t) + 0.8 * Math.sin(2 * Math.PI * 780 * t));
  }
  return x;
}

/** A low sustained part, for low-end tests. */
function bassLike(amp: number, seconds = 6): Float32Array {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i += 1) {
    const t = i / SR;
    x[i] = amp * Math.sin(2 * Math.PI * 80 * t);
  }
  return x;
}

// ---------------------------------------------------------------------------
// A mixer stand-in the agent can drive
// ---------------------------------------------------------------------------

interface FakeTrack extends TrackMeta {
  data: Float32Array;
}

function fakeMixer(specs: Array<Partial<FakeTrack> & { name: string; data: Float32Array }>) {
  const tracks: FakeTrack[] = specs.map((s, i) => ({
    id: i + 1,
    role: "loop",
    volume: 1,
    pan: 0,
    tone: 1,
    lowCut: 20,
    space: 0,
    muted: false,
    ...s,
  }));
  const find = (id: number) => tracks.find((t) => t.id === id);
  const backing = vi.fn(async () => {
    tracks.push({
      id: tracks.length + 1,
      name: "AI: beat",
      role: "beat",
      volume: 1,
      pan: 0,
      tone: 1,
      lowCut: 20,
      space: 0,
      muted: false,
      data: (() => {
        const x = new Float32Array(SR * 6);
        const period = Math.round(SR / 2);
        for (let s = 0; s < x.length; s += period) {
          for (let i = 0; i < 400 && s + i < x.length; i += 1) {
            x[s + i] = (Math.random() * 2 - 1) * 0.3 * Math.exp(-i / 60);
          }
        }
        return x;
      })(),
    });
  });

  const port: AgentMixerPort = {
    setVolume: (id, v) => {
      const t = find(id);
      if (t) t.volume = v;
    },
    setPan: (id, v) => {
      const t = find(id);
      if (t) t.pan = v;
    },
    setTone: (id, v) => {
      const t = find(id);
      if (t) t.tone = v;
    },
    setSpace: (id, v) => {
      const t = find(id);
      if (t) t.space = v;
    },
    setMute: (id, v) => {
      const t = find(id);
      if (t) t.muted = v;
    },
  };

  return {
    tracks,
    port,
    backing,
    withBacking(): AgentMixerPort {
      return { ...port, requestBacking: backing };
    },
    getTracks: (): TrackMeta[] =>
      tracks.map(({ data: _data, ...meta }) => ({ ...meta })),
    readAudio: (id: number) => {
      const t = find(id);
      return t ? { data: t.data, sampleRate: SR } : null;
    },
    snapshot: () =>
      tracks.map((t) => ({ id: t.id, volume: t.volume, pan: t.pan, tone: t.tone, space: t.space })),
  };
}

/** Roll a fake mixer up into a session, the way the agent does. */
function sessionOf(mixer: ReturnType<typeof fakeMixer>): SessionAnalysis {
  return analyzeSession(
    mixer.getTracks().map((m) => {
      const audio = mixer.readAudio(m.id)!;
      return projectTrack(analyzeTrack({ ...m, tone: 1 }, audio.data, audio.sampleRate), m);
    })
  );
}

// ---------------------------------------------------------------------------

describe("interpretGoal", () => {
  it("maps plain requests onto goals", () => {
    expect(interpretGoal("I can't hear my voice")).toBe("vocal-forward");
    expect(interpretGoal("the low end is muddy")).toBe("clean-low-end");
    expect(interpretGoal("open it up a bit")).toBe("wide");
    expect(interpretGoal("make the stack blend together")).toBe("glue");
    expect(interpretGoal("even out the levels")).toBe("balance");
  });

  it("falls back to a full pass when nothing matches", () => {
    expect(interpretGoal("asdf")).toBe("radio-ready");
    expect(interpretGoal("")).toBe("radio-ready");
  });
});

// ---------------------------------------------------------------------------

function fakeAnalysis(over: Partial<TrackAnalysis>): TrackAnalysis {
  return {
    id: 1,
    name: "t",
    part: "harmonic",
    loudnessDb: -18,
    peakDb: -8,
    crestDb: 10,
    bands: [0, 0, 0, 1, 0, 0],
    dominantBand: "mid",
    centroidHz: 1000,
    flatness: 0.1,
    onsetsPerSec: 1,
    tempoBpm: null,
    clippedFraction: 0,
    silent: false,
    durationSec: 6,
    volume: 1,
    pan: 0,
    tone: 1,
    lowCut: 20,
    space: 0,
    muted: false,
    ...over,
  };
}

describe("diagnose", () => {
  it("finds a vocal that is not above the track", () => {
    const s = analyzeSession([
      fakeAnalysis({ id: 1, name: "vox", part: "vocal", loudnessDb: -20 }),
      fakeAnalysis({ id: 2, name: "pad", part: "harmonic", loudnessDb: -16 }),
    ]);
    const issue = diagnose(s, "vocal-forward").find((i) => i.kind === "vocal-buried");
    expect(issue).toBeTruthy();
    expect(issue!.targetId).toBe(1);
    expect(issue!.otherId).toBe(2);
    expect(issue!.detail).toMatch(/-4 dB over pad/);
  });

  it("finds a vocal shouting over the track", () => {
    const s = analyzeSession([
      fakeAnalysis({ id: 1, name: "vox", part: "vocal", loudnessDb: -8 }),
      fakeAnalysis({ id: 2, name: "pad", part: "harmonic", loudnessDb: -30 }),
    ]);
    expect(diagnose(s).some((i) => i.kind === "vocal-too-loud")).toBe(true);
  });

  it("finds a stack parked in the centre and a stack with no room", () => {
    const stack = [1, 2, 3].map((id) =>
      fakeAnalysis({ id, name: `take ${id}`, part: "vocal", pan: 0, space: 0 })
    );
    const kinds = diagnose(analyzeSession(stack), "wide").map((i) => i.kind);
    expect(kinds).toContain("stack-collapsed");
    expect(kinds).toContain("stack-dry");
  });

  it("finds an empty arrangement with nothing underneath it", () => {
    const s = analyzeSession([fakeAnalysis({ id: 1, name: "vox", part: "vocal" })]);
    expect(diagnose(s).some((i) => i.kind === "no-foundation")).toBe(true);
  });

  it("finds clipping and ranks it first", () => {
    const s = analyzeSession([
      fakeAnalysis({ id: 1, name: "vox", part: "vocal", peakDb: 0.5, loudnessDb: -6 }),
      fakeAnalysis({ id: 2, name: "pad", loudnessDb: -30 }),
    ]);
    expect(diagnose(s, "radio-ready")[0].kind).toBe("clipping");
  });

  it("says nothing about a mix with nothing wrong", () => {
    const s = analyzeSession([
      fakeAnalysis({ id: 1, name: "vox", part: "vocal", loudnessDb: -14, space: 0.3 }),
      fakeAnalysis({ id: 2, name: "beat", part: "drums", loudnessDb: -18, bands: [0.3, 0.2, 0.1, 0.2, 0.1, 0.1], onsetsPerSec: 4 }),
      fakeAnalysis({ id: 3, name: "bass", part: "bass", loudnessDb: -18, bands: [0.5, 0.4, 0.1, 0, 0, 0] }),
    ]);
    expect(diagnose(s)).toHaveLength(0);
    expect(scoreMix(s)).toBe(0);
  });

  it("weights the same mix differently under different goals", () => {
    const stack = [1, 2, 3].map((id) =>
      fakeAnalysis({ id, name: `take ${id}`, part: "vocal", pan: 0, space: 0 })
    );
    const s = analyzeSession(stack);
    expect(diagnose(s, "wide")[0].kind).toBe("stack-collapsed");
    expect(diagnose(s, "glue")[0].kind).toBe("stack-dry");
  });

  it("ignores muted tracks entirely", () => {
    const s = analyzeSession([
      fakeAnalysis({ id: 1, name: "vox", part: "vocal", loudnessDb: -20 }),
      fakeAnalysis({ id: 2, name: "pad", loudnessDb: -6, muted: true }),
    ]);
    expect(s.counts.harmonic).toBe(0);
    expect(diagnose(s).some((i) => i.kind === "vocal-buried")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

function plannerInput(
  session: SessionAnalysis,
  goal: Goal = "radio-ready",
  withBacking = false,
  withEq = false
) {
  return {
    goal,
    goalText: "",
    session,
    issues: diagnose(session, goal),
    tools: toolSchemas({
      ...(withBacking ? { requestBacking: async () => {} } : {}),
      ...(withEq ? { setLowCut: () => {} } : {}),
    } as unknown as AgentMixerPort),
    history: [],
    blocked: [],
  };
}

describe("proposeFix", () => {
  it("tucks the competing part when the mix is already at the ceiling", () => {
    const s = analyzeSession([
      fakeAnalysis({ id: 1, name: "vox", part: "vocal", loudnessDb: -8, peakDb: -1 }),
      fakeAnalysis({ id: 2, name: "pad", part: "harmonic", loudnessDb: -6, peakDb: -1 }),
    ]);
    const call = proposeFix({
      ...plannerInput(s, "vocal-forward"),
      issues: diagnose(s, "vocal-forward").filter((i) => i.kind === "vocal-buried"),
    });
    expect(call?.tool).toBe("duck");
    expect(call?.args.track).toBe(2);
  });

  it("lifts the vocal instead when there is headroom and fader left", () => {
    const s = analyzeSession([
      fakeAnalysis({ id: 1, name: "vox", part: "vocal", loudnessDb: -30, peakDb: -22, volume: 0.5 }),
      fakeAnalysis({ id: 2, name: "pad", part: "harmonic", loudnessDb: -28, peakDb: -20 }),
    ]);
    const call = proposeFix({
      ...plannerInput(s, "vocal-forward"),
      issues: diagnose(s, "vocal-forward").filter((i) => i.kind === "vocal-buried"),
    });
    expect(call?.tool).toBe("set_level");
    expect(call?.args.track).toBe(1);
    expect(call?.args.delta_db as number).toBeGreaterThan(0);
  });

  it("tucks the track instead when the vocal fader is already at unity", () => {
    // The mixer's faders stop at unity, so there is no "up" left to give.
    const s = analyzeSession([
      fakeAnalysis({ id: 1, name: "vox", part: "vocal", loudnessDb: -30, peakDb: -22, volume: 1 }),
      fakeAnalysis({ id: 2, name: "pad", part: "harmonic", loudnessDb: -28, peakDb: -20 }),
    ]);
    const call = proposeFix({
      ...plannerInput(s, "vocal-forward"),
      issues: diagnose(s, "vocal-forward").filter((i) => i.kind === "vocal-buried"),
    });
    expect(call?.tool).toBe("duck");
    expect(call?.args.track).toBe(2);
  });

  it("leaves the bass and the voice alone when clearing the low end", () => {
    const s = analyzeSession([
      fakeAnalysis({ id: 1, name: "vox", part: "vocal", loudnessDb: -14 }),
      fakeAnalysis({ id: 2, name: "bass", part: "bass", loudnessDb: -16, bands: [0.5, 0.5, 0, 0, 0, 0] }),
      fakeAnalysis({ id: 3, name: "sub layer", part: "harmonic", loudnessDb: -16, bands: [0.5, 0.5, 0, 0, 0, 0] }),
    ]);
    const call = proposeFix({
      ...plannerInput(s, "clean-low-end"),
      issues: diagnose(s, "clean-low-end").filter((i) => i.kind === "low-end-crowding"),
    });
    expect(call?.tool).toBe("duck");
    // The bass keeps the bottom; the part doubling it is the one that moves.
    expect(call?.args.track).toBe(3);
  });

  it("reaches for the tone knob when parts collide above the low-mids", () => {
    const s = analyzeSession([
      fakeAnalysis({ id: 1, name: "vox", part: "vocal", loudnessDb: -18, bands: [0, 0, 0, 0.6, 0.4, 0] }),
      fakeAnalysis({ id: 2, name: "pad", part: "harmonic", loudnessDb: -14, bands: [0, 0, 0, 0.6, 0.4, 0] }),
    ]);
    const call = proposeFix({ ...plannerInput(s), issues: diagnose(s).filter((i) => i.kind === "masking") });
    expect(call?.tool).toBe("set_tone");
    expect(call?.args.track).toBe(2);
    expect(call?.args.tone as number).toBeLessThan(1);
  });

  it("high passes the masker when parts collide down low", () => {
    const s = analyzeSession([
      fakeAnalysis({ id: 1, name: "bass", part: "bass", loudnessDb: -18, bands: [0.5, 0.5, 0, 0, 0, 0] }),
      fakeAnalysis({ id: 2, name: "rumble", part: "harmonic", loudnessDb: -14, bands: [0.5, 0.5, 0, 0, 0, 0] }),
    ]);
    const call = proposeFix({
      ...plannerInput(s, "radio-ready", false, true),
      issues: diagnose(s).filter((i) => i.kind === "masking"),
    });
    // The channel EQ's high pass gets the masker out of the way while leaving
    // it at its own level. A lowpass could never do this.
    expect(call?.tool).toBe("set_low_cut");
    expect(call?.args.track).toBe(2);
    expect(call?.args.hz as number).toBeGreaterThan(20);
  });

  it("falls back to ducking when the mixer has no high pass", () => {
    const s = analyzeSession([
      fakeAnalysis({ id: 1, name: "bass", part: "bass", loudnessDb: -18, bands: [0.5, 0.5, 0, 0, 0, 0] }),
      fakeAnalysis({ id: 2, name: "rumble", part: "harmonic", loudnessDb: -14, bands: [0.5, 0.5, 0, 0, 0, 0] }),
    ]);
    const call = proposeFix({ ...plannerInput(s), issues: diagnose(s).filter((i) => i.kind === "masking") });
    expect(call?.tool).toBe("duck");
  });

  it("never high passes the bass out of its own bottom end", () => {
    const s = analyzeSession([
      fakeAnalysis({ id: 1, name: "vox", part: "vocal", loudnessDb: -18, bands: [0.4, 0.4, 0.2, 0, 0, 0] }),
      fakeAnalysis({ id: 2, name: "bass", part: "bass", loudnessDb: -14, bands: [0.5, 0.5, 0, 0, 0, 0] }),
    ]);
    const call = proposeFix({
      ...plannerInput(s, "radio-ready", false, true),
      issues: diagnose(s).filter((i) => i.kind === "masking"),
    });
    expect(call?.tool).not.toBe("set_low_cut");
  });

  it("never proposes a backing part when the engine is not there", () => {
    const s = analyzeSession([fakeAnalysis({ id: 1, name: "vox", part: "vocal" })]);
    const withoutEngine = proposeFix(plannerInput(s, "radio-ready", false));
    expect(withoutEngine?.tool).not.toBe("add_backing");
    const withEngine = proposeFix(plannerInput(s, "radio-ready", true));
    expect(withEngine?.tool).toBe("add_backing");
  });

  it("skips a problem kind that has already been tried and reverted", () => {
    const s = analyzeSession([
      fakeAnalysis({ id: 1, name: "vox", part: "vocal", loudnessDb: -20 }),
      fakeAnalysis({ id: 2, name: "pad", part: "harmonic", loudnessDb: -16 }),
    ]);
    const input = plannerInput(s, "vocal-forward");
    const first = proposeFix(input);
    const second = proposeFix({ ...input, blocked: ["vocal-buried", "masking"] });
    expect(first?.tool).toBeTruthy();
    expect(second?.tool).not.toBe(first?.tool);
  });
});

// ---------------------------------------------------------------------------

describe("runProducerAgent", () => {
  it("improves a mix where the voice is buried, and explains each move", async () => {
    const mixer = fakeMixer([
      { name: "Vocal take 1", role: "vocal", data: voxLike(0.12) },
      { name: "Pad", role: "pad", data: padLike(0.3) },
    ]);
    const events: AgentEvent[] = [];
    const before = scoreMix(sessionOf(mixer), "vocal-forward");

    const result = await runProducerAgent({
      port: mixer.port,
      getTracks: mixer.getTracks,
      readAudio: mixer.readAudio,
      goalText: "put the voice on top",
      onEvent: (e) => events.push(e),
      maxSteps: 6,
    });

    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.scoreEnd).toBeLessThan(before);
    // Every applied move carries a reason with a measurement in it.
    for (const call of result.applied) {
      expect(call.reason.length).toBeGreaterThan(10);
      expect(call.reason).toMatch(/\d/);
    }
    expect(events.some((e) => e.type === "hear")).toBe(true);
    expect(events[events.length - 1].type).toBe("done");
    expect(summarizeRun(result)).toMatch(/closer to the goal/);
  });

  it("puts every fader, pan and send back exactly where it was", async () => {
    const mixer = fakeMixer([
      { name: "Vocal take 1", role: "vocal", data: voxLike(0.12) },
      { name: "Vocal take 2", role: "vocal", data: voxLike(0.1) },
      { name: "Vocal take 3", role: "vocal", data: voxLike(0.11) },
      { name: "Pad", role: "pad", data: padLike(0.3) },
    ]);
    const before = JSON.stringify(mixer.snapshot());

    const result = await runProducerAgent({
      port: mixer.port,
      getTracks: mixer.getTracks,
      readAudio: mixer.readAudio,
      goalText: "make it radio ready",
      maxSteps: 8,
    });

    expect(result.applied.length).toBeGreaterThan(0);
    expect(JSON.stringify(mixer.snapshot())).not.toBe(before);
    result.undoAll();
    expect(JSON.stringify(mixer.snapshot())).toBe(before);
  });

  it("reverts a move that does not improve the mix", async () => {
    const mixer = fakeMixer([
      { name: "Vocal take 1", role: "vocal", data: voxLike(0.12) },
      { name: "Pad", role: "pad", data: padLike(0.3) },
    ]);
    // A planner with a bad idea: shove the vocal hard left, every time.
    const badPlanner: Planner = async () => ({
      tool: "set_pan",
      args: { track: 1, pan: -1 },
      reason: "a bad idea",
    });
    const events: AgentEvent[] = [];

    const result = await runProducerAgent({
      port: mixer.port,
      getTracks: mixer.getTracks,
      readAudio: mixer.readAudio,
      goalText: "put the voice on top",
      planner: badPlanner,
      onEvent: (e) => events.push(e),
      maxSteps: 4,
    });

    expect(events.some((e) => e.type === "revert")).toBe(true);
    expect(result.applied).toHaveLength(0);
    // And the bad move did not stick.
    expect(mixer.tracks[0].pan).toBe(0);
  });

  it("stops instead of looping when it cannot help", async () => {
    const mixer = fakeMixer([
      { name: "Vocal take 1", role: "vocal", data: voxLike(0.12) },
      { name: "Pad", role: "pad", data: padLike(0.3) },
    ]);
    const planner: Planner = async () => ({
      tool: "set_pan",
      args: { track: 1, pan: -1 },
      reason: "",
    });
    const result = await runProducerAgent({
      port: mixer.port,
      getTracks: mixer.getTracks,
      readAudio: mixer.readAudio,
      goalText: "balance the levels",
      planner,
      maxSteps: 50,
    });
    // The blocked-issue rule stops it well short of the budget.
    expect(result.steps).toBeLessThan(12);
  });

  it("asks the engine for a beat when there is no foundation", async () => {
    const mixer = fakeMixer([{ name: "Vocal take 1", role: "vocal", data: voxLike(0.2) }]);
    await runProducerAgent({
      port: mixer.withBacking(),
      getTracks: mixer.getTracks,
      readAudio: mixer.readAudio,
      goalText: "make it radio ready",
      maxSteps: 3,
    });
    expect(mixer.backing).toHaveBeenCalled();
    expect(mixer.tracks.some((t) => t.role === "beat")).toBe(true);
  });

  it("spreads a centred stack when asked to open it up", async () => {
    const mixer = fakeMixer([
      { name: "Vocal take 1", role: "vocal", data: voxLike(0.15) },
      { name: "Vocal take 2", role: "vocal", data: voxLike(0.14) },
      { name: "Vocal take 3", role: "vocal", data: voxLike(0.13) },
    ]);
    const result = await runProducerAgent({
      port: mixer.port,
      getTracks: mixer.getTracks,
      readAudio: mixer.readAudio,
      goalText: "open it up",
      maxSteps: 4,
    });
    expect(result.applied.some((c) => c.tool === "spread")).toBe(true);
    expect(mixer.tracks.some((t) => t.pan !== 0)).toBe(true);
  });

  it("gives a dry stack one shared room when asked to glue it", async () => {
    const mixer = fakeMixer([
      { name: "Vocal take 1", role: "vocal", data: voxLike(0.15) },
      { name: "Vocal take 2", role: "vocal", data: voxLike(0.14) },
    ]);
    const result = await runProducerAgent({
      port: mixer.port,
      getTracks: mixer.getTracks,
      readAudio: mixer.readAudio,
      goalText: "glue the stack together",
      maxSteps: 5,
    });
    expect(result.applied.some((c) => c.tool === "set_space")).toBe(true);
    expect(mixer.tracks.some((t) => t.space > 0)).toBe(true);
  });

  it("does nothing to an empty mixer", async () => {
    const mixer = fakeMixer([]);
    const result = await runProducerAgent({
      port: mixer.port,
      getTracks: mixer.getTracks,
      readAudio: mixer.readAudio,
      goalText: "make it radio ready",
    });
    expect(result.applied).toHaveLength(0);
    expect(summarizeRun(result)).toBe("nothing needed changing");
  });

  it("stops when the caller aborts", async () => {
    const mixer = fakeMixer([
      { name: "Vocal take 1", role: "vocal", data: voxLike(0.12) },
      { name: "Pad", role: "pad", data: padLike(0.3) },
    ]);
    const signal = { aborted: true };
    const result = await runProducerAgent({
      port: mixer.port,
      getTracks: mixer.getTracks,
      readAudio: mixer.readAudio,
      goalText: "make it radio ready",
      signal,
    });
    expect(result.steps).toBe(0);
    expect(result.applied).toHaveLength(0);
  });

  it("survives a planner that throws", async () => {
    const mixer = fakeMixer([
      { name: "Vocal take 1", role: "vocal", data: voxLike(0.12) },
      { name: "Pad", role: "pad", data: padLike(0.3) },
    ]);
    const events: AgentEvent[] = [];
    const result = await runProducerAgent({
      port: mixer.port,
      getTracks: mixer.getTracks,
      readAudio: mixer.readAudio,
      goalText: "make it radio ready",
      planner: async () => {
        throw new Error("planner exploded");
      },
      onEvent: (e) => events.push(e),
    });
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(result.applied).toHaveLength(0);
  });

  it("never tucks the lead vocal to clean up a crowded bottom", async () => {
    const mixer = fakeMixer([
      { name: "Vocal take 1", role: "vocal", data: voxLike(0.15) },
      { name: "Bass", role: "bass", data: bassLike(0.35) },
      { name: "Sub layer", role: "loop", data: bassLike(0.3) },
    ]);
    const result = await runProducerAgent({
      port: mixer.port,
      getTracks: mixer.getTracks,
      readAudio: mixer.readAudio,
      goalText: "clean up the low end",
      maxSteps: 6,
    });
    const ducked = result.applied.filter((c) => c.tool === "duck").map((c) => c.args.track);
    expect(ducked).not.toContain(1);
    // The bass here is 6 dB over the voice, so tucking it is the right call and
    // the agent is allowed to make it. What it must not do is tuck the voice.
    expect(mixer.tracks[0].volume).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------

describe("describeSession", () => {
  it("gives a model the ids, levels and problems in one block", () => {
    const s = analyzeSession([
      fakeAnalysis({ id: 1, name: "vox", part: "vocal", loudnessDb: -20 }),
      fakeAnalysis({ id: 2, name: "pad", part: "harmonic", loudnessDb: -16 }),
    ]);
    const text = describeSession(s, diagnose(s));
    expect(text).toMatch(/\[1\] vox \(vocal\)/);
    expect(text).toMatch(/\[2\] pad \(harmonic\)/);
    expect(text).toMatch(/problems, worst first/);
    expect(text).toMatch(/vocal-buried/);
  });

  it("says so plainly when there is nothing wrong", () => {
    expect(describeSession(analyzeSession([]), [])).toMatch(/problems: none measured/);
  });
});

describe("remotePlanner", () => {
  it("sends the goal, the session and the tool schemas, and reads back one move", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tool: "set_level", args: { track: 2, delta_db: -3 }, reason: "because" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const s = analyzeSession([fakeAnalysis({ id: 1, name: "vox", part: "vocal" })]);
    const call = await remotePlanner("/agent")(plannerInput(s));
    expect(call).toMatchObject({ tool: "set_level", reason: "because" });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.session).toMatch(/\[1\] vox/);
    expect(body.tools.map((t: { name: string }) => t.name)).toContain("set_level");
    vi.unstubAllGlobals();
  });

  it("treats a response with no tool as nothing left to do", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ done: true }) })
    );
    const s = analyzeSession([fakeAnalysis({ id: 1 })]);
    expect(await remotePlanner("/agent")(plannerInput(s))).toBeNull();
    vi.unstubAllGlobals();
  });

  it("raises on an endpoint error rather than silently doing nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const s = analyzeSession([fakeAnalysis({ id: 1 })]);
    await expect(remotePlanner("/agent")(plannerInput(s))).rejects.toThrow(/503/);
    vi.unstubAllGlobals();
  });
});

describe("offlinePlanner", () => {
  it("is the same decision proposeFix makes", async () => {
    const s = analyzeSession([
      fakeAnalysis({ id: 1, name: "vox", part: "vocal", loudnessDb: -20 }),
      fakeAnalysis({ id: 2, name: "pad", part: "harmonic", loudnessDb: -16 }),
    ]);
    const input = plannerInput(s, "vocal-forward");
    expect(await offlinePlanner(input)).toEqual(proposeFix(input));
  });
});
