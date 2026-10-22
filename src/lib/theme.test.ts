import { describe, expect, it } from "vitest";
import {
  BASE_COLOR,
  DEFAULT_PALETTE,
  THEME_TOKENS,
  applyPalette,
  contrastRatio,
  cssVarName,
  hexToHsl,
  hexToRgb,
  hslToRgb,
  paletteFor,
  rgbToHex,
  rgbToHsl,
  themeColor,
} from "./theme";

describe("colour conversion", () => {
  it("round-trips a colour through HSL", () => {
    for (const hex of Object.values(DEFAULT_PALETTE)) {
      expect(rgbToHex(hslToRgb(hexToHsl(hex)!))).toBe(hex.toLowerCase());
    }
  });

  it("reads both hex lengths and refuses anything else", () => {
    expect(hexToRgb("#fff")).toEqual([255, 255, 255]);
    expect(hexToRgb("5e2318")).toEqual([94, 35, 24]);
    expect(hexToRgb("#bb3a20")).toEqual([187, 58, 32]);
    expect(hexToRgb("red")).toBeNull();
    expect(hexToRgb("#12345")).toBeNull();
    expect(hexToRgb("")).toBeNull();
  });

  it("knows a grey has no hue", () => {
    const grey = rgbToHsl([128, 128, 128]);
    expect(grey.s).toBe(0);
    expect(grey.l).toBeCloseTo(0.5, 2);
  });
});

describe("picking a colour", () => {
  it("leaves the palette alone when the base colour is picked", () => {
    const same = paletteFor(BASE_COLOR);
    for (const token of THEME_TOKENS) {
      expect(contrastRatio(same[token], DEFAULT_PALETTE[token])).toBeCloseTo(1, 1);
    }
  });

  it("moves every token to the picked hue", () => {
    // A green pick has to green the whole ladder, not just the background.
    const green = paletteFor("#1f7a3a");
    const hue = hexToHsl("#1f7a3a")!.h;
    for (const token of ["maroonDeep", "maroon", "brick", "salmon"] as const) {
      const got = hexToHsl(green[token])!;
      const apart = Math.abs(((got.h - hue + 540) % 360) - 180);
      expect(apart).toBeLessThan(25); // within a shade of the pick
    }
  });

  it("keeps the ladder: a ground stays darker than the ink above it", () => {
    for (const pick of ["#1f7a3a", "#2b4cc8", "#c8b02b", "#7a1f6e", "#5e2318"]) {
      const p = paletteFor(pick);
      expect(hexToHsl(p.maroonInk)!.l).toBeLessThan(hexToHsl(p.maroonDeep)!.l);
      expect(hexToHsl(p.maroonDeep)!.l).toBeLessThan(hexToHsl(p.maroon)!.l);
      expect(hexToHsl(p.maroon)!.l).toBeLessThan(hexToHsl(p.salmon)!.l);
      expect(hexToHsl(p.salmon)!.l).toBeLessThan(hexToHsl(p.chalk)!.l);
    }
  });

  it("keeps text readable whatever colour is picked", () => {
    // The floor the whole feature rests on. Rotating the hue while keeping HSL
    // lightness does not hold it: a yellow ground at the maroon's lightness is
    // far brighter than the maroon, and measured 2.5 to 1 where the shipped
    // red measures 7.9. The palette matches luminance instead, and darkens any
    // ground that would still come out too light.
    for (let hue = 0; hue < 360; hue += 15) {
      for (const lightness of [0.1, 0.25, 0.5, 0.75, 0.95]) {
        const pick = rgbToHex(hslToRgb({ h: hue, s: 0.8, l: lightness }));
        const p = paletteFor(pick);
        expect(contrastRatio(p.chalk, p.maroonDeep)).toBeGreaterThan(4.5);
        expect(contrastRatio(p.chalk, p.maroonInk)).toBeGreaterThan(4.5);
        expect(contrastRatio(p.bone, p.maroon)).toBeGreaterThan(4.5);
      }
    }
  });

  it("will not turn the studio white when white is picked", () => {
    // Lightness is clamped, so the lightest pick gives the lightest studio
    // that can still be read.
    const light = paletteFor("#ffffff");
    expect(hexToHsl(light.maroonDeep)!.l).toBeLessThan(0.35);
    expect(contrastRatio(light.chalk, light.maroonDeep)).toBeGreaterThan(4.5);
  });

  it("gives a grey studio for a grey pick", () => {
    const grey = paletteFor("#808080");
    for (const token of ["maroon", "maroonDeep", "brick"] as const) {
      expect(hexToHsl(grey[token])!.s).toBeCloseTo(0, 2);
    }
  });

  it("falls back to the shipped palette for a colour it cannot read", () => {
    expect(paletteFor("not a colour")).toEqual(DEFAULT_PALETTE);
  });
});

describe("publishing a palette", () => {
  it("writes channels, which is what the alpha modifiers need", () => {
    const written: Record<string, string> = {};
    applyPalette(paletteFor(BASE_COLOR), {
      style: { setProperty: (name, value) => void (written[name] = value) },
    });
    expect(written["--dice-maroon"]).toBe("94 35 24");
    expect(written["--dice-maroon-deep"]).toBe("61 22 16");
    expect(Object.keys(written)).toHaveLength(THEME_TOKENS.length);
  });

  it("names a camel-cased token the way CSS spells it", () => {
    expect(cssVarName("maroonDeep")).toBe("--dice-maroon-deep");
    expect(cssVarName("brick")).toBe("--dice-brick");
  });

  it("reads a colour back for canvas drawing, and copes when it cannot", () => {
    const root = { getPropertyValue: (n: string) => (n === "--dice-salmon" ? "10 20 30" : "") };
    expect(themeColor("salmon", root)).toBe("#0a141e");
    expect(themeColor("bone", root)).toBe(DEFAULT_PALETTE.bone);
    expect(themeColor("bone")).toBe(DEFAULT_PALETTE.bone);
    expect(themeColor("salmon", { getPropertyValue: () => "junk" })).toBe(
      DEFAULT_PALETTE.salmon
    );
  });
});
