// producerTools.ts - what the dice producer agent can actually do.
//
// The action half of the agent. Every move it can make is one entry in this
// registry: a name, a description, typed parameters, and an `apply` that
// performs the move against the mixer and returns the closure that undoes it.
//
// Two properties matter and are deliberate:
//
//  1. Every tool is invertible. The agent applies a move, re-scores the mix, and
//     reverts if the score did not improve. Without an undo per move a failed
//     idea would be permanent.
//  2. The registry is the single source of truth for both planners. The offline
//     planner picks tools from it directly; the model-backed planner is handed
//     `toolSchemas()`, generated from the same entries. The two planners can
//     never drift apart in what they are allowed to do.

import { BAND_NAMES, type BandName } from "./ears";

/**
 * The slice of the mixer the agent is allowed to touch.
 *
 * Narrow on purpose. The agent gets levels, panning, tone, the ambience send,
 * mute, and optionally the backing generator. It cannot delete a track, clear
 * the project, or overwrite a recording, so the worst outcome of a bad plan is
 * a mix the user undoes.
 */
export interface AgentMixerPort {
  setVolume(id: number, volume: number): void;
  /** Channel EQ low cut, in Hz. 20 is off. */
  setLowCut?(id: number, hz: number): void;
  setPan(id: number, pan: number): void;
  setTone(id: number, tone: number): void;
  setSpace(id: number, space: number): void;
  setMute(id: number, muted: boolean): void;
  /**
   * Ask the engine for a backing part. Optional: when the deejai engine is not
   * reachable the tool is simply not offered to the planner.
   */
  requestBacking?(kind: BackingKind, style?: string): Promise<void>;
}

export type BackingKind = "beat" | "bass" | "pad";

/** A single move: the tool to run and the arguments to run it with. */
export interface ToolCall {
  tool: string;
  args: Record<string, number | string | boolean>;
  /** Why the agent chose this, in the producer's own words. */
  reason: string;
}

/** Undo closure returned by every applied tool. */
export type Undo = () => void;

export interface ParamSpec {
  name: string;
  type: "number" | "string" | "boolean";
  description: string;
  min?: number;
  max?: number;
  enum?: readonly string[];
}

export interface ToolSpec {
  name: string;
  /** One line, written for a model to read. */
  description: string;
  params: ParamSpec[];
  /** Async tools (the ones that call the engine) resolve when the move lands. */
  async?: boolean;
  apply(
    port: AgentMixerPort,
    args: Record<string, number | string | boolean>,
    ctx: ToolContext
  ): Undo | Promise<Undo>;
}

