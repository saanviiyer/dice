import { MAX_PATTERN_BARS, STEPS_PER_BAR } from "./drums";

/**
 * A bassline, one stack of MIDI notes per 16th.
 *
 * Stacks rather than single notes, because the useful things to write under a
 * track are octaves, fifths and the odd triad, and a strictly monophonic lane
 * cannot express any of them. An empty array is a rest.
 */
export interface BassPattern {
  notes: number[][];
}

/** How many notes one step may hold. */
export const MAX_BASS_LAYERS = 4;

export const BASS_MIN_MIDI = 24;
export const BASS_MAX_MIDI = 72;

const clampMidi = (midi: number) =>
  Math.max(BASS_MIN_MIDI, Math.min(BASS_MAX_MIDI, Math.round(midi)));

/** Tidy one step: in range, no duplicates, ascending, and within the limit. */
function normalizeStack(stack: readonly number[]): number[] {
  const seen = new Set<number>();
  for (const n of stack) {
    if (typeof n !== "number" || !Number.isFinite(n)) continue;
    seen.add(clampMidi(n));
  }
  return [...seen].sort((a, b) => a - b).slice(0, MAX_BASS_LAYERS);
}

export type BassPresetName =
  | "Empty"
  | "Root pulse"
  | "Offbeat"
  | "Octave bounce"
  | "Walking"
  | "808 syncopation";

export const BASS_PRESET_NAMES: BassPresetName[] = [
  "Empty",
  "Root pulse",
  "Offbeat",
  "Octave bounce",
  "Walking",
  "808 syncopation",
];

const clampBars = (bars: number) =>
  Math.max(1, Math.min(MAX_PATTERN_BARS, Math.round(bars) || 1));

export function emptyBassPattern(bars = 1): BassPattern {
  return {
    notes: Array.from({ length: clampBars(bars) * STEPS_PER_BAR }, () => []),
  };
}

export function bassPatternBars(pattern: BassPattern): number {
  return Math.max(1, Math.round(pattern.notes.length / STEPS_PER_BAR));
}

export function setBassPatternBars(pattern: BassPattern, bars: number): BassPattern {
  const target = clampBars(bars) * STEPS_PER_BAR;
  const source = pattern.notes.length ? pattern.notes : emptyBassPattern().notes;
  return {
    notes: Array.from({ length: target }, (_, i) => [...(source[i % source.length] ?? [])]),
  };
}

/** Replace a step's whole stack. `null` or an empty array clears it. */
export function setBassNote(
  pattern: BassPattern,
  step: number,
  midi: number | null | readonly number[]
): BassPattern {
  const notes = pattern.notes.map((stack) => [...stack]);
  if (step < 0 || step >= notes.length) return { notes };
  if (midi === null) notes[step] = [];
  else if (typeof midi === "number") notes[step] = [clampMidi(midi)];
  else notes[step] = normalizeStack(midi);
  return { notes };
}

/**
 * Add a note to a step without disturbing what is already there, so a fifth or
 * an octave can be layered onto a root that is already written.
 */
export function addBassNote(pattern: BassPattern, step: number, midi: number): BassPattern {
  const notes = pattern.notes.map((stack) => [...stack]);
  if (step < 0 || step >= notes.length) return { notes };
  notes[step] = normalizeStack([...notes[step], midi]);
  return { notes };
}

/** Remove one note from a step, leaving any others in place. */
export function removeBassNote(pattern: BassPattern, step: number, midi: number): BassPattern {
  const notes = pattern.notes.map((stack) => [...stack]);
  if (step < 0 || step >= notes.length) return { notes };
  notes[step] = notes[step].filter((n) => n !== clampMidi(midi));
  return { notes };
}

/**
 * Toggle one note in a step's stack. This is what a click on the grid does:
 * clicking an empty cell layers a note in, clicking a lit one takes it out.
 */
