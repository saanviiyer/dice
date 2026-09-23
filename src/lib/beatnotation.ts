// beatnotation.ts - typing a beat out instead of clicking it in.
//
// A drum pattern as text, one lane per line:
//
//     kick  x...x...x...x...
//     snare ....x.......x...
//     hat   x.x.x.x.x.x.x.x.
//
// The format is deliberately forgiving, because the whole point is that it is
// faster to type than to click. Lane names take their common abbreviations, any
// of `.`, `-`, `_` and space count as a rest, bar lines are decoration, and a
// lane shorter than the pattern repeats to fill it, so `hat x.` means what you
// would expect rather than one hat and then silence.

import {
  ACCENT,
  DRUM_LANES,
  GHOST,
  MAX_PATTERN_BARS,
  NORMAL,
  STEPS_PER_BAR,
  emptyPattern,
  nearestVelocity,
  type DrumInstrument,
  type DrumPattern,
} from "./drums";

/** Every spelling of a lane name that resolves. */
const ALIASES: Record<string, DrumInstrument> = {
  k: "kick",
  kick: "kick",
  bd: "kick",
  s: "snare",
  sn: "snare",
  snare: "snare",
  sd: "snare",
  c: "clap",
  cp: "clap",
  clap: "clap",
  h: "hat",
  hh: "hat",
  hat: "hat",
  hats: "hat",
  t: "tom",
  tom: "tom",
  toms: "tom",
  sh: "shaker",
  shk: "shaker",
  shaker: "shaker",
};

/**
 * How loud each glyph is.
 *
 * Capital X and # are the accent, lowercase x and friends the normal hit, and o
 * the ghost note. This is the convention drum tabs already use, so a pattern
 * copied out of one reads correctly without translation, and it means the
 * notation can express everything the pads can play.
 */
const GLYPH_VELOCITY: Record<string, number> = {
  X: ACCENT,
  "#": ACCENT,
  x: NORMAL,
  "*": NORMAL,
  "1": NORMAL,
  o: GHOST,
  O: GHOST,
};

/** The glyph to write a velocity back out as. */
const VELOCITY_GLYPH: Array<[number, string]> = [
  [ACCENT, "X"],
  [NORMAL, "x"],
  [GHOST, "o"],
];

const HIT = /[xX*#oO1]/;
const REST = /[.\-_ 0]/;

export interface ParseIssue {
  line: number;
  message: string;
}

export interface ParseResult {
  pattern: DrumPattern | null;
  bars: number;
  issues: ParseIssue[];
}

/** The lane names the parser accepts, for showing in help text. */
export function laneAliases(voice: DrumInstrument): string[] {
  return Object.entries(ALIASES)
    .filter(([, v]) => v === voice)
    .map(([k]) => k)
    .sort((a, b) => a.length - b.length);
}

/**
 * Parse typed notation into a pattern.
 *
 * Returns whatever it could understand along with everything it could not, so
 * the editor can show a half-finished pattern while you are still typing rather
 * than blanking out on the first mistake.
 */
export function parseBeat(text: string): ParseResult {
  const issues: ParseIssue[] = [];
  const lanes = new Map<DrumInstrument, string>();

  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("//") || line.startsWith("#")) return;

    const match = line.match(/^([A-Za-z]+)\s*[:|]?\s*(.*)$/);
    if (!match) {
      issues.push({ line: i + 1, message: `I could not read "${line}".` });
      return;
    }
    const [, name, rest] = match;
    const voice = ALIASES[name.toLowerCase()];
    if (!voice) {
      issues.push({
        line: i + 1,
        message: `"${name}" is not a lane. Try ${DRUM_LANES.join(", ")}.`,
      });
      return;
    }

    // Bar lines are decoration; strip them before reading the steps.
    const steps = rest.replace(/\|/g, "");
    const bad = Array.from(steps).find((ch) => !HIT.test(ch) && !REST.test(ch));
    if (bad !== undefined) {
      issues.push({
        line: i + 1,
        message: `"${bad}" is not a step. Use x for a hit and . for a rest.`,
      });
      return;
    }
    const cleaned = Array.from(steps).filter((ch) => ch !== " ").join("");
    if (cleaned.length === 0) {
      issues.push({ line: i + 1, message: `${voice} has no steps on it.` });
      return;
    }
    // A lane written twice *continues*, it does not overlay. That is what makes
    // a long pattern typable: write one bar per line and they join up, instead
    // of having to keep a 64-character string straight on one line.
    lanes.set(voice, (lanes.get(voice) ?? "") + cleaned);
  });

  if (lanes.size === 0) return { pattern: null, bars: 0, issues };

  const longest = Math.max(...[...lanes.values()].map((v) => v.length));
  const bars = Math.min(MAX_PATTERN_BARS, Math.max(1, Math.ceil(longest / STEPS_PER_BAR)));
  const total = bars * STEPS_PER_BAR;
  if (longest > total) {
    issues.push({
      line: 0,
      message: `That is longer than ${MAX_PATTERN_BARS} bars, so the end was cut off.`,
    });
  }

  const pattern = emptyPattern(bars);
  for (const [voice, steps] of lanes) {
    for (let i = 0; i < total; i += 1) {
      // Short lanes repeat, so "hat x." fills the bar.
      const ch = steps[i % steps.length];
      pattern[voice][i] = GLYPH_VELOCITY[ch] ?? 0;
    }
  }

  return { pattern, bars, issues };
}

/**
 * Render a pattern back out as notation, so the text box round-trips with
 * whatever is in the sequencer, however it got there.
 */
export function formatBeat(pattern: DrumPattern, barLines = true): string {
  const width = Math.max(...DRUM_LANES.map((l) => l.length));
  const lines: string[] = [];
  for (const voice of DRUM_LANES) {
    const lane = pattern[voice];
    if (!lane || lane.every((v) => !v)) continue;
    let steps = "";
    for (let i = 0; i < lane.length; i += 1) {
      if (barLines && i > 0 && i % STEPS_PER_BAR === 0) steps += "|";
      const v = lane[i];
      if (!v) {
        steps += ".";
        continue;
      }
      // A measured velocity from a beatboxed take is continuous; writing it out
      // snaps to the nearest glyph, which is the one lossy step in the
      // round-trip and is why `formatBeat` is documented as a rendering.
      const snapped = nearestVelocity(v);
      steps += VELOCITY_GLYPH.find(([level]) => level === snapped)?.[1] ?? "x";
    }
    lines.push(`${voice.padEnd(width)} ${steps}`);
  }
  return lines.join("\n");
}

/** A worked example, used as the editor's placeholder and its reset. */
export const EXAMPLE_BEAT = [
  "kick  x...x...x...x...",
  "snare ....x.......x...",
  "hat   ..x...x...x...x.",
].join("\n");