/** Current mixer state the tools need to compute relative moves and undo. */
export interface ToolContext {
  /** Present state of every track, keyed by id. */
  state: Map<
    number,
    {
      volume: number;
      pan: number;
      tone: number;
      lowCut: number;
      space: number;
      muted: boolean;
    }
  >;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clampPan = (v: number) => Math.max(-1, Math.min(1, v));

function num(args: Record<string, unknown>, key: string, fallback = 0): number {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function trackState(ctx: ToolContext, id: number) {
  const s = ctx.state.get(id);
  if (!s) throw new Error(`unknown track ${id}`);
  return s;
}

/** Convert a gain change in dB into a linear multiplier. */
export function dbToRatio(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * Geometric centre frequency of each analysis band, used by the tone model.
 * The lowest band is open at the bottom, so it gets a fixed 40 Hz centre.
 */
export const BAND_CENTER_HZ: Record<BandName, number> = {
  sub: 40,
  low: Math.sqrt(60 * 250),
  "low-mid": Math.sqrt(250 * 500),
  mid: Math.sqrt(500 * 2000),
  "high-mid": Math.sqrt(2000 * 6000),
  air: Math.sqrt(6000 * 20000),
};

/**
 * How the one-knob tone control reshapes a track's band energies.
 *
 * The mixer's tone knob is a single lowpass whose cutoff sweeps 500 Hz to
 * 20 kHz. This models its effect analytically (second-order magnitude response,
 * Q = 1) rather than re-rendering the track, so the agent can score a candidate
 * tone move without an offline bounce per step. It is an approximation and the
 * agent treats it as one: the score it produces decides between moves, and the
 * user hears the real filter.
 *
 * Note the asymmetry this creates. A lowpass can only take the top off, so the
 * agent can un-mask a vocal from a bright part but cannot high-pass a boomy
 * part out of the way. Low-frequency crowding is handled with level moves
 * instead, which is why `duck` exists alongside `set_tone`.
 *
 * The filter is Butterworth, so at tone 1 it really is transparent; there is no
 * resonant bump at the corner to model.
 */
/**
 * Magnitude of the tone filter at a frequency ratio.
 *
 * Q is Butterworth (0.707), matching the mixer live and in the bounce. It used
 * to be the browser default of 1, which resonates about a decibel at the corner
 * and made this model carry a caveat about the air band reading hot. Flat now.
 */
const TONE_Q = 0.707;

function toneMagnitude(r: number): number {
  return 1 / Math.sqrt((1 - r * r) ** 2 + (r / TONE_Q) ** 2);
}

export function toneShapedBands(bands: number[], tone: number): number[] {
  const fc = 500 * Math.pow(40, clamp01(tone));
  const out = bands.map((share, i) => {
    const f = BAND_CENTER_HZ[BAND_NAMES[i]];
    const r = f / fc;
    const mag = toneMagnitude(r);
    return share * mag * mag; // power
  });
  const total = out.reduce((a, b) => a + b, 0);
  return total > 0 ? out.map((v) => v / total) : bands.slice();
}

/**
 * Broadband level lost to the tone control, in dB. Darkening a track makes it
 * quieter as well as duller, and the agent's level bookkeeping has to know.
 */
export function toneLevelDeltaDb(bands: number[], from: number, to: number): number {
  const gain = (tone: number) => {
    const fc = 500 * Math.pow(40, clamp01(tone));
    let sum = 0;
    for (let i = 0; i < bands.length; i += 1) {
      const f = BAND_CENTER_HZ[BAND_NAMES[i]];
      const r = f / fc;
      sum += bands[i] * toneMagnitude(r) ** 2;
    }
    return sum;
  };
  const a = gain(from);
  const b = gain(to);
  if (!(a > 0) || !(b > 0)) return 0;
  return 10 * Math.log10(b / a);
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const TOOLS: ToolSpec[] = [
  {
    name: "set_level",
    description:
      "Change one track's fader by a number of decibels. Negative values tuck a part under the others, positive values bring it forward.",
    params: [
      { name: "track", type: "number", description: "Track id." },
      {
        name: "delta_db",
        type: "number",
        description: "Fader change in dB, typically between -9 and +6.",
        min: -24,
        max: 12,
      },
    ],
    apply(port, args, ctx) {
      const id = num(args, "track");
      const s = trackState(ctx, id);
      const before = s.volume;
      const next = clamp01(before * dbToRatio(num(args, "delta_db")));
      port.setVolume(id, next);
      s.volume = next;
      return () => {
        port.setVolume(id, before);
        s.volume = before;
      };
    },
  },
  {
    name: "set_pan",
    description:
      "Place one track in the stereo field. -1 is hard left, 0 is centre, 1 is hard right.",
    params: [
      { name: "track", type: "number", description: "Track id." },
      { name: "pan", type: "number", description: "-1 to 1.", min: -1, max: 1 },
    ],
    apply(port, args, ctx) {
      const id = num(args, "track");
      const s = trackState(ctx, id);
      const before = s.pan;
      const next = clampPan(num(args, "pan"));
      port.setPan(id, next);
      s.pan = next;
      return () => {
        port.setPan(id, before);
        s.pan = before;
      };
    },
  },
  {
    name: "set_tone",
    description:
      "Set one track's tone, 0 dark to 1 fully open. Lowering it takes the top off a part so it stops covering something else. It cannot remove low end.",
    params: [
      { name: "track", type: "number", description: "Track id." },
      { name: "tone", type: "number", description: "0 to 1.", min: 0, max: 1 },
    ],
    apply(port, args, ctx) {
      const id = num(args, "track");
      const s = trackState(ctx, id);
      const before = s.tone;
      const next = clamp01(num(args, "tone", before));
      port.setTone(id, next);
      s.tone = next;
      return () => {
        port.setTone(id, before);
        s.tone = before;
      };
    },
  },
  {
    name: "set_space",
    description:
      "Set how much of one track is sent to the shared room, 0 dry to 1 washed. Sending a whole vocal stack to one room is what makes it read as a single voice.",
    params: [
      { name: "track", type: "number", description: "Track id." },
      { name: "space", type: "number", description: "0 to 1.", min: 0, max: 1 },
    ],
    apply(port, args, ctx) {
      const id = num(args, "track");
      const s = trackState(ctx, id);
      const before = s.space;
      const next = clamp01(num(args, "space", before));
      port.setSpace(id, next);
      s.space = next;
      return () => {
        port.setSpace(id, before);
        s.space = before;
      };
    },
  },
  {
    name: "set_low_cut",
    description:
      "Set a track's channel EQ low cut in Hz, 20 to 400. Use it to get a boomy part out from under something without turning the whole part down. 20 leaves it open.",
    params: [
      { name: "track", type: "number", description: "Track id." },
      { name: "hz", type: "number", description: "20 to 400.", min: 20, max: 400 },
    ],
    apply(port, args, ctx) {
      if (!port.setLowCut) throw new Error("this mixer has no low cut");
      const id = num(args, "track");
      const s = trackState(ctx, id);
      const before = s.lowCut;
      const next = Math.max(20, Math.min(400, num(args, "hz", before)));
      port.setLowCut(id, next);
      s.lowCut = next;
      return () => {
        port.setLowCut!(id, before);
        s.lowCut = before;
      };
    },
  },
  {
    name: "duck",
    description:
      "Tuck one track a set number of decibels under another. Use when two parts share low frequencies, where tone cannot separate them.",
    params: [
      { name: "track", type: "number", description: "Track id to tuck." },
      {
        name: "amount_db",
        type: "number",
        description: "How far to tuck it, as a positive number of dB.",
        min: 0,
        max: 18,
      },
    ],
    apply(port, args, ctx) {
      const id = num(args, "track");
      const s = trackState(ctx, id);
      const before = s.volume;
      const next = clamp01(before * dbToRatio(-Math.abs(num(args, "amount_db", 3))));
      port.setVolume(id, next);
      s.volume = next;
      return () => {
        port.setVolume(id, before);
        s.volume = before;
      };
    },
  },
  {
    name: "spread",
    description:
      "Fan a group of tracks evenly across the stereo field, keeping the first one centred. Used to open up a vocal stack or a set of doubles.",
    params: [
      {
        name: "tracks",
        type: "string",
        description: "Comma-separated track ids, in the order they should sit.",
      },
      { name: "width", type: "number", description: "0 to 1.", min: 0, max: 1 },
    ],
    apply(port, args, ctx) {
      const ids = String(args.tracks ?? "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
      const width = clamp01(num(args, "width", 0.6));
      const before = ids.map((id) => ({ id, pan: trackState(ctx, id).pan }));

      // The first track holds the centre; the rest alternate outwards so the
      // field stays balanced however many tracks there are.
      ids.forEach((id, i) => {
        let pan = 0;
        if (i > 0) {
          const step = Math.ceil(i / 2);
          const steps = Math.ceil((ids.length - 1) / 2);
          const mag = steps > 0 ? (step / steps) * width : 0;
          pan = i % 2 === 1 ? -mag : mag;
        }
        const p = clampPan(pan);
        port.setPan(id, p);
        trackState(ctx, id).pan = p;
      });

      return () => {
        for (const b of before) {
          port.setPan(b.id, b.pan);
          trackState(ctx, b.id).pan = b.pan;
        }
      };
    },
  },
  {
    name: "set_mute",
    description: "Mute or unmute a track.",
    params: [
      { name: "track", type: "number", description: "Track id." },
      { name: "muted", type: "boolean", description: "true to mute." },
    ],
    apply(port, args, ctx) {
      const id = num(args, "track");
      const s = trackState(ctx, id);
      const before = s.muted;
      const next = args.muted === true || args.muted === "true";
      port.setMute(id, next);
      s.muted = next;
      return () => {
        port.setMute(id, before);
        s.muted = before;
      };
    },
  },
  {
    name: "add_backing",
    description:
      "Ask the engine for a backing part when the arrangement is missing a foundation: a beat, a bassline, or a pad. Only available when the engine is reachable.",
    params: [
      {
        name: "kind",
        type: "string",
        description: "Which part to add.",
        enum: ["beat", "bass", "pad"] as const,
      },
      {
        name: "style",
        type: "string",
        description: "Optional style hint, for example lofi, trap, or ballad.",
      },
    ],
    async: true,
    async apply(port, args) {
      if (!port.requestBacking) throw new Error("engine not available");
      const kind = String(args.kind ?? "beat") as BackingKind;
      const style = typeof args.style === "string" ? args.style : undefined;
      await port.requestBacking(kind, style);
      // Generated parts are not removed on revert: pulling a rendered stem back
      // out is the user's call, not a silent rollback, and the mixer's own undo
      // already covers it.
      return () => {};
    },
  },
];

/** Look up a tool by name. */
export function findTool(name: string): ToolSpec | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** The tools available given what the port actually supports. */
export function availableTools(port: AgentMixerPort): ToolSpec[] {
  return TOOLS.filter((t) => {
    if (t.name === "add_backing") return typeof port.requestBacking === "function";
    if (t.name === "set_low_cut") return typeof port.setLowCut === "function";
    return true;
  });
}

/**
 * The registry rendered as tool-use schemas, for a model-backed planner. The
 * shape is the standard `{name, description, input_schema}` triple, so it drops
 * straight into a tool-use request without translation.
 */
export function toolSchemas(port?: AgentMixerPort): Array<{
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}> {
  const list = port ? availableTools(port) : TOOLS;
  return list.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: "object" as const,
      properties: Object.fromEntries(
        t.params.map((p) => [
          p.name,
          {
            type: p.type,
            description: p.description,
            ...(p.min != null ? { minimum: p.min } : {}),
            ...(p.max != null ? { maximum: p.max } : {}),
            ...(p.enum ? { enum: [...p.enum] } : {}),
          },
        ])
      ),
      // Every parameter except an optional style hint is required.
      required: t.params.filter((p) => p.name !== "style").map((p) => p.name),
    },
  }));
}

/** Apply one call, returning its undo. Throws on an unknown tool. */
export async function applyToolCall(
  port: AgentMixerPort,
  ctx: ToolContext,
  call: ToolCall
): Promise<Undo> {
  const spec = findTool(call.tool);
  if (!spec) throw new Error(`unknown tool: ${call.tool}`);
  return await spec.apply(port, call.args, ctx);
}
