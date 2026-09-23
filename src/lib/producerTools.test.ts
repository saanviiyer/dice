import { describe, expect, it, vi } from "vitest";
import {
  applyToolCall,
  availableTools,
  dbToRatio,
  findTool,
  toneLevelDeltaDb,
  toneShapedBands,
  toolSchemas,
  type AgentMixerPort,
  type ToolContext,
} from "./producerTools";

/** A mixer stand-in that records every call, so tools can be tested offline. */
function fakePort(over: Partial<AgentMixerPort> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const port: AgentMixerPort = {
    setVolume: (id, v) => calls.push(["setVolume", id, v]),
    setPan: (id, v) => calls.push(["setPan", id, v]),
    setTone: (id, v) => calls.push(["setTone", id, v]),
    setSpace: (id, v) => calls.push(["setSpace", id, v]),
    setMute: (id, v) => calls.push(["setMute", id, v]),
    ...over,
  };
  return { port, calls };
}

function ctx(ids = [1, 2, 3]): ToolContext {
  return {
    state: new Map(
      ids.map((id) => [id, { volume: 1, pan: 0, tone: 1, lowCut: 20, space: 0, muted: false }])
    ),
  };
}

describe("tone model", () => {
  it("is transparent when the tone is fully open", () => {
    // The mixer's filter is Butterworth (Q 0.707), so there is no resonant bump
    // at the corner to model. It used to be the browser default of 1, which
    // pushed the air band about a decibel hot and forced a caveat here.
    const bands = [0.1, 0.2, 0.2, 0.2, 0.2, 0.1];
    const open = toneShapedBands(bands, 1);
    // These are normalised shares, so a slight rolloff at the very top scales
    // the rest up to compensate. Nothing moves by as much as half a decibel,
    // and the air band is the only one that gives any ground.
    open.forEach((v, i) => {
      expect(Math.abs(10 * Math.log10(v / bands[i]))).toBeLessThan(0.5);
    });
    expect(open[5]).toBeLessThan(bands[5]);
    expect(open.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    // The broadband level, which is what the agent's bookkeeping uses, is exact.
    expect(toneLevelDeltaDb(bands, 1, 1)).toBe(0);
  });

  it("moves energy toward the bottom as the tone closes", () => {
    const bands = [0.1, 0.2, 0.2, 0.2, 0.2, 0.1];
    const dark = toneShapedBands(bands, 0.1);
    expect(dark[0] + dark[1]).toBeGreaterThan(bands[0] + bands[1]);
    expect(dark[5]).toBeLessThan(bands[5]);
    expect(dark.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it("reports the level lost to darkening a bright part", () => {
    const bright = [0, 0, 0, 0.2, 0.4, 0.4];
    expect(toneLevelDeltaDb(bright, 1, 0.2)).toBeLessThan(-3);
    expect(toneLevelDeltaDb(bright, 1, 1)).toBeCloseTo(0, 5);
  });

  it("barely touches a part that lives below the cutoff", () => {
    const low = [0.5, 0.5, 0, 0, 0, 0];
    expect(Math.abs(toneLevelDeltaDb(low, 1, 0.5))).toBeLessThan(1);
  });
});

describe("dbToRatio", () => {
  it("converts the usual anchors", () => {
    expect(dbToRatio(0)).toBeCloseTo(1, 6);
    expect(dbToRatio(-6)).toBeCloseTo(0.501, 2);
    expect(dbToRatio(6)).toBeCloseTo(1.995, 2);
  });
});

describe("tools", () => {
  it("set_level moves the fader by the requested dB and undoes exactly", async () => {
    const { port, calls } = fakePort();
    const c = ctx();
    const undo = await applyToolCall(port, c, {
      tool: "set_level",
      args: { track: 1, delta_db: -6 },
      reason: "test",
    });
    expect(calls[0][2]).toBeCloseTo(0.501, 2);
    expect(c.state.get(1)?.volume).toBeCloseTo(0.501, 2);
    undo();
    expect(calls[1][2]).toBe(1);
    expect(c.state.get(1)?.volume).toBe(1);
  });

  it("duck always tucks, whatever the sign of the argument", async () => {
    const { port } = fakePort();
    const c = ctx();
    await applyToolCall(port, c, {
      tool: "duck",
      args: { track: 2, amount_db: 3 },
      reason: "",
    });
    expect(c.state.get(2)!.volume).toBeLessThan(1);
    const after = c.state.get(2)!.volume;
    const c2 = ctx();
    await applyToolCall(port, c2, {
      tool: "duck",
      args: { track: 2, amount_db: -3 },
      reason: "",
    });
    expect(c2.state.get(2)!.volume).toBeCloseTo(after, 6);
  });

  it("clamps pan, tone and space to their legal ranges", async () => {
    const { port } = fakePort();
    const c = ctx();
    await applyToolCall(port, c, { tool: "set_pan", args: { track: 1, pan: 5 }, reason: "" });
    expect(c.state.get(1)!.pan).toBe(1);
    await applyToolCall(port, c, { tool: "set_tone", args: { track: 1, tone: -2 }, reason: "" });
    expect(c.state.get(1)!.tone).toBe(0);
    await applyToolCall(port, c, { tool: "set_space", args: { track: 1, space: 9 }, reason: "" });
    expect(c.state.get(1)!.space).toBe(1);
  });

  it("spread centres the first track and fans the rest symmetrically", async () => {
    const { port } = fakePort();
    const c = ctx([1, 2, 3, 4, 5]);
    const undo = await applyToolCall(port, c, {
      tool: "spread",
      args: { tracks: "1,2,3,4,5", width: 0.6 },
      reason: "",
    });
    const pans = [1, 2, 3, 4, 5].map((id) => c.state.get(id)!.pan);
    expect(pans[0]).toBe(0);
    // Opposite sides, matched magnitudes.
    expect(pans[1]).toBeCloseTo(-pans[2], 6);
    expect(pans[3]).toBeCloseTo(-pans[4], 6);
    expect(Math.max(...pans.map(Math.abs))).toBeCloseTo(0.6, 6);
    // And the whole field is balanced.
    expect(pans.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 6);
    undo();
    expect([1, 2, 3, 4, 5].map((id) => c.state.get(id)!.pan)).toEqual([0, 0, 0, 0, 0]);
  });

  it("spread handles a two-track stack", async () => {
    const { port } = fakePort();
    const c = ctx([1, 2]);
    await applyToolCall(port, c, {
      tool: "spread",
      args: { tracks: "1,2", width: 0.5 },
      reason: "",
    });
    expect(c.state.get(1)!.pan).toBe(0);
    expect(c.state.get(2)!.pan).toBeCloseTo(-0.5, 6);
  });

  it("rejects an unknown tool instead of silently doing nothing", async () => {
    const { port } = fakePort();
    await expect(
      applyToolCall(port, ctx(), { tool: "make_it_hot", args: {}, reason: "" })
    ).rejects.toThrow(/unknown tool/);
  });

  it("rejects a call against a track that is not in the mixer", async () => {
    const { port } = fakePort();
    await expect(
      applyToolCall(port, ctx([1]), { tool: "set_pan", args: { track: 99, pan: 0.5 }, reason: "" })
    ).rejects.toThrow(/unknown track/);
  });

  it("add_backing calls the engine and is available only when there is one", async () => {
    const requestBacking = vi.fn().mockResolvedValue(undefined);
    const { port } = fakePort({ requestBacking });
    await applyToolCall(port, ctx(), {
      tool: "add_backing",
      args: { kind: "beat", style: "lofi" },
      reason: "",
    });
    expect(requestBacking).toHaveBeenCalledWith("beat", "lofi");

    const offline = fakePort().port;
    expect(availableTools(offline).map((t) => t.name)).not.toContain("add_backing");
    expect(availableTools(port).map((t) => t.name)).toContain("add_backing");
  });
});

describe("toolSchemas", () => {
  it("describes every available tool in tool-use shape", () => {
    const { port } = fakePort();
    const schemas = toolSchemas(port);
    expect(schemas.length).toBe(availableTools(port).length);
    for (const s of schemas) {
      expect(findTool(s.name)).toBeTruthy();
      expect(s.description.length).toBeGreaterThan(10);
      expect(s.input_schema.type).toBe("object");
      expect(Object.keys(s.input_schema.properties).length).toBeGreaterThan(0);
    }
  });

  it("marks the style hint optional and everything else required", () => {
    const backing = toolSchemas().find((s) => s.name === "add_backing");
    expect(backing?.input_schema.required).toEqual(["kind"]);
    expect(backing?.input_schema.properties).toHaveProperty("style");
  });

  it("carries the numeric bounds a planner needs", () => {
    const pan = toolSchemas().find((s) => s.name === "set_pan");
    expect(pan?.input_schema.properties.pan).toMatchObject({ minimum: -1, maximum: 1 });
  });
});