export function toggleBassNote(pattern: BassPattern, step: number, midi: number): BassPattern {
  const has = bassNotesAt(pattern, step).includes(clampMidi(midi));
  return has ? removeBassNote(pattern, step, midi) : addBassNote(pattern, step, midi);
}

/** How many notes a step already holds. */
export function bassLayerCount(pattern: BassPattern, step: number): number {
  return bassNotesAt(pattern, step).length;
}

export function clearBassPattern(pattern: BassPattern): BassPattern {
  return { notes: pattern.notes.map(() => []) };
}

/** Every note sounding on a step, wrapping at the pattern's own length. */
export function bassNotesAt(pattern: BassPattern, step: number): number[] {
  const n = pattern.notes.length || STEPS_PER_BAR;
  return pattern.notes[((step % n) + n) % n] ?? [];
}

/**
 * The lowest note on a step, or null. Kept for callers that only want one, and
 * because the bass voice is the foundation: if something can play a single note
 * it should be the bottom one.
 */
export function bassNoteAt(pattern: BassPattern, step: number): number | null {
  const stack = bassNotesAt(pattern, step);
  return stack.length > 0 ? stack[0] : null;
}

export function isBassPattern(value: unknown): value is BassPattern {
  if (!value || typeof value !== "object") return false;
  const notes = (value as Partial<BassPattern>).notes;
  if (!Array.isArray(notes)) return false;
  if (
    notes.length < STEPS_PER_BAR ||
    notes.length > MAX_PATTERN_BARS * STEPS_PER_BAR ||
    notes.length % STEPS_PER_BAR !== 0
  ) return false;
  return notes.every(
    (stack) =>
      Array.isArray(stack) &&
      stack.length <= MAX_BASS_LAYERS &&
      stack.every(
        (note) =>
          Number.isInteger(note) && note >= BASS_MIN_MIDI && note <= BASS_MAX_MIDI
      )
  );
}

/**
 * Read a bassline saved in either shape.
 *
 * Projects written before layers existed hold one note or null per step. They
 * load as single-note stacks, so an old project sounds exactly as it did.
 */
export function normalizeBassPattern(value: unknown): BassPattern | null {
  if (!value || typeof value !== "object") return null;
  const notes = (value as { notes?: unknown }).notes;
  if (!Array.isArray(notes)) return null;
  if (
    notes.length < STEPS_PER_BAR ||
    notes.length > MAX_PATTERN_BARS * STEPS_PER_BAR ||
    notes.length % STEPS_PER_BAR !== 0
  ) {
    return null;
  }
  const out: number[][] = [];
  for (const entry of notes) {
    if (entry === null || entry === undefined) out.push([]);
    else if (typeof entry === "number") {
      if (!Number.isFinite(entry)) return null;
      out.push([clampMidi(entry)]);
    } else if (Array.isArray(entry)) out.push(normalizeStack(entry as number[]));
    else return null;
  }
  return { notes: out };
}

export function bassPatternFromPreset(
  name: BassPresetName,
  tonic: number,
  bars = 1
): BassPattern {
  const root = 36 + ((Math.round(tonic) % 12) + 12) % 12;
  const one = emptyBassPattern(1);
  const put = (steps: number[], notes: number[]) => {
    steps.forEach((step, i) => {
      one.notes[step] = [notes[i % notes.length]];
    });
  };
  if (name === "Root pulse") put([0, 4, 8, 12], [root]);
  if (name === "Offbeat") put([2, 6, 10, 14], [root]);
  if (name === "Octave bounce") put([0, 3, 6, 8, 11, 14], [root, root + 12]);
  if (name === "Walking") put([0, 4, 8, 12], [root, root + 4, root + 7, root + 9]);
  if (name === "808 syncopation") put([0, 6, 10, 15], [root, root, root + 7, root + 12]);
  return setBassPatternBars(one, bars);
}


// ---------------------------------------------------------------------------
// Stacked basslines
// ---------------------------------------------------------------------------

