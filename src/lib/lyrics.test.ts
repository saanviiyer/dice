import { describe, expect, it } from "vitest";
import { lyricAt, parseLyricLine, parseLyrics, wrapLyric } from "./lyrics";

describe("lyric timing", () => {
  it("spreads unstamped lines evenly across the video", () => {
    const cues = parseLyrics("one\ntwo\nthree\nfour", 8000);
    expect(cues.map((c) => c.text)).toEqual(["one", "two", "three", "four"]);
    expect(cues.map((c) => c.startMs)).toEqual([0, 2000, 4000, 6000]);
    expect(cues[3].endMs).toBe(8000);
  });

  it("pins a stamped line and fits the rest around it", () => {
    // The point of stamping one line is not having to stamp the others.
    const cues = parseLyrics("one\ntwo\n0:06 chorus\nout", 8000);
    expect(cues.map((c) => [c.text, c.startMs])).toEqual([
      ["one", 0],
      ["two", 3000],
      ["chorus", 6000],
      ["out", 7000],
    ]);
  });

  it("reads the stamps people actually type", () => {
    expect(parseLyricLine("0:12 hold me")).toEqual({ atMs: 12000, text: "hold me" });
    expect(parseLyricLine("[1:04] hold me")).toEqual({ atMs: 64000, text: "hold me" });
    expect(parseLyricLine("1:04.5 hold me")).toEqual({ atMs: 64500, text: "hold me" });
    expect(parseLyricLine("12s hold me")).toEqual({ atMs: 12000, text: "hold me" });
    expect(parseLyricLine("hold me")).toBeNull();
    expect(parseLyricLine("0:12")).toBeNull();
  });

  it("keeps a blank line as a gap with no caption over it", () => {
    const cues = parseLyrics("one\n\ntwo", 6000);
    expect(cues.map((c) => c.text)).toEqual(["one", "two"]);
    expect(cues[0].endMs).toBe(2000);
    expect(cues[1].startMs).toBe(4000);
    expect(lyricAt(cues, 3000)).toBe("");
  });

  it("never lets a stamp run backwards past the line before it", () => {
    // A backwards stamp is pulled up to the line before it. Both would then
    // start at the same instant and only one can show, so the sheet keeps the
    // later line rather than flashing the first for no time at all.
    const cues = parseLyrics("0:04 later\n0:01 earlier", 8000);
    expect(cues).toEqual([{ startMs: 4000, endMs: 8000, text: "earlier" }]);
    expect(cues.every((c) => c.endMs > c.startMs)).toBe(true);
  });

  it("says nothing rather than guessing when there is no video yet", () => {
    expect(parseLyrics("one\ntwo", 0)).toEqual([]);
    expect(parseLyrics("", 8000)).toEqual([]);
    expect(parseLyrics("\n\n\n", 8000)).toEqual([]);
  });

  it("ignores trailing blank lines instead of ending on silence", () => {
    const cues = parseLyrics("one\ntwo\n\n\n", 4000);
    expect(cues.map((c) => c.startMs)).toEqual([0, 2000]);
    expect(cues[1].endMs).toBe(4000);
  });

  it("finds the line showing at a moment", () => {
    const cues = parseLyrics("one\ntwo", 4000);
    expect(lyricAt(cues, 0)).toBe("one");
    expect(lyricAt(cues, 1999)).toBe("one");
    expect(lyricAt(cues, 2000)).toBe("two");
    expect(lyricAt(cues, 4000)).toBe("");
    expect(lyricAt([], 100)).toBe("");
  });
});

describe("wrapping a caption", () => {
  it("breaks between words, never inside one", () => {
    expect(wrapLyric("hold me closer tiny dancer", 12)).toEqual([
      "hold me",
      "closer tiny",
    ]);
  });

  it("keeps a word that is longer than the line rather than losing it", () => {
    expect(wrapLyric("supercalifragilistic", 8)).toEqual(["supercalifragilistic"]);
  });

  it("stops at the row limit, because a caption must not cover the picture", () => {
    expect(wrapLyric("one two three four five six", 8, 2)).toHaveLength(2);
    expect(wrapLyric("", 10)).toEqual([]);
  });
});
