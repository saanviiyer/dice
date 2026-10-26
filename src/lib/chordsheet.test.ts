import { describe, expect, it } from "vitest";
import { parseChordSheet, progressionFromSheet } from "./chordsheet";

describe("chords written above the words", () => {
  const sheet = `Verse 1
C              G
Now I've heard there was a secret chord
Am             F
That David played and it pleased the Lord`;

  it("takes the chords and leaves the words", () => {
    const out = parseChordSheet(sheet);
    expect(out.form).toBe("over");
    expect(out.chords).toEqual(["C", "G", "Am", "F"]);
    expect(out.lyrics).toContain("Now I've heard there was a secret chord");
    expect(out.lyrics).not.toContain("Am");
  });

  it("keeps a section marker out of the chords", () => {
    // "Verse 1" is not a chord, and neither is a bare "A" heading a line of
    // words, which is why a chord line has to be chords all the way across.
    const out = parseChordSheet(sheet);
    expect(out.chords).not.toContain("Verse");
    expect(out.lyrics).toContain("Verse 1");
  });

  it("reads a line of words that starts with a note name as words", () => {
    const out = parseChordSheet("A man walks into the room\nAnd everyone turns");
    expect(out.form).toBe("lyrics-only");
    expect(out.chords).toEqual([]);
    expect(out.lyrics.split("\n")).toHaveLength(2);
  });

  it("ignores bar lines and repeat marks", () => {
    const out = parseChordSheet("| C | G | Am | F |\nsome words here");
    expect(out.chords).toEqual(["C", "G", "Am", "F"]);
  });

  it("takes the chord from a slash chord and drops the bass note", () => {
    const out = parseChordSheet("C/G  G/B  Am\nwords");
    expect(out.chords).toEqual(["C", "G", "Am"]);
  });

  it("collapses a chord held across a line", () => {
    const out = parseChordSheet("C   C   C   G\nwords");
    expect(out.chords).toEqual(["C", "G"]);
  });
});

describe("chords written in brackets", () => {
  it("takes them out of the words in the order they fall", () => {
    const out = parseChordSheet("Now I've [C]heard there was a secret [G]chord");
    expect(out.form).toBe("inline");
    expect(out.chords).toEqual(["C", "G"]);
    expect(out.lyrics).toBe("Now I've heard there was a secret chord");
  });

  it("leaves a bracket that is not a chord alone", () => {
    const out = parseChordSheet("[Chorus]\n[C]hold me [Am]closer");
    expect(out.chords).toEqual(["C", "Am"]);
    expect(out.lyrics).toContain("[Chorus]");
  });

  it("handles sevenths and sus chords in brackets", () => {
    const out = parseChordSheet("[Dm7]one [G7]two [Cmaj7]three [Dsus4]four");
    expect(out.chords).toEqual(["Dm7", "G7", "Cmaj7", "Dsus4"]);
  });
});

describe("what the box gets", () => {
  it("keeps the opening run rather than three minutes of chords", () => {
    const long = Array.from({ length: 40 }, (_, i) => (i % 2 ? "G" : "C")).join(" ");
    const sheet = parseChordSheet(`${long}\nwords`);
    expect(progressionFromSheet(sheet, 4)).toBe("C G C G");
  });

  it("writes the chords space separated, the way the box reads them", () => {
    const sheet = parseChordSheet("Am  F  C  G\nwords");
    expect(progressionFromSheet(sheet)).toBe("Am F C G");
  });

  it("has nothing to say about an empty paste", () => {
    const out = parseChordSheet("   ");
    expect(out).toEqual({ chords: [], lyrics: "", form: "empty" });
    expect(progressionFromSheet(out)).toBe("");
  });

  it("reads a sheet that is only chords", () => {
    const out = parseChordSheet("C G Am F");
    expect(out.form).toBe("chords-only");
    expect(out.chords).toEqual(["C", "G", "Am", "F"]);
    expect(out.lyrics).toBe("");
  });
});
