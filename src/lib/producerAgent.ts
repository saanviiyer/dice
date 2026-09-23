// producerAgent.ts - the dice producer agent.
//
// A closed perception/action loop, not a command parser. Each step it:
//
//   hears   - measures every track and rolls it up into a picture of the mix
//   judges  - turns that picture into a list of concrete, numbered problems
//   scores  - collapses the problems into one number under the current goal
//   acts    - makes exactly one move from the tool registry
//   checks  - re-scores, and reverts the move if the mix did not get better
//
// The check is the part that makes it an agent rather than a macro. A move that
// does not improve the score is undone and its problem is set aside, so a bad
// idea costs one step instead of ruining the mix. The user hears only moves
// that measurably helped, and the transcript says by how much.
//
// Two planners share one tool registry (see producerTools.ts). The offline
// planner runs with no key and no network and is what ships by default. The
// remote planner hands the same tool schemas and the same session description
// to a model endpoint. Swapping planners changes how moves are chosen, never
// what moves are possible.

import {
  analyzeSession,
  analyzeTrack,
  dbfs,
  effectiveLoudnessDb,
  type BandName,
  type PartKind,
  type SessionAnalysis,
  type TrackAnalysis,
  type TrackMeta,
} from "./ears";
import {
  applyToolCall,
  availableTools,
  toneLevelDeltaDb,
  toneShapedBands,
  toolSchemas,
  BAND_CENTER_HZ,
  type AgentMixerPort,
  type ToolCall,
  type ToolContext,
  type Undo,
} from "./producerTools";

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export type Goal =
  | "balance"
  | "vocal-forward"
  | "glue"
  | "wide"
  | "clean-low-end"
  | "radio-ready";

export interface GoalSpec {
  id: Goal;
  label: string;
  /** Shown under the chip, and sent to a model planner as the objective. */
  brief: string;
}

export const GOALS: GoalSpec[] = [
  {
    id: "radio-ready",
    label: "make it radio ready",
    brief:
      "Fix whatever is most wrong, in order: clipping first, then levels, then masking, then the stereo picture.",
  },
  {
    id: "vocal-forward",
    label: "put the voice on top",
    brief:
      "The lead vocal should sit clearly above everything else without being shouted.",
  },
  {
    id: "balance",
    label: "balance the levels",
    brief: "No part should be much louder or much quieter than the rest.",
  },
  {
    id: "glue",
    label: "glue the stack",
    brief:
      "Make the vocal takes read as one voice: one shared room, even levels, no part sticking out.",
  },
  {
    id: "wide",
    label: "open it up",
    brief: "Use the stereo field. Spread the stack, centre the foundation.",
  },
  {
    id: "clean-low-end",
    label: "clean the low end",
    brief: "Only one part should own the bottom. Clear out everything else down there.",
  },
];

