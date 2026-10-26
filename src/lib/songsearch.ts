// songsearch.ts - finding the words to a song.
//
// This is the one part of dice that talks to anybody. Everything else runs on
// the machine it is open on, and the camera and the microphone never leave it,
// so a feature that sends a search somewhere has to be asked for rather than
// assumed, and has to say what it sends.
//
// It asks LRCLIB (lrclib.net), which is an open lyrics database with no key, no
// account and no tracking, used by a number of open-source music players. What
// goes out is the words typed into the search box. Nothing about the session,
// the takes or the song being written goes with it.
//
// Chords are not here, because there is no equivalent for them. The free chord
// sites are either licensed or scraped, and dice will not scrape somebody's
// site from a user's browser. What dice does instead is read a chord sheet
// pasted in from wherever they already found it. See chordsheet.ts.

export interface SongHit {
  id: number;
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  /** The words, unsynced. Empty for an instrumental. */
  plainLyrics: string;
  /** The words with timestamps, when the database has them. */
  syncedLyrics: string;
}

export const LYRICS_ENDPOINT = "https://lrclib.net/api/search";

/** What a search sends, so the UI can say it before sending anything. */
export function searchUrl(query: string): string {
  return `${LYRICS_ENDPOINT}?q=${encodeURIComponent(query.trim())}`;
}

type Fetcher = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** One row of whatever the endpoint returned, read defensively. */
function readHit(row: unknown): SongHit | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const title = typeof r.trackName === "string" ? r.trackName : r.name;
  if (typeof title !== "string" || title === "") return null;
  return {
    id: typeof r.id === "number" ? r.id : 0,
    title,
    artist: typeof r.artistName === "string" ? r.artistName : "",
    album: typeof r.albumName === "string" ? r.albumName : "",
    durationSec: typeof r.duration === "number" ? r.duration : 0,
    plainLyrics: typeof r.plainLyrics === "string" ? r.plainLyrics : "",
    syncedLyrics: typeof r.syncedLyrics === "string" ? r.syncedLyrics : "",
  };
}

/**
 * Search for a song's words.
 *
 * `fetcher` is injected so the search can be tested without a network, and so
 * the caller is the one deciding a request happens at all.
 */
export async function searchSongs(
  query: string,
  fetcher: Fetcher,
  limit = 6
): Promise<SongHit[]> {
  const q = (query ?? "").trim();
  if (q.length < 2) return [];
  const response = await fetcher(searchUrl(q));
  if (!response.ok) throw new Error("The lyrics search could not be reached.");
  const body = await response.json();
  if (!Array.isArray(body)) return [];
  const hits: SongHit[] = [];
  for (const row of body) {
    const hit = readHit(row);
    // An instrumental has nothing to write down.
    if (hit && (hit.plainLyrics !== "" || hit.syncedLyrics !== "")) hits.push(hit);
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * Turn LRC timestamps into the stamps dice writes.
 *
 * LRC marks a line `[01:04.25] words`. dice's lyric sheet already pins a line
 * with `1:04` at its head, so a synced lyric converts straight into a timed
 * caption, which is the same thing the wall burns into a bounce. Hundredths are
 * dropped: they matter to a karaoke player following a record and not to
 * someone singing over their own take.
 */
export function lrcToSheet(synced: string): string {
  const out: string[] = [];
  for (const line of (synced ?? "").split(/\r?\n/)) {
    const m = /^\s*\[(\d{1,2}):(\d{2})(?:[.:]\d{1,3})?\]\s*(.*)$/.exec(line);
    if (!m) {
      const bare = line.trim();
      if (bare !== "" && !/^\[[a-z]+:/i.test(bare)) out.push(bare);
      continue;
    }
    const minutes = Number(m[1]);
    const seconds = Number(m[2]);
    const words = m[3].trim();
    // A stamp with no words is a gap the player holds. dice says that with an
    // empty line, which its own sheet already reads as a gap.
    out.push(words === "" ? "" : `${minutes}:${String(seconds).padStart(2, "0")} ${words}`);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The sheet to hand the notepad: timed when the database has timings. */
export function sheetFor(hit: SongHit): string {
  const timed = hit.syncedLyrics ? lrcToSheet(hit.syncedLyrics) : "";
  return timed !== "" ? timed : hit.plainLyrics.trim();
}

/** "3:21", for the result row. */
export function durationLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
