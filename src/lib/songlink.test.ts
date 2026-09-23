import { describe, expect, it } from "vitest";
import {
  SONG_LINK_COMFORTABLE_CHARS,
  base64urlToBytes,
  bytesToBase64url,
  decodeSong,
  encodeSong,
  encodeSongBytes,
  songFromUrl,
  songLinkUrl,
  type SongLink,
} from "./songlink";
import { ACCENT, GHOST, NORMAL, emptyPattern, setStep, STEPS_PER_BAR } from "./drums";
import { addBassLane, bassStackFromPattern, emptyBassPattern, setBassNote, updateBassLane } from "./bass";

function song(over: Partial<SongLink> = {}): SongLink {
  const drums = setStep(setStep(emptyPattern(1), "kick", 0, true), "snare", 4, true);
  return {
    name: "Take one",
    bpm: 128,
    tonic: 7,
    scale: "minor",
    mode: "diatonic",
    progression: "Am E F C",
    preset: "Acoustic guitar",
    drums,
    bass: bassStackFromPattern(setBassNote(emptyBassPattern(1), 0, 36)),
    lyrics: "hold me closer",
    ...over,
  };
}

describe("a song in a link", () => {
  it("comes back the way it went in", () => {
    const original = song();
    const back = decodeSong(encodeSong(original));
    expect(back).not.toBeNull();
    expect(back!.name).toBe("Take one");
    expect(back!.bpm).toBe(128);
    expect(back!.tonic).toBe(7);
    expect(back!.scale).toBe("minor");
    expect(back!.mode).toBe("diatonic");
    expect(back!.progression).toBe("Am E F C");
    expect(back!.preset).toBe("Acoustic guitar");
    expect(back!.lyrics).toBe("hold me closer");
  });

  it("carries the beat, hit for hit", () => {
    const drums = setStep(
      setStep(setStep(emptyPattern(2), "kick", 0, true), "hat", 17, true),
      "snare",
      20,
      true
    );
    const back = decodeSong(encodeSong(song({ drums })))!;
    expect(back.drums.kick[0]).toBeGreaterThan(0);
    expect(back.drums.hat[17]).toBeGreaterThan(0);
    expect(back.drums.snare[20]).toBeGreaterThan(0);
    expect(back.drums.kick).toHaveLength(2 * STEPS_PER_BAR);
    expect(back.drums.kick[1]).toBe(0);
  });

  it("keeps accents and ghost notes apart", () => {
    const drums = emptyPattern(1);
    drums.kick[0] = ACCENT;
    drums.kick[4] = NORMAL;
    drums.kick[8] = GHOST;
    const back = decodeSong(encodeSong(song({ drums })))!;
    expect(back.drums.kick[0]).toBe(ACCENT);
    expect(back.drums.kick[4]).toBe(NORMAL);
    expect(back.drums.kick[8]).toBe(GHOST);
  });

  it("carries a stack of basslines with their levels and mutes", () => {
    let bass = bassStackFromPattern(setBassNote(emptyBassPattern(1), 0, 36));
    bass = addBassLane(bass, setBassNote(emptyBassPattern(1), 8, 48));
    bass = updateBassLane(bass, bass[1].id, { gain: 0.5, muted: true });
    const back = decodeSong(encodeSong(song({ bass })))!;
    expect(back.bass).toHaveLength(2);
    expect(back.bass[0].pattern.notes[0]).toEqual([36]);
    expect(back.bass[1].pattern.notes[8]).toEqual([48]);
    expect(back.bass[1].muted).toBe(true);
    expect(back.bass[1].gain).toBeCloseTo(0.5, 2);
  });

  it("keeps the notes stacked in a step", () => {
    const bass = bassStackFromPattern(setBassNote(emptyBassPattern(1), 0, [36, 43, 48]));
    const back = decodeSong(encodeSong(song({ bass })))!;
    expect(back.bass[0].pattern.notes[0]).toEqual([36, 43, 48]);
  });

  it("stays short enough to paste", () => {
    // A full four-bar beat, four basslines and a lyric: the worst case someone
    // is likely to share.
    let bass = bassStackFromPattern(emptyBassPattern(4));
    for (let i = 0; i < 3; i += 1) bass = addBassLane(bass);
    bass = bass.map((lane) => ({
      ...lane,
      pattern: {
        notes: lane.pattern.notes.map((_, s) => (s % 2 === 0 ? [36, 48] : [])),
      },
    }));
    const drums = emptyPattern(4);
    for (const lane of ["kick", "snare", "hat"] as const) {
      drums[lane] = drums[lane].map(() => NORMAL);
    }
    const link = encodeSong(song({ drums, bass, lyrics: "x".repeat(600) }));
    expect(link.length).toBeLessThan(SONG_LINK_COMFORTABLE_CHARS);
  });

  it("survives a round trip through a URL", () => {
    const url = songLinkUrl("https://dice.fm/studio", song({ name: "Shared" }));
    expect(url).toContain("#/studio?s=");
    const back = songFromUrl(url);
    expect(back?.name).toBe("Shared");
  });

  it("finds nothing in a URL that carries nothing", () => {
    expect(songFromUrl("https://dice.fm/#/studio")).toBeNull();
    expect(songFromUrl("https://dice.fm/")).toBeNull();
    expect(songFromUrl("https://dice.fm/#/studio?other=1")).toBeNull();
  });
});