const GOAL_WORDS: Array<[Goal, RegExp]> = [
  ["vocal-forward", /(vocal|voice|vox|lead|sing).*(top|front|forward|clear|up|louder|above)|bur(y|ied)|can'?t hear (my|the) (voice|vocal)/i],
  ["clean-low-end", /(low end|bottom|bass|muddy|mud|boom|rumble|sub)/i],
  ["wide", /(wide|width|stereo|spread|open (it )?up|narrow)/i],
  ["glue", /(glue|gel|blend|stack|together|one voice|cohesive)/i],
  ["balance", /(balance|level|even|too loud|too quiet)/i],
  ["radio-ready", /(radio|master|finish|polish|release|ready|mix it|produce)/i],
];

/**
 * Map a typed sentence onto a goal. Deliberately keyword-based: this is the
 * offline path, it runs with no key, and a wrong guess here only picks which
 * problems get weighted highest, not what the agent is allowed to do.
 */
export function interpretGoal(text: string): Goal {
  for (const [goal, re] of GOAL_WORDS) if (re.test(text)) return goal;
  return "radio-ready";
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

export type IssueKind =
  | "clipping"
  | "no-foundation"
  | "vocal-buried"
  | "vocal-too-loud"
  | "masking"
  | "low-end-crowding"
  | "stack-collapsed"
  | "stack-dry"
  | "off-centre"
  | "level-spread"
  | "dull-vocal";

export interface Issue {
  kind: IssueKind;
  /** 0 (trivial) .. 1 (as bad as this problem gets). */
  severity: number;
  targetId?: number;
  otherId?: number;
  band?: BandName;
  /** The problem in a producer's words, with the measurement in it. */
  detail: string;
}

type Weights = Partial<Record<IssueKind, number>>;

/**
 * How much each problem counts under each goal. A weight of 0 does not hide a
 * problem, it just stops the agent spending a step on it while chasing
 * something else.
 */
const GOAL_WEIGHTS: Record<Goal, Weights> = {
  "radio-ready": {
    clipping: 2.5,
    "no-foundation": 1.2,
    "vocal-buried": 1.3,
    "vocal-too-loud": 0.9,
    masking: 1.1,
    "low-end-crowding": 1,
    "stack-collapsed": 0.8,
    "stack-dry": 0.7,
    "off-centre": 0.8,
    "level-spread": 1,
    "dull-vocal": 0.6,
  },
  "vocal-forward": {
    clipping: 2,
    "vocal-buried": 2.4,
    masking: 1.8,
    "vocal-too-loud": 0.7,
    "dull-vocal": 1.1,
    "level-spread": 0.5,
    "low-end-crowding": 0.4,
    "off-centre": 0.3,
    "stack-collapsed": 0.3,
    "stack-dry": 0.3,
    "no-foundation": 0.2,
  },
  balance: {
    clipping: 2,
    "level-spread": 1.8,
    "vocal-buried": 1.2,
    "vocal-too-loud": 1.2,
    masking: 0.7,
    "off-centre": 0.8,
    "low-end-crowding": 0.6,
    "stack-collapsed": 0.3,
    "stack-dry": 0.3,
    "dull-vocal": 0.3,
    "no-foundation": 0.2,
  },
  glue: {
    "stack-dry": 2,
    "stack-collapsed": 1.3,
    "level-spread": 1.3,
    masking: 0.9,
    clipping: 1.6,
    "vocal-buried": 0.8,
    "vocal-too-loud": 0.6,
    "off-centre": 0.5,
    "low-end-crowding": 0.4,
    "dull-vocal": 0.4,
    "no-foundation": 0.2,
  },
  wide: {
    "stack-collapsed": 2.2,
    "off-centre": 1.5,
    "stack-dry": 0.8,
    clipping: 1.6,
    "level-spread": 0.6,
    masking: 0.5,
    "vocal-buried": 0.6,
    "vocal-too-loud": 0.4,
    "low-end-crowding": 0.4,
    "dull-vocal": 0.3,
    "no-foundation": 0.2,
  },
  "clean-low-end": {
    "low-end-crowding": 2.4,
    masking: 1.4,
    clipping: 1.8,
    "level-spread": 0.7,
    "vocal-buried": 0.7,
    "vocal-too-loud": 0.4,
    "off-centre": 0.4,
    "stack-collapsed": 0.3,
    "stack-dry": 0.3,
    "dull-vocal": 0.3,
    "no-foundation": 0.2,
  },
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Audible: not muted, not silent, fader open. */
function live(t: TrackAnalysis): boolean {
  return !t.muted && !t.silent && t.volume > 0.001;
}

/**
 * Everything wrong with the mix right now, worst first under `goal`.
 *
 * Every problem carries the measurement that produced it, because the agent's
 * transcript quotes these strings and a claim with no number behind it is not
 * worth showing the user.
 */
export function diagnose(session: SessionAnalysis, goal: Goal = "radio-ready"): Issue[] {
  const issues: Issue[] = [];
  const tracks = session.tracks.filter(live);
  if (tracks.length === 0) return issues;

  const byId = new Map(tracks.map((t) => [t.id, t]));
  const vocals = tracks.filter((t) => t.part === "vocal");
  const others = tracks.filter((t) => t.part !== "vocal");

  // Clipping. Checked first and weighted hardest everywhere: nothing else about
  // a mix matters if it is distorting.
  if (session.mixPeakDb > -0.3) {
    // Floored well above zero on purpose. Distortion is a defect, not a matter
    // of degree, and this floor is what keeps it ranked above every advisory
    // problem no matter how mild the overshoot.
    issues.push({
      kind: "clipping",
      severity: 0.4 + clamp01((session.mixPeakDb + 0.3) / 3) * 0.6,
      detail: `the mix peaks at ${round1(session.mixPeakDb)} dBFS, over the ceiling`,
    });
  }
  for (const t of tracks) {
    if (t.clippedFraction > 0.002) {
      issues.push({
        kind: "clipping",
        severity: clamp01(t.clippedFraction * 60),
        targetId: t.id,
        detail: `${t.name} is clipped on ${(t.clippedFraction * 100).toFixed(1)}% of its samples`,
      });
    }
  }

  // Nothing holding the track up.
  if (session.counts.drums === 0 && session.counts.bass === 0 && tracks.length > 0) {
    issues.push({
      // Advisory rather than a fault: plenty of finished records are a voice
      // and one instrument. Kept below the severity of anything actually
      // broken, so the agent never reaches for a beat before fixing the mix.
      kind: "no-foundation",
      severity: 0.5,
      detail: "there is no beat and no bass under the arrangement",
    });
  }

  // Where the lead vocal sits relative to the loudest thing under it.
  if (vocals.length > 0 && others.length > 0) {
    const lead = vocals.reduce((a, b) =>
      effectiveLoudnessDb(b) > effectiveLoudnessDb(a) ? b : a
    );
    const rival = others.reduce((a, b) =>
      effectiveLoudnessDb(b) > effectiveLoudnessDb(a) ? b : a
    );
    const headroom = effectiveLoudnessDb(lead) - effectiveLoudnessDb(rival);
    if (headroom < 1.5) {
      issues.push({
        kind: "vocal-buried",
        severity: clamp01((1.5 - headroom) / 8),
        targetId: lead.id,
        otherId: rival.id,
        detail: `${lead.name} is only ${round1(headroom)} dB over ${rival.name}`,
      });
    } else if (headroom > 8) {
      issues.push({
        kind: "vocal-too-loud",
        severity: clamp01((headroom - 8) / 8),
        targetId: lead.id,
        otherId: rival.id,
        detail: `${lead.name} is ${round1(headroom)} dB over ${rival.name}, shouting over the track`,
      });
    }
  }

  // Two parts fighting for the same band.
  for (const m of session.masking.slice(0, 4)) {
    const masked = byId.get(m.maskedId);
    const masker = byId.get(m.maskerId);
    if (!masked || !masker) continue;
    issues.push({
      kind: "masking",
      severity: clamp01(m.severity / 0.45),
      targetId: masker.id,
      otherId: masked.id,
      band: m.band,
      detail: `${masker.name} is covering ${masked.name} in the ${m.band}`,
    });
  }

  // Too many parts sharing the bottom.
  if (session.lowEndCrowding >= 1) {
    const names = session.lowEndExtras
      .map((id) => byId.get(id)?.name)
      .filter((n): n is string => !!n);
    issues.push({
      kind: "low-end-crowding",
      severity: clamp01(session.lowEndCrowding / 3),
      targetId: session.lowEndExtras[0],
      detail: `${names.join(" and ")} ${
        names.length === 1 ? "is" : "are"
      } sitting on the bottom alongside the bass`,
    });
  }

  // A stack that never left the centre.
  if (vocals.length >= 3 && vocals.every((t) => Math.abs(t.pan) < 0.08)) {
    issues.push({
      kind: "stack-collapsed",
      severity: clamp01(vocals.length / 5),
      detail: `all ${vocals.length} vocal takes are stacked dead centre`,
    });
  }

  // A stack with no shared room does not read as one voice.
  if (vocals.length >= 2) {
    const meanSpace = vocals.reduce((a, t) => a + t.space, 0) / vocals.length;
    if (meanSpace < 0.05) {
      issues.push({
        kind: "stack-dry",
        severity: 0.6,
        detail: `${vocals.length} vocal takes with no shared room, so they sit apart instead of blending`,
      });
    }
  }

  // A lopsided stereo picture.
  if (Math.abs(session.stereoBalance) > 0.18) {
    issues.push({
      kind: "off-centre",
      severity: clamp01((Math.abs(session.stereoBalance) - 0.18) / 0.5),
      detail: `the mix leans ${session.stereoBalance > 0 ? "right" : "left"} by ${Math.round(
        Math.abs(session.stereoBalance) * 100
      )}%`,
    });
  }

  // One part far off everyone else's level.
  if (tracks.length >= 3 && session.loudnessSpreadDb > 7) {
    issues.push({
      kind: "level-spread",
      severity: clamp01((session.loudnessSpreadDb - 7) / 10),
      detail: `track levels are spread over ${round1(session.loudnessSpreadDb)} dB`,
    });
  }

  // A vocal that has been darkened past the point of intelligibility.
  for (const v of vocals) {
    if (v.tone < 0.98 && v.centroidHz < 900) {
      issues.push({
        kind: "dull-vocal",
        severity: clamp01((900 - v.centroidHz) / 600) * 0.7,
        targetId: v.id,
        detail: `${v.name} is dark, centred at ${Math.round(v.centroidHz)} Hz with the tone at ${v.tone.toFixed(2)}`,
      });
    }
  }

  const w = GOAL_WEIGHTS[goal];
  return issues
    .map((i) => ({ i, score: i.severity * (w[i.kind] ?? 1) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.i);
}

/**
 * One number for how far the mix is from the goal. Lower is better; 0 means no
 * problem worth a step. This is the objective the loop optimises and the value
 * the revert check compares.
 */
export function scoreMix(session: SessionAnalysis, goal: Goal = "radio-ready"): number {
  const w = GOAL_WEIGHTS[goal];
  const issues = diagnose(session, goal);
  let total = 0;
  for (const i of issues) total += i.severity * (w[i.kind] ?? 1);
  return Math.round(total * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Re-hearing without re-rendering
// ---------------------------------------------------------------------------

/**
 * Combine a track's raw audio measurement with its current mixer state.
 *
 * The buffer the mixer hands over is pre-fader and pre-filter, so the raw
 * measurement never changes while the agent works. Level, pan and send are then
 * exact, and the tone knob's effect on the spectrum is modelled (see
 * `toneShapedBands`) rather than re-rendered. That is what lets the loop
 * evaluate a candidate move in microseconds instead of bouncing the mix once
 * per step; the trade is that the spectral half of the score is a good model of
 * the filter, not a measurement of it.
 */
export function projectTrack(raw: TrackAnalysis, meta: TrackMeta): TrackAnalysis {
  const bands = toneShapedBands(raw.bands, meta.tone);
  const levelDelta = toneLevelDeltaDb(raw.bands, 1, meta.tone);
  // Recompute the centroid from the shaped bands, so a darkened part reads as
  // darker to the diagnostics that care.
  let num = 0;
  let den = 0;
  const centers = Object.values(BAND_CENTER_HZ);
  for (let i = 0; i < bands.length; i += 1) {
    num += centers[i] * bands[i];
    den += bands[i];
  }
  return {
    ...raw,
    bands,
    centroidHz: den > 0 ? num / den : raw.centroidHz,
    loudnessDb: raw.loudnessDb + levelDelta,
    peakDb: raw.peakDb + levelDelta,
    volume: meta.volume,
    pan: meta.pan,
    tone: meta.tone,
    lowCut: meta.lowCut,
    space: meta.space,
    muted: meta.muted,
  };
}

// ---------------------------------------------------------------------------
// The offline planner
// ---------------------------------------------------------------------------

export interface PlannerInput {
  goal: Goal;
  goalText: string;
  session: SessionAnalysis;
  issues: Issue[];
  /** Tool-use schemas for the moves currently available. */
  tools: ReturnType<typeof toolSchemas>;
  /** Moves already made this run, oldest first. */
  history: ToolCall[];
  /** Problem kinds already tried and reverted; do not propose them again. */
  blocked: IssueKind[];
}

export type Planner = (input: PlannerInput) => Promise<ToolCall | null>;

const BRIGHT_BANDS: BandName[] = ["mid", "high-mid", "air"];

/**
 * Turn the worst outstanding problem into one move.
 *
 * The choices here are the opinionated part of the agent, and each one is a
 * normal engineering decision rather than a preference:
 *
 *  - A buried vocal is fixed by pulling the competing part down when the mix is
 *    already near the ceiling, and by pushing the vocal up when there is room.
 *    Reaching for the vocal fader first is how mixes end up clipped.
 *  - Masking above the low-mids is fixed with the tone knob on the part doing
 *    the covering. Below it, tone cannot help (the knob is a lowpass), so the
 *    part gets tucked instead.
 *  - Low-end crowding never touches the bass or the vocal; it tucks whichever
 *    other part is sitting on the bottom.
 */
export function proposeFix(input: PlannerInput): ToolCall | null {
  const { session, issues, blocked } = input;
  const byId = new Map(session.tracks.map((t) => [t.id, t]));
  const canBack = input.tools.some((t) => t.name === "add_backing");
  const canHighPass = input.tools.some((t) => t.name === "set_low_cut");

  for (const issue of issues) {
    if (blocked.includes(issue.kind)) continue;
    switch (issue.kind) {
      case "clipping": {
        const target =
          (issue.targetId != null && byId.get(issue.targetId)) ||
          session.tracks
            .filter(live)
            .reduce<TrackAnalysis | null>(
              (a, b) => (a && effectiveLoudnessDb(a) > effectiveLoudnessDb(b) ? a : b),
              null
            );
        if (!target) break;
        const over = Math.max(1, session.mixPeakDb + 1);
        return {
          tool: "set_level",
          args: { track: target.id, delta_db: -Math.min(6, over) },
          reason: `${issue.detail}, so ${target.name} comes down ${round1(Math.min(6, over))} dB`,
        };
      }

      case "no-foundation": {
        if (!canBack) break;
        return {
          tool: "add_backing",
          args: { kind: "beat" },
          reason: `${issue.detail}, so the engine renders a beat that fits the take`,
        };
      }

      case "vocal-buried": {
        const vocal = issue.targetId != null ? byId.get(issue.targetId) : null;
        const rival = issue.otherId != null ? byId.get(issue.otherId) : null;
        if (!vocal || !rival) break;
        const need = Math.min(5, 2.5 + issue.severity * 4);
        // Room at the top? Lift the vocal. Otherwise tuck what is covering it.
        //
        // The fader check is not belt-and-braces: the mixer's faders top out at
        // unity, so a vocal already at 1.0 cannot be raised at all and the only
        // way to give it room is to bring the track down around it.
        if (session.mixPeakDb < -4 && vocal.volume < 0.95) {
          return {
            tool: "set_level",
            args: { track: vocal.id, delta_db: round1(need) },
            reason: `${issue.detail}, and there is ${round1(-session.mixPeakDb)} dB of headroom, so the vocal comes up`,
          };
        }
        return {
          tool: "duck",
          args: { track: rival.id, amount_db: round1(need) },
          reason: `${issue.detail}, and the mix is near the ceiling, so ${rival.name} gets tucked instead`,
        };
      }

      case "vocal-too-loud": {
        const vocal = issue.targetId != null ? byId.get(issue.targetId) : null;
        if (!vocal) break;
        return {
          tool: "set_level",
          args: { track: vocal.id, delta_db: -round1(2 + issue.severity * 4) },
          reason: `${issue.detail}, so it comes back into the track`,
        };
      }

      case "masking": {
        const masker = issue.targetId != null ? byId.get(issue.targetId) : null;
        const masked = issue.otherId != null ? byId.get(issue.otherId) : null;
        if (!masker || !masked) break;
        if (issue.band && BRIGHT_BANDS.includes(issue.band) && masker.tone > 0.25) {
          const next = Math.max(0.2, masker.tone - 0.12 - issue.severity * 0.1);
          return {
            tool: "set_tone",
            args: { track: masker.id, tone: Math.round(next * 100) / 100 },
            reason: `${issue.detail}, so the top comes off ${masker.name} instead of turning it down`,
          };
        }
        // Down low the channel EQ's high pass is the right tool: it gets the
        // masker out of the way while leaving the part itself at its level.
        // The bass keeps its bottom, so it is only ever ducked.
        if (canHighPass && masker.part !== "bass" && masker.lowCut < 200) {
          const next = Math.min(200, Math.max(60, masker.lowCut + 60 + issue.severity * 60));
          return {
            tool: "set_low_cut",
            args: { track: masker.id, hz: Math.round(next) },
            reason: `${issue.detail} down low, so ${masker.name} gets a high pass at ${Math.round(next)} Hz instead of coming down`,
          };
        }
        return {
          tool: "duck",
          args: { track: masker.id, amount_db: round1(1.5 + issue.severity * 2.5) },
          reason: `${issue.detail} down low, so it gets tucked`,
        };
      }

      case "low-end-crowding": {
        // The session has already worked out who is allowed down there; this
        // clears the first part that is not.
        const victim = session.lowEndExtras
          .map((id) => byId.get(id))
          .find((t): t is TrackAnalysis => !!t);
        if (!victim) break;
        if (canHighPass && victim.lowCut < 160) {
          const next = Math.min(200, Math.max(80, victim.lowCut + 80));
          return {
            tool: "set_low_cut",
            args: { track: victim.id, hz: Math.round(next) },
            reason: `${issue.detail}, so ${victim.name} gets a high pass at ${Math.round(next)} Hz and gives the bottom back to the bass`,
          };
        }
        return {
          tool: "duck",
          args: { track: victim.id, amount_db: 2.5 },
          reason: `${issue.detail}, so ${victim.name} gives the bottom back to the bass`,
        };
      }

      case "stack-collapsed": {
        const vocals = session.tracks.filter((t) => live(t) && t.part === "vocal");
        if (vocals.length < 2) break;
        // Loudest take holds the centre; the rest fan out around it.
        const ordered = [...vocals].sort(
          (a, b) => effectiveLoudnessDb(b) - effectiveLoudnessDb(a)
        );
        return {
          tool: "spread",
          args: { tracks: ordered.map((t) => t.id).join(","), width: 0.62 },
          reason: `${issue.detail}, so the lead stays centred and the rest fan out around it`,
        };
      }

      case "stack-dry": {
        const vocals = session.tracks.filter((t) => live(t) && t.part === "vocal");
        const target = vocals.find((t) => t.space < 0.05);
        if (!target) break;
        return {
          tool: "set_space",
          args: { track: target.id, space: 0.3 },
          reason: `${issue.detail}, so ${target.name} joins the shared room the others sit in`,
        };
      }

      case "off-centre": {
        const worst = session.tracks
          .filter(live)
          .filter((t) => Math.sign(t.pan) === Math.sign(session.stereoBalance))
          .sort((a, b) => Math.abs(b.pan) - Math.abs(a.pan))[0];
        if (!worst) break;
        return {
          tool: "set_pan",
          args: { track: worst.id, pan: Math.round(worst.pan * 0.5 * 100) / 100 },
          reason: `${issue.detail}, so ${worst.name} moves back toward the middle`,
        };
      }

      case "level-spread": {
        const lives = session.tracks.filter(live);
        if (lives.length < 3) break;
        const louds = lives.map(effectiveLoudnessDb);
        const mean = louds.reduce((a, b) => a + b, 0) / louds.length;
        let worst = lives[0];
        let worstDelta = 0;
        lives.forEach((t, i) => {
          const d = louds[i] - mean;
          if (Math.abs(d) > Math.abs(worstDelta)) {
            worst = t;
            worstDelta = d;
          }
        });
        if (Math.abs(worstDelta) < 2) break;
        return {
          tool: "set_level",
          args: { track: worst.id, delta_db: round1(-worstDelta * 0.5) },
          reason: `${issue.detail}, and ${worst.name} is the outlier at ${round1(worstDelta)} dB off the average`,
        };
      }

      case "dull-vocal": {
        const v = issue.targetId != null ? byId.get(issue.targetId) : null;
        if (!v) break;
        return {
          tool: "set_tone",
          args: { track: v.id, tone: Math.min(1, Math.round((v.tone + 0.18) * 100) / 100) },
          reason: `${issue.detail}, so the tone opens back up`,
        };
      }
    }
  }
  return null;
}

/** The planner that ships: no key, no network, fully deterministic. */
export const offlinePlanner: Planner = async (input) => proposeFix(input);

// ---------------------------------------------------------------------------
// Describing the mix to a model
// ---------------------------------------------------------------------------

/** The session as compact text, for a model-backed planner's prompt. */
export function describeSession(session: SessionAnalysis, issues: Issue[]): string {
  const lines: string[] = [];
  lines.push(
    `mix: ${round1(session.mixLoudnessDb)} dB loudness, peak ${round1(session.mixPeakDb)} dB, ` +
      `balance ${session.stereoBalance > 0 ? "R" : "L"}${Math.abs(
        Math.round(session.stereoBalance * 100)
      )}%, level spread ${round1(session.loudnessSpreadDb)} dB` +
      (session.tempoBpm ? `, about ${session.tempoBpm} BPM` : "")
  );
  lines.push("tracks:");
  for (const t of session.tracks) {
    lines.push(
      `  [${t.id}] ${t.name} (${t.part})` +
        ` level ${round1(effectiveLoudnessDb(t))} dB` +
        ` pan ${t.pan.toFixed(2)} tone ${t.tone.toFixed(2)} space ${t.space.toFixed(2)}` +
        ` dominant ${t.dominantBand}, centroid ${Math.round(t.centroidHz)} Hz,` +
        ` ${t.onsetsPerSec.toFixed(1)} onsets/s` +
        (t.muted ? " [muted]" : "")
    );
  }
  if (issues.length > 0) {
    lines.push("problems, worst first:");
    for (const i of issues.slice(0, 8)) {
      lines.push(`  ${i.kind} (${i.severity.toFixed(2)}): ${i.detail}`);
    }
  } else {
    lines.push("problems: none measured");
  }
  return lines.join("\n");
}

/**
 * A planner backed by a model endpoint.
 *
 * The endpoint receives the goal, the session description and the same tool
 * schemas the offline planner works from, and returns one tool call. Keeping
 * the contract this narrow means a model can only ever choose among moves the
 * agent already knows how to undo and verify, so a bad suggestion is reverted
 * by the same check that catches a bad offline suggestion.
 */
export function remotePlanner(endpoint: string): Planner {
  return async (input) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: input.goal,
        objective: input.goalText,
        session: describeSession(input.session, input.issues),
        tools: input.tools,
        history: input.history,
      }),
    });
    if (!res.ok) throw new Error(`planner endpoint returned ${res.status}`);
    const body = (await res.json()) as { tool?: string; args?: Record<string, never>; reason?: string };
    if (!body || typeof body.tool !== "string") return null;
    return {
      tool: body.tool,
      args: body.args ?? {},
      reason: typeof body.reason === "string" ? body.reason : "suggested by the model planner",
    };
  };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * Raw measurements, cached by track id and buffer length. A track only needs
 * re-measuring when its audio actually changes, so a whole agent run measures
 * each part once no matter how many moves it evaluates.
 */
export type MeasureCache = Map<number, { key: string; raw: TrackAnalysis }>;

/** Audio for one track, pre-fader and pre-filter. */
export interface TrackAudio {
  data: Float32Array;
  sampleRate: number;
}

/**
 * Listen to the whole mixer: measure every track that has audio, apply its
 * current fader, pan, tone and send, and roll the result up into one picture.
 * Shared by the agent loop and by the panel's read-out, so what the user is
 * shown is exactly what the agent is reasoning about.
 */
export function hearMixer(
  getTracks: () => TrackMeta[],
  readAudio: (id: number) => TrackAudio | null,
  cache: MeasureCache
): SessionAnalysis {
  const analyses: TrackAnalysis[] = [];
  for (const meta of getTracks()) {
    const audio = readAudio(meta.id);
    if (!audio) continue;
    const key = `${audio.data.length}:${audio.sampleRate}`;
    const hit = cache.get(meta.id);
    if (hit && hit.key === key) {
      analyses.push(projectTrack(hit.raw, meta));
      continue;
    }
    const raw = analyzeTrack({ ...meta, tone: 1 }, audio.data, audio.sampleRate);
    cache.set(meta.id, { key, raw });
    analyses.push(projectTrack(raw, meta));
  }
  return analyzeSession(analyses);
}

export type AgentEvent =
  | { type: "hear"; step: number; score: number; issues: Issue[]; session: SessionAnalysis }
  | { type: "act"; step: number; call: ToolCall; scoreBefore: number; scoreAfter: number }
  | { type: "revert"; step: number; call: ToolCall; scoreBefore: number; scoreAfter: number }
  | { type: "note"; message: string }
  | {
      type: "done";
      steps: number;
      scoreStart: number;
      scoreEnd: number;
      applied: ToolCall[];
      session: SessionAnalysis;
    }
  | { type: "error"; message: string };

export interface RunOptions {
  port: AgentMixerPort;
  /** Current mixer tracks. Re-read each step, so new stems are picked up. */
  getTracks(): TrackMeta[];
  /** Raw audio for a track, or null if it has none yet. */
  readAudio(id: number): TrackAudio | null;
  goalText: string;
  goal?: Goal;
  maxSteps?: number;
  planner?: Planner;
  onEvent?(event: AgentEvent): void;
  /** Set to abort between steps. */
  signal?: { aborted: boolean };
}

export interface RunResult {
  applied: ToolCall[];
  scoreStart: number;
  scoreEnd: number;
  steps: number;
  /** Undo every move the run made, newest first. */
  undoAll(): void;
}

/**
 * Run the agent to a stopping point.
 *
 * It stops when there is nothing left worth fixing, when every remaining
 * problem has been tried and reverted, or when the step budget runs out,
 * whichever comes first. It always returns an `undoAll`, so a whole run is one
 * decision for the user rather than a dozen.
 */
export async function runProducerAgent(opts: RunOptions): Promise<RunResult> {
  const {
    port,
    getTracks,
    readAudio,
    goalText,
    maxSteps = 8,
    planner = offlinePlanner,
    onEvent,
    signal,
  } = opts;
  const goal = opts.goal ?? interpretGoal(goalText);
  const emit = (e: AgentEvent) => onEvent?.(e);

  const cache: MeasureCache = new Map();
  const hear = (): SessionAnalysis => hearMixer(getTracks, readAudio, cache);

  const context = (): ToolContext => ({
    state: new Map(
      getTracks().map((t) => [
        t.id,
        {
          volume: t.volume,
          pan: t.pan,
          tone: t.tone,
          lowCut: t.lowCut,
          space: t.space,
          muted: t.muted,
        },
      ])
    ),
  });

  const undos: Undo[] = [];
  const applied: ToolCall[] = [];
  const blocked: IssueKind[] = [];
  const tools = toolSchemas(port);
  void availableTools; // registry filtering happens inside toolSchemas

  let session = hear();
  const scoreStart = scoreMix(session, goal);
  let score = scoreStart;
  let step = 0;

  emit({ type: "hear", step, score, issues: diagnose(session, goal), session });

  while (step < maxSteps) {
    if (signal?.aborted) {
      emit({ type: "note", message: "stopped" });
      break;
    }
    const issues = diagnose(session, goal);
    const actionable = issues.filter((i) => !blocked.includes(i.kind));
    if (actionable.length === 0 || score <= 0.05) break;

    let call: ToolCall | null = null;
    try {
      call = await planner({
        goal,
        goalText,
        session,
        issues: actionable,
        tools,
        history: applied,
        blocked,
      });
    } catch (err) {
      emit({
        type: "error",
        message: err instanceof Error ? err.message : "the planner failed",
      });
      break;
    }
    if (!call) break;

    step += 1;
    let undo: Undo;
    try {
      undo = await applyToolCall(port, context(), call);
    } catch (err) {
      emit({
        type: "error",
        message: `${call.tool} failed: ${err instanceof Error ? err.message : "unknown error"}`,
      });
      blocked.push(actionable[0].kind);
      continue;
    }

    session = hear();
    const after = scoreMix(session, goal);

    // The check. A move has to earn its place.
    if (after >= score - 1e-3) {
      undo();
      session = hear();
      emit({ type: "revert", step, call, scoreBefore: score, scoreAfter: after });
      blocked.push(actionable[0].kind);
      continue;
    }

    undos.push(undo);
    applied.push(call);
    emit({ type: "act", step, call, scoreBefore: score, scoreAfter: after });
    score = after;
    emit({ type: "hear", step, score, issues: diagnose(session, goal), session });
  }

  emit({
    type: "done",
    steps: step,
    scoreStart,
    scoreEnd: score,
    applied,
    session,
  });

  return {
    applied,
    scoreStart,
    scoreEnd: score,
    steps: step,
    undoAll() {
      for (let i = undos.length - 1; i >= 0; i -= 1) undos[i]();
      undos.length = 0;
    },
  };
}

/** A one-line summary of a finished run, for the transcript header. */
export function summarizeRun(result: RunResult): string {
  if (result.applied.length === 0) return "nothing needed changing";
  const improvement = result.scoreStart - result.scoreEnd;
  const pct = result.scoreStart > 0 ? Math.round((improvement / result.scoreStart) * 100) : 0;
  return `${result.applied.length} move${result.applied.length === 1 ? "" : "s"}, ${pct}% closer to the goal`;
}

/** Re-exported so panels can render band names without importing ears. */
export type { BandName, PartKind, SessionAnalysis, TrackAnalysis, TrackMeta };
export { dbfs };
