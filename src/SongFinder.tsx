// SongFinder.tsx - bring a song in: its words, and its chords.
//
// Two halves, because the two things have different sources and only one of
// them can be looked up.
//
// The words come from LRCLIB, an open lyrics database with no key and no
// account. That is a request leaving the machine, which nothing else in dice
// does, so it is behind a switch that stays off until it is turned on and the
// panel says what gets sent.
//
// The chords are pasted. There is no free database of chords for a particular
// song, the sites that have them are licensed or would have to be scraped, and
// dice will not scrape somebody's site out of a user's browser. The step worth
// saving is the retyping, so a sheet copied from wherever they found it is read
// here: chords above the words, or chords in brackets.

import { useCallback, useRef, useState } from "react";
import { parseChordSheet, progressionFromSheet } from "./lib/chordsheet";
import {
  durationLabel,
  searchSongs,
  searchUrl,
  sheetFor,
  type SongHit,
} from "./lib/songsearch";

export interface SongFinderProps {
  /** Put a progression in the chord box. */
  onProgression(text: string): void;
  /** Put words in the lyric pad. */
  onLyrics(text: string): void;
  /** Whether the lyric pad already holds something worth not losing. */
  hasLyrics: boolean;
}

export default function SongFinder({
  onProgression,
  onLyrics,
  hasLyrics,
}: SongFinderProps) {
  const [online, setOnline] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SongHit[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState("");
  const [pasteNote, setPasteNote] = useState("");
  const latest = useRef(0);

  const run = useCallback(async () => {
    const q = query.trim();
    if (q.length < 2) return;
    const ticket = ++latest.current;
    setBusy(true);
    setStatus("");
    try {
      const found = await searchSongs(q, (url) => fetch(url, { method: "GET" }));
      // A slower earlier search must not overwrite a later one.
      if (ticket !== latest.current) return;
      setHits(found);
      setStatus(found.length === 0 ? "Nothing found for that." : "");
    } catch (err) {
      if (ticket !== latest.current) return;
      setHits([]);
      setStatus(
        err instanceof Error ? err.message : "The lyrics search could not be reached."
      );
    } finally {
      if (ticket === latest.current) setBusy(false);
    }
  }, [query]);

  const takeSong = useCallback(
    (hit: SongHit) => {
      const sheet = sheetFor(hit);
      if (sheet === "") return;
      if (hasLyrics && !window.confirm("Replace the words in the lyric pad?")) return;
      onLyrics(sheet);
      setStatus(
        hit.syncedLyrics
          ? `${hit.title} is in the pad, timed, so the wall can caption it.`
          : `${hit.title} is in the pad.`
      );
    },
    [hasLyrics, onLyrics]
  );

  const readPaste = useCallback(() => {
    const sheet = parseChordSheet(paste);
    if (sheet.form === "empty") {
      setPasteNote("Nothing pasted yet.");
      return;
    }
    if (sheet.chords.length === 0) {
      // Still worth something: the words are here even if the chords are not.
      if (sheet.lyrics !== "" && (!hasLyrics || window.confirm("Replace the words in the lyric pad?"))) {
        onLyrics(sheet.lyrics);
        setPasteNote("No chords in that, so the words went to the pad.");
        return;
      }
      setPasteNote("No chords found in that. Chords go above the words, or in [brackets].");
      return;
    }
    onProgression(progressionFromSheet(sheet, 8));
    const kept = Math.min(sheet.chords.length, 8);
    let note = `${kept} chord${kept === 1 ? "" : "s"} into the box`;
    if (sheet.chords.length > kept) note += `, of ${sheet.chords.length} in the sheet`;
    if (sheet.lyrics !== "" && (!hasLyrics || window.confirm("Replace the words in the lyric pad?"))) {
      onLyrics(sheet.lyrics);
      note += ", words into the pad";
    }
    setPasteNote(`${note}.`);
  }, [paste, hasLyrics, onLyrics, onProgression]);

  return (
    <div className="mt-3 rounded-lg border border-purple/30 bg-purple/10 p-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-white/70">
        Bring in a song
      </p>

      {/* The words. */}
      <label className="mt-2 flex items-start gap-2 text-xs text-white/70">
        <input
          type="checkbox"
          checked={online}
          onChange={(e) => {
            setOnline(e.target.checked);
            if (!e.target.checked) {
              setHits([]);
              setStatus("");
            }
          }}
          className="mt-0.5"
        />
        <span>
          Look up lyrics online
          <span className="mt-0.5 block text-[11px] leading-relaxed text-white/45">
            Asks lrclib.net, an open lyrics database with no key and no account.
            What it sends is the words you type in the box. Nothing about your
            takes or your song goes with it. This is the only part of dice that
            talks to anybody.
          </span>
        </span>
      </label>

      {online && (
        <div className="mt-2">
          <div className="flex gap-1.5">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void run();
                }
              }}
              placeholder="song, or song and artist"
              aria-label="search for a song"
              className="min-w-0 flex-1 rounded-lg border border-purple/50 bg-purple/25 px-2 py-1.5 text-sm"
            />
            <button
              type="button"
              onClick={() => void run()}
              disabled={busy || query.trim().length < 2}
              className="rounded-lg bg-purple/35 px-2.5 py-1 text-xs font-semibold text-white/85 transition hover:bg-magenta/40 disabled:opacity-40"
            >
              {busy ? "looking" : "search"}
            </button>
          </div>

          {hits.length > 0 && (
            <div className="mt-1.5 flex flex-col gap-1">
              {hits.map((hit) => (
                <button
                  key={hit.id}
                  type="button"
                  onClick={() => takeSong(hit)}
                  className="rounded-lg border border-purple/30 bg-purple/10 px-2 py-1.5 text-left transition hover:bg-magenta/25"
                >
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-xs font-semibold text-white/85">{hit.title}</span>
                    <span className="text-[11px] text-white/55">{hit.artist}</span>
                    <span className="text-[11px] text-white/35">
                      {durationLabel(hit.durationSec)}
                      {hit.syncedLyrics ? " · timed" : ""}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {status && <p className="mt-1 text-[11px] text-white/55">{status}</p>}
          <p className="mt-1 break-all text-[10px] text-white/25">{searchUrl(query || "…")}</p>
        </div>
      )}

      {/* The chords. */}
      <div className="mt-3 border-t border-purple/20 pt-2">
        <p className="text-xs text-white/70">Paste a chord sheet</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-white/45">
          Chords for a particular song are not something dice can look up. The
          sites that hold them are licensed or would have to be scraped. Paste a
          sheet from wherever you found it and dice will read it: chords above
          the words, or chords in [brackets].
        </p>
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          rows={3}
          spellCheck={false}
          placeholder={"C              G\nNow I've heard there was a secret chord"}
          className="mt-1.5 w-full resize-y rounded-lg border border-purple/40 bg-ink/40 px-2 py-1.5 font-mono text-xs text-white/85 placeholder:text-white/25"
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={readPaste}
            disabled={paste.trim() === ""}
            className="rounded-lg bg-purple/35 px-2.5 py-1 text-xs font-semibold text-white/85 transition hover:bg-magenta/40 disabled:opacity-40"
          >
            read it
          </button>
          {pasteNote && <span className="text-[11px] text-white/55">{pasteNote}</span>}
        </div>
      </div>
    </div>
  );
}