/**
 * One bassline in a stack of them.
 *
 * Four notes per step covers a chord but not two parts that move
 * independently, and that is the thing people actually write: a sub holding the
 * root while a line walks over the top is two rhythms, and one grid can only
 * hold one. A lane is a whole bassline of its own - its own bars, its own
 * preset, its own level - and the stack plays them together off the one
 * transport, so pausing the beat still pauses all of them at once.
 */
export interface BassLane {
  id: string;
  name: string;
  pattern: BassPattern;
  /** Silenced but kept, so a layer can be auditioned out and back in. */
  muted: boolean;
  /**
   * Lane level, 0 to 1. Stacked bass parts pile into the same octave and the
   * same corner of the spectrum, so without a level per lane the second layer
   * you add swamps the foundation you wrote first.
   */
  gain: number;
}

/** One note a lane wants to sound, carrying that lane's level with it. */
export interface BassVoice {
  midi: number;
  gain: number;
}

/** How many basslines can be stacked. */
export const MAX_BASS_LANES = 4;

const clampGain = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;

/** Lane names are typed, so drop control characters and keep them short. */
function cleanLaneName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const clean = [...value]
    .filter((ch) => ch >= " ")
    .join("")
    .trim()
    .slice(0, 24);
  return clean || fallback;
}

/** A deep copy, because two lanes must never share note arrays. */
export function cloneBassPattern(pattern: BassPattern): BassPattern {
  return { notes: pattern.notes.map((stack) => [...stack]) };
}

/**
 * The first free `bass-N`.
 *
 * An id has to survive a rename and a reorder, so it can be neither the lane's
 * name nor its position. Counting up to the first gap keeps ids stable and
 * collision-free without a clock or a random source, which also means saving a
 * project twice with no edits in between writes the same bytes.
 */
export function nextBassLaneId(lanes: readonly { id: string }[]): string {
  const taken = new Set(lanes.map((lane) => lane.id));
  // One of the first length+1 candidates is free, by pigeonhole.
  for (let n = 1; n <= lanes.length + 1; n++) {
    const id = `bass-${n}`;
    if (!taken.has(id)) return id;
  }
  return `bass-${lanes.length + 1}`;
}

/** A stack holding one empty lane. There is always at least one lane. */
export function emptyBassStack(bars = 1): BassLane[] {
  return [
    { id: "bass-1", name: "Bass 1", pattern: emptyBassPattern(bars), muted: false, gain: 1 },
  ];
}

/** Wrap a lone bassline as a one-lane stack: what every older project holds. */
export function bassStackFromPattern(pattern: BassPattern): BassLane[] {
  return [
    { id: "bass-1", name: "Bass 1", pattern: cloneBassPattern(pattern), muted: false, gain: 1 },
  ];
}

/** The longest lane's length in bars, which is what the stack loops over. */
export function bassStackBars(lanes: readonly BassLane[]): number {
  return lanes.reduce((bars, lane) => Math.max(bars, bassPatternBars(lane.pattern)), 1);
}

/** The longest lane's length in steps. */
export function bassStackSteps(lanes: readonly BassLane[]): number {
  return bassStackBars(lanes) * STEPS_PER_BAR;
}

/**
 * Add a lane. A full stack comes back unchanged rather than dropping the oldest
 * layer to make room, because silently losing a part someone wrote is worse
 * than a disabled button.
 */
export function addBassLane(lanes: readonly BassLane[], pattern?: BassPattern): BassLane[] {
  if (lanes.length >= MAX_BASS_LANES) return [...lanes];
  return [
    ...lanes,
    {
      id: nextBassLaneId(lanes),
      name: `Bass ${lanes.length + 1}`,
      // A new lane matches the stack's length, so the layers line up instead of
      // wrapping against each other from the first bar.
      pattern: pattern ? cloneBassPattern(pattern) : emptyBassPattern(bassStackBars(lanes)),
      muted: false,
      gain: 1,
    },
  ];
}

/**
 * Copy a lane and drop the copy directly under it. This is how an octave
 * doubling gets written: duplicate the line, then move the copy.
 */
