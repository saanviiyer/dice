// lyrics.ts - words on the video, and when they show.
//
// Two jobs, one sheet of text. While you record, the current line is the
// teleprompter you sing from; when the wall is bounced, the same line is burnt
// into the picture. Writing the words once and having them do both is the whole
// point: a lyric you typed to read from is already the caption you wanted.
//
// Timing is deliberately forgiving. A line can carry a stamp ("0:12 hold me"),
// and any line without one is spread evenly through the gap it sits in. That
// means a plain block of lyrics works with no timing at all, and you can pin
// the one line that matters without stamping the rest.

export interface LyricCue {
  startMs: number;
  endMs: number;
  text: string;
}

/** A stamp at the head of a line: "0:12", "1:04.5", "[0:12]" or "12s". */
const STAMP = /^\[?\s*(?:(\d+):)?(\d{1,2}(?:\.\d+)?)\s*s?\s*\]?\s+(.*)$/;

/**
 * Read a stamped line into milliseconds and the words after it.
 *
 * Returns null when the line has no stamp, which is the common case and not an
 * error: an unstamped line is one the parser gets to place itself.
 */
export function parseLyricLine(line: string): { atMs: number; text: string } | null {
  const m = STAMP.exec(line.trim());
  if (!m) return null;
  const mins = m[1] ? Number(m[1]) : 0;
  const secs = Number(m[2]);
  const text = m[3].trim();
  if (!Number.isFinite(mins) || !Number.isFinite(secs) || !text) return null;
  // A bare "12" with no colon is seconds, and seconds past 59 in "1:75" are
  // still just seconds - people write both and neither is worth rejecting.
  return { atMs: Math.round((mins * 60 + secs) * 1000), text };
}

/**
 * Turn a lyric sheet into cues over a video of `durationMs`.
 *
 * Blank lines are held as gaps, so leaving a line empty is how you get a moment
 * with no caption over it rather than a caption that never goes away. Stamped
 * lines anchor where they were put; runs of unstamped lines divide the time
 * between the anchors on either side of them evenly.
 */
export function parseLyrics(text: string, durationMs: number): LyricCue[] {
  const total = Math.max(0, Math.round(durationMs));
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  // Trailing blanks would otherwise eat the end of the song with silence.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0 || total <= 0) return [];

  // Each entry is either a stamped anchor or a slot waiting to be placed. Blank
  // lines take a slot too: they are the gaps.
  const entries = lines.map((line) => {
    const stamped = parseLyricLine(line);
    return stamped
      ? { atMs: Math.min(stamped.atMs, total), text: stamped.text }
      : { atMs: null as number | null, text: line };
  });

  // Anchors have to run forwards, or a cue would end before it started.
  let floor = 0;
  for (const entry of entries) {
    if (entry.atMs === null) continue;
    entry.atMs = Math.max(floor, entry.atMs);
    floor = entry.atMs;
  }

  const starts: number[] = new Array(entries.length).fill(0);
  let i = 0;
  let from = 0;
  // Whether `from` is already taken by a stamped line. If it is, the run that
  // follows has to share the gap with it rather than starting on top of it.
  let fromTaken = false;
  while (i < entries.length) {
    const anchored = entries[i].atMs;
    if (anchored !== null) {
      starts[i] = anchored;
      from = anchored;
      fromTaken = true;
      i += 1;
      continue;
    }
    // A run of unstamped lines, up to the next anchor or the end of the video.
    let j = i;
    while (j < entries.length && entries[j].atMs === null) j += 1;
    const until = j < entries.length ? (entries[j].atMs as number) : total;
    const count = j - i;
    const slots = count + (fromTaken ? 1 : 0);
    const span = Math.max(0, until - from);
    const step = slots > 0 ? span / slots : 0;
    const base = fromTaken ? from + step : from;
    for (let k = 0; k < count; k += 1) starts[i + k] = base + step * k;
    from = until;
    fromTaken = j < entries.length;
    i = j;
  }

  const cues: LyricCue[] = [];
  for (let n = 0; n < entries.length; n += 1) {
    const start = Math.round(starts[n]);
    const end = Math.round(n + 1 < entries.length ? starts[n + 1] : total);
    if (!entries[n].text) continue; // a blank line is a gap, not a caption
    // Two lines stamped at the same moment: only one of them can show, and it
    // is the later one, so the first is dropped rather than flashed for 0ms.
    if (end <= start) continue;
    cues.push({ startMs: start, endMs: end, text: entries[n].text });
  }
  return cues;
}

/** The line showing at `ms`, or "" when the video is between lines. */
export function lyricAt(cues: LyricCue[], ms: number): string {
  for (const cue of cues) {
    if (ms >= cue.startMs && ms < cue.endMs) return cue.text;
  }
  return "";
}

/**
 * Break a line so it fits `maxChars` per row, at most `maxRows` rows.
 *
 * Words are kept whole, because a caption hyphenated mid-word is harder to sing
 * from than one that runs a little wide. Anything past the last row is dropped:
 * a caption that covers the picture is worse than one that says less.
 */
export function wrapLyric(text: string, maxChars: number, maxRows = 2): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const limit = Math.max(1, Math.floor(maxChars));
  const rows: string[] = [];
  let row = "";
  for (const word of words) {
    const next = row ? `${row} ${word}` : word;
    if (next.length <= limit || !row) {
      row = next;
    } else {
      rows.push(row);
      row = word;
      if (rows.length === maxRows) break;
    }
  }
  if (row && rows.length < maxRows) rows.push(row);
  return rows.slice(0, Math.max(1, maxRows));
}
