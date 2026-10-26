import { describe, expect, it } from "vitest";
import {
  durationLabel,
  lrcToSheet,
  searchSongs,
  searchUrl,
  sheetFor,
  type SongHit,
} from "./songsearch";

const row = (over: Record<string, unknown> = {}) => ({
  id: 1,
  trackName: "Hallelujah",
  artistName: "Leonard Cohen",
  albumName: "Various Positions",
  duration: 279,
  plainLyrics: "Now I've heard there was a secret chord",
  syncedLyrics: "",
  ...over,
});

const stub = (body: unknown, ok = true) => async () => ({
  ok,
  json: async () => body,
});

describe("searching for a song", () => {
  it("sends only what was typed", () => {
    expect(searchUrl(" hallelujah cohen ")).toBe(
      "https://lrclib.net/api/search?q=hallelujah%20cohen"
    );
  });

  it("reads the rows it gets back", async () => {
    const hits = await searchSongs("hallelujah", stub([row()]));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      title: "Hallelujah",
      artist: "Leonard Cohen",
      durationSec: 279,
    });
  });

  it("leaves instrumentals out, having nothing to write down", async () => {
    const hits = await searchSongs(
      "theme",
      stub([row({ plainLyrics: "", syncedLyrics: "", trackName: "Theme" }), row()])
    );
    expect(hits.map((h) => h.title)).toEqual(["Hallelujah"]);
  });

  it("does not search for one letter", async () => {
    let called = false;
    await searchSongs("a", async () => {
      called = true;
      return { ok: true, json: async () => [] };
    });
    expect(called).toBe(false);
  });

  it("says so when the search cannot be reached", async () => {
    await expect(searchSongs("x y", stub([], false))).rejects.toThrow(/could not be reached/);
  });

  it("survives a reply that is not what it expected", async () => {
    expect(await searchSongs("x y", stub({ error: "nope" }))).toEqual([]);
    expect(await searchSongs("x y", stub([null, 7, { trackName: "" }]))).toEqual([]);
  });

  it("keeps the list short enough to look at", async () => {
    const many = Array.from({ length: 30 }, (_, i) => row({ id: i, trackName: `Song ${i}` }));
    expect(await searchSongs("song", stub(many), 4)).toHaveLength(4);
  });
});

describe("timed lyrics", () => {
  it("turns LRC stamps into the stamps the sheet writes", () => {
    const lrc = "[00:12.34] the first line\n[01:04.80] the second line";
    expect(lrcToSheet(lrc)).toBe("0:12 the first line\n1:04 the second line");
  });

  it("keeps a stamped gap as a blank line, which the sheet reads as a gap", () => {
    expect(lrcToSheet("[00:05.00] words\n[00:09.00] \n[00:11.00] more")).toBe(
      "0:05 words\n\n0:11 more"
    );
  });

  it("drops the file's own metadata lines", () => {
    expect(lrcToSheet("[ar: Leonard Cohen]\n[00:01.00] words")).toBe("0:01 words");
  });

  it("prefers timed words, and falls back to plain ones", () => {
    const timed: SongHit = {
      ...row(),
      syncedLyrics: "[00:03.00] timed",
      plainLyrics: "plain",
    } as unknown as SongHit;
    expect(sheetFor(timed)).toBe("0:03 timed");
    expect(sheetFor({ ...timed, syncedLyrics: "" })).toBe("plain");
  });
});

describe("the result row", () => {
  it("writes a duration people read", () => {
    expect(durationLabel(279)).toBe("4:39");
    expect(durationLabel(61)).toBe("1:01");
    expect(durationLabel(0)).toBe("");
    expect(durationLabel(Number.NaN)).toBe("");
  });
});