export function duplicateBassLane(lanes: readonly BassLane[], id: string): BassLane[] {
  const index = lanes.findIndex((lane) => lane.id === id);
  if (index < 0 || lanes.length >= MAX_BASS_LANES) return [...lanes];
  const source = lanes[index];
  const copy: BassLane = {
    ...source,
    id: nextBassLaneId(lanes),
    name: cleanLaneName(`${source.name} copy`, `Bass ${lanes.length + 1}`),
    pattern: cloneBassPattern(source.pattern),
  };
  return [...lanes.slice(0, index + 1), copy, ...lanes.slice(index + 1)];
}

/** Remove a lane, never the last one: the stack always has somewhere to write. */
export function removeBassLane(lanes: readonly BassLane[], id: string): BassLane[] {
  if (lanes.length <= 1) return [...lanes];
  const without = lanes.filter((lane) => lane.id !== id);
  return without.length === lanes.length ? [...lanes] : without;
}

/** Change one lane's name, notes, mute or level, leaving the rest alone. */
export function updateBassLane(
  lanes: readonly BassLane[],
  id: string,
  patch: Partial<Omit<BassLane, "id">>
): BassLane[] {
  return lanes.map((lane, index) => {
    if (lane.id !== id) return lane;
    return {
      ...lane,
      ...patch,
      name: patch.name === undefined ? lane.name : cleanLaneName(patch.name, `Bass ${index + 1}`),
      gain: patch.gain === undefined ? lane.gain : clampGain(patch.gain),
      pattern: patch.pattern ? cloneBassPattern(patch.pattern) : lane.pattern,
    };
  });
}

/** Move a lane up or down the stack. Either end of the stack is a no-op. */
export function moveBassLane(lanes: readonly BassLane[], id: string, delta: number): BassLane[] {
  const from = lanes.findIndex((lane) => lane.id === id);
  const to = from + Math.sign(delta);
  if (from < 0 || to < 0 || to >= lanes.length) return [...lanes];
  const next = [...lanes];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Every note the stack sounds on a step, each carrying its lane's level.
 *
 * Muted and silent lanes drop out here rather than at the synth, so a layer you
 * have muted costs nothing to schedule. Each lane wraps at its own length, so a
 * one-bar sub under a four-bar line repeats the way you would expect.
 */
export function bassStackVoicesAt(lanes: readonly BassLane[], step: number): BassVoice[] {
  const voices: BassVoice[] = [];
  for (const lane of lanes) {
    if (lane.muted || lane.gain <= 0) continue;
    for (const midi of bassNotesAt(lane.pattern, step)) voices.push({ midi, gain: lane.gain });
  }
  return voices;
}

/**
 * Read a stack saved in either shape: a list of lanes, or the lone bassline
 * that every project written before stacking holds. Junk reads as null, so a
 * damaged stack costs the bassline rather than the rest of the project.
 */
export function normalizeBassLanes(value: unknown): BassLane[] | null {
  if (!Array.isArray(value)) {
    const single = normalizeBassPattern(value);
    return single && isBassPattern(single) ? bassStackFromPattern(single) : null;
  }
  const lanes: BassLane[] = [];
  for (const entry of value.slice(0, MAX_BASS_LANES)) {
    if (!entry || typeof entry !== "object") return null;
    const raw = entry as Partial<BassLane>;
    const pattern = normalizeBassPattern(raw.pattern);
    if (!pattern || !isBassPattern(pattern)) return null;
    // Two lanes sharing an id would make every edit land on both of them.
    const clash = typeof raw.id !== "string" || !raw.id || lanes.some((l) => l.id === raw.id);
    lanes.push({
      id: clash ? nextBassLaneId(lanes) : (raw.id as string),
      name: cleanLaneName(raw.name, `Bass ${lanes.length + 1}`),
      pattern,
      muted: raw.muted === true,
      gain: clampGain(raw.gain),
    });
  }
  return lanes.length > 0 ? lanes : null;
}
