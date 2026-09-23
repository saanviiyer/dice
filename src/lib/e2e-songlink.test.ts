import { describe, expect, it } from "vitest";
import { decodeSong, encodeSong, songFromUrl, songLinkUrl } from "./songlink";
import { PRESET_NAMES } from "./presets";
import { emptyPattern, setStep } from "./drums";
import { addBassLane, bassStackFromPattern, emptyBassPattern, setBassNote } from "./bass";

/**
 * The trip a song actually makes: written in one studio, pasted into an address
 * bar, opened in another. Everything in between is the format, and every field
 * here is one the studio reads straight into its own controls.
 */
describe("the trip a shared song makes", () => {
  it("arrives in another browser as the same song", () => {
    let bass = bassStackFromPattern(setBassNote(emptyBassPattern(2), 0, 36));
    bass = addBassLane(bass, setBassNote(emptyBassPattern(2), 16, 43));
    const written = {
      name: "Bedroom demo",
      bpm: 96,
      tonic: 5,
      scale: "dorian" as const,
      mode: "progression" as const,
      progression: "Dm7 G7 Cmaj7",
      preset: PRESET_NAMES[0],
      drums: setStep(setStep(emptyPattern(2), "kick", 0, true), "hat", 30, true),
      bass,
      lyrics: "0:04 the second line\nthe first one",
    };

    // Written here, pasted there.
    const url = songLinkUrl("https://dice.example/#/studio", written);
    const opened = songFromUrl(url, PRESET_NAMES)!;

    expect(opened.name).toBe("Bedroom demo");
    expect(opened.bpm).toBe(96);
    expect(opened.tonic).toBe(5);
    expect(opened.scale).toBe("dorian");
    expect(opened.mode).toBe("progression");
    expect(opened.progression).toBe("Dm7 G7 Cmaj7");
    expect(opened.preset).toBe(PRESET_NAMES[0]);
    expect(opened.lyrics).toBe("0:04 the second line\nthe first one");
    expect(opened.drums.kick[0]).toBeGreaterThan(0);
    expect(opened.drums.hat[30]).toBeGreaterThan(0);
    expect(opened.bass).toHaveLength(2);
    expect(opened.bass[0].pattern.notes[0]).toEqual([36]);
    expect(opened.bass[1].pattern.notes[16]).toEqual([43]);
  });

  it("is stable: the same song makes the same link twice", () => {
    // A link that changed every time it was made could not be recognised, and
    // "did I already send this?" is a question people ask about links.
    const s = {
      name: "Same",
      bpm: 120,
      tonic: 0,
      scale: "major" as const,
      mode: "diatonic" as const,
      progression: "C G",
      preset: "Basic",
      drums: emptyPattern(1),
      bass: bassStackFromPattern(emptyBassPattern(1)),
      lyrics: "",
    };
    expect(encodeSong(s)).toBe(encodeSong(s));
  });

  it("holds up under a link people have mangled", () => {
    const url = songLinkUrl("https://dice.example/#/studio", {
      name: "x",
      bpm: 120,
      tonic: 0,
      scale: "major",
      mode: "diatonic",
      progression: "",
      preset: "Basic",
      drums: emptyPattern(1),
      bass: [],
      lyrics: "",
    });
    const payload = url.split("s=")[1];
    // Chat clients and mail wrap, truncate and append; none of that may throw.
    for (const mangled of [
      payload.slice(0, -3),
      `${payload}…`,
      payload.replace(/./, "!"),
      payload.toUpperCase(),
    ]) {
      expect(() => decodeSong(mangled, PRESET_NAMES)).not.toThrow();
    }
  });
});
