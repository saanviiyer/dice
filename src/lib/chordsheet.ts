// chordsheet.ts - reading a chord sheet someone pasted in.
//
// There is no free database of chords for particular songs. Lyrics have one,
// and dice uses it, but chords are either licensed or scraped, and neither
// belongs in this app. What people have instead is a tab open with a chord
// sheet in it, and the step they are actually trying to skip is retyping it.
//
// So this reads the two shapes a chord sheet comes in. Either the chords sit on
// their own line above the words:
//
//     C              G
//     Now I've heard there was a secret chord
//
// or they sit inline, in brackets, where they fall:
//
//     Now I've [C]heard there was a secret [G]chord
//
// Both give up the same two things: the chords in the order they are played,
// and the words with the chords taken out of them.

import { parseChord } from "./music";

export interface ChordSheet {
  /** Chords in the order they appear, immediate repeats collapsed. */
  chords: string[];
  /** The words, with any chord markup removed. */
  lyrics: string;
  /** How the sheet was written, for the UI to say what it found. */
  form: "over" | "inline" | "chords-only" | "lyrics-only" | "empty";
}

/** Tokens that look like chords but are nearly always section markers. */
const SECTION = /^\[?(intro|verse|chorus|bridge|outro|pre.?chorus|hook|solo|interlude|refrain|tag|coda|instrumental)\b/i;

/** A bar line or a repeat mark, which a sheet uses and a chord list does not. */
const PUNCTUATION = /^[|\/:.\-x\d()]+$/i;

const isChord = (token: string): boolean => {
  const clean = token.replace(/[|,]/g, "").trim();
  if (!clean || PUNCTUATION.test(clean) || SECTION.test(clean)) return false;
  // A slash chord names its bass note after the slash; the chord itself is the
  // part before it, and that is what dice can play.
  const head = clean.split("/")[0];
  return parseChord(head) !== null;
};

/**
 * Is this line chords rather than words?
 *
 * Every token has to parse as a chord. One word that does not makes it a lyric
 * line that happens to start with a note name, and "A" opening a sentence is
 * common enough that the stricter test is the right one.
 */
function isChordLine(line: string): boolean {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const chords = tokens.filter(isChord);
  const ignorable = tokens.filter((t) => PUNCTUATION.test(t.trim()));
  return chords.length > 0 && chords.length + ignorable.length === tokens.length;
}

/** The chords in a line, in order, with bass notes dropped. */
function chordsIn(line: string): string[] {
  return line
    .trim()
    .split(/\s+/)
    .filter(isChord)
    .map((t) => t.replace(/[|,]/g, "").trim().split("/")[0]);
}

/** Collapse a chord repeated immediately, which is a sheet holding it. */
function collapse(chords: string[]): string[] {
  return chords.filter((c, i) => i === 0 || c !== chords[i - 1]);
}

/**
 * Read a pasted sheet.
 *
 * Inline brackets win when both forms are present, because a sheet that uses
 * them uses them throughout, and a stray bracket above a line is more likely to
 * be a section marker than a chord row.
 */
export function parseChordSheet(text: string): ChordSheet {
  const raw = (text ?? "").replace(/\r\n?/g, "\n");
  if (raw.trim() === "") return { chords: [], lyrics: "", form: "empty" };

  // Inline, in brackets.
  const bracket = /\[([^\]\n]{1,12})\]/g;
  const bracketed: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = bracket.exec(raw)) !== null) {
    const inner = match[1].trim();
    if (isChord(inner)) bracketed.push(inner.split("/")[0]);
  }
  if (bracketed.length > 1) {
    const lyrics = raw
      .replace(bracket, (whole, inner) => (isChord(String(inner).trim()) ? "" : whole))
      .split("\n")
      .map((l) => l.replace(/[ \t]{2,}/g, " ").trimEnd())
      .join("\n")
      .trim();
    return { chords: collapse(bracketed), lyrics, form: "inline" };
  }

  // Chords on their own lines, words on the others.
  const lines = raw.split("\n");
  const chords: string[] = [];
  const lyricLines: string[] = [];
  let chordLines = 0;
  for (const line of lines) {
    if (isChordLine(line)) {
      chordLines += 1;
      chords.push(...chordsIn(line));
    } else {
      lyricLines.push(line.trimEnd());
    }
  }

  const lyrics = lyricLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (chordLines === 0) return { chords: [], lyrics, form: "lyrics-only" };
  if (lyrics === "") return { chords: collapse(chords), lyrics: "", form: "chords-only" };
  return { chords: collapse(chords), lyrics, form: "over" };
}

/**
 * The progression as the chord box takes it.
 *
 * Long sheets repeat the same four chords for three minutes, and a progression
 * box with ninety chords in it is not something anybody can play from, so this
 * keeps the first run of them. `bars` is how many distinct chords to keep.
 */
export function progressionFromSheet(sheet: ChordSheet, bars = 8): string {
  return sheet.chords.slice(0, Math.max(1, bars)).join(" ");
}