describe("links that are not songs", () => {
  it("refuses junk rather than opening half a song", () => {
    expect(decodeSong("")).toBeNull();
    expect(decodeSong("not a song")).toBeNull(); // spaces are not in the alphabet
    expect(decodeSong("AAAA")).toBeNull(); // right alphabet, wrong version
  });

  it("refuses a payload that was cut short", () => {
    const full = encodeSong(song());
    expect(decodeSong(full.slice(0, Math.floor(full.length / 2)))).toBeNull();
  });

  it("refuses a scale this build cannot play", () => {
    // The notes are the song; opening it in some other scale is not opening it.
    // Rename the scale in the payload to one that does not exist, same length,
    // so everything around it stays where it was.
    const bytes = encodeSongBytes(song({ scale: "major" }));
    const text = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    const at = text.indexOf("major");
    expect(at).toBeGreaterThan(0);
    const patched = Uint8Array.from(bytes);
    "kazoo".split("").forEach((ch, i) => {
      patched[at + i] = ch.charCodeAt(0);
    });
    expect(decodeSong(bytesToBase64url(patched))).toBeNull();
  });

  it("opens a song written with a sound this build does not have", () => {
    // A voice is cosmetic where the notes are not, so it falls back rather
    // than refusing the song.
    const back = decodeSong(encodeSong(song({ preset: "Theremin" })), ["Basic", "Piano"]);
    expect(back).not.toBeNull();
    expect(back!.preset).toBe("");
  });

  it("keeps the sound when the build does know it", () => {
    const back = decodeSong(encodeSong(song({ preset: "Piano" })), ["Basic", "Piano"]);
    expect(back!.preset).toBe("Piano");
  });
});

describe("base64url", () => {
  it("round-trips bytes of every length", () => {
    for (let n = 0; n < 8; n += 1) {
      const bytes = new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37) % 256));
      expect([...base64urlToBytes(bytesToBase64url(bytes))!]).toEqual([...bytes]);
    }
  });

  it("stays inside the URL-safe alphabet", () => {
    const bytes = new Uint8Array(Array.from({ length: 300 }, (_, i) => i % 256));
    expect(bytesToBase64url(bytes)).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("reads nothing out of characters that are not base64url", () => {
    expect(base64urlToBytes("has spaces")).toBeNull();
    expect(base64urlToBytes("plus+slash/")).toBeNull();
  });
});
