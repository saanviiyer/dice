// theme.ts - the palette, at runtime.
//
// dice is built on one red. The whole palette is that red at different
// lightnesses, from the near-black the studio sits on to the salmon that fills
// the sequencer tiles, and every contrast in the interface comes from that
// ladder. So a colour picker cannot simply paint the background: swapping one
// colour out of a ladder breaks the ladder.
//
// What the picker changes is the hue of the whole palette, and how saturated it
// is. Every token keeps the lightness it had, so text that was readable before
// is readable after, whatever colour is chosen. A test holds the contrast floor
// across the hue circle.
//
// Lightness is allowed to move a little, because "a bit lighter" is a thing
// people want from a colour picker, but only within a band that keeps the ink
// above the floor. Picking white does not make a white studio. It makes the
// lightest studio that can still be read.

export const THEME_TOKENS = [
  "brick",
  "brickDeep",
  "maroon",
  "maroonDeep",
  "maroonInk",
  "salmon",
  "salmonDim",
  "bone",
  "boneDim",
  "chalk",
  "live",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

/** The palette as shipped. Every other theme is this one, rotated. */
export const DEFAULT_PALETTE: Record<ThemeToken, string> = {
  brick: "#bb3a20",
  brickDeep: "#932c17",
  maroon: "#5e2318",
  maroonDeep: "#3d1610",
  maroonInk: "#260c06",
  salmon: "#efaf9f",
  salmonDim: "#cf8f7e",
  bone: "#d5d0cb",
  boneDim: "#a99f97",
  chalk: "#f5f2ed",
  live: "#ff5a3d",
};

/** The colour the ladder is built around: what the picker starts on. */
export const BASE_COLOR = DEFAULT_PALETTE.maroon;

/** The grounds. Only these may be lifted or dropped in brightness. */
const GROUNDS: ThemeToken[] = ["brick", "brickDeep", "maroon", "maroonDeep", "maroonInk"];

/**
 * The grounds that body text sits on, which carry the contrast floor.
 *
 * Brick is left out on purpose. It is the hero and button colour, it carries
 * display type rather than paragraphs, and bone on brick measures 3.7 to 1 in
 * the palette as shipped. Holding brick to a reading floor would mean the
 * picker quietly redesigning dice, which is not what a colour picker is for.
 */
const READING_GROUNDS: ThemeToken[] = ["maroon", "maroonDeep", "maroonInk"];

/**
 * How far a pick may move the grounds.
 *
 * Asymmetric because the floor matters more than the ceiling. Going darker is
 * always safe for light text, so it is given more room than going lighter.
 */
const LIFT_MAX = 0.07;
const DROP_MAX = 0.12;

export const THEME_STORAGE_KEY = "dice.theme.v1";

export interface Hsl {
  /** 0..360 */
  h: number;
  /** 0..1 */
  s: number;
  /** 0..1 */
  l: number;
}

export type Rgb = [number, number, number];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Read "#rgb" or "#rrggbb". Returns null for anything else. */
export function hexToRgb(hex: string): Rgb | null {
  const clean = (hex ?? "").trim().replace(/^#/, "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

export function rgbToHex([r, g, b]: Rgb): string {
  const part = (v: number) =>
    clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function rgbToHsl([r, g, b]: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 1);
  const lig = clamp(l, 0, 1);
  if (sat === 0) {
    const v = Math.round(lig * 255);
    return [v, v, v];
  }
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  const channel = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const hk = hue / 360;
  return [
    Math.round(channel(hk + 1 / 3) * 255),
    Math.round(channel(hk) * 255),
    Math.round(channel(hk - 1 / 3) * 255),
  ];
}

export function hexToHsl(hex: string): Hsl | null {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHsl(rgb) : null;
}

/** Relative luminance: how bright a colour actually looks. */
function luminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

const ratio = (a: number, b: number) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * The colour at this hue and saturation that is as bright as `target`.
 *
 * HSL lightness is not brightness. A yellow at lightness 0.23 is far brighter
 * than a red at lightness 0.23, so rotating the hue and keeping the lightness
 * quietly destroys every contrast in the palette: a yellow theme built that way
 * measured 2.5 to 1 where the red measured 7.9. Luminance is monotonic in
 * lightness for a fixed hue, so a short binary search finds the lightness that
 * matches the brightness the token had.
 */
function atLuminance(target: number, h: number, s: number): Rgb {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (luminance(hslToRgb({ h, s, l: mid })) < target) lo = mid;
    else hi = mid;
  }
  return hslToRgb({ h, s, l: (lo + hi) / 2 });
}

/**
 * The whole palette, in the colour someone picked.
 *
 * The hue is taken from the pick and applied to every token. Saturation is
 * scaled by how saturated the pick is against the original red, so a grey pick
 * gives a grey studio and a vivid one gives a vivid studio. Lightness is kept,
 * apart from a clamped lift or drop on the grounds, so the ladder the interface
 * reads by survives the change.
 */
export function paletteFor(pickHex: string): Record<ThemeToken, string> {
  const pick = hexToHsl(pickHex);
  const base = hexToHsl(BASE_COLOR);
  if (!pick || !base) return { ...DEFAULT_PALETTE };

  const hueShift = pick.h - base.h;
  const satScale = base.s > 0 ? pick.s / base.s : 1;
  // How much lighter or darker the pick asks the grounds to be, as a share of
  // the brightness they had. Clamped, because the floor below has to be able
  // to hold whatever is asked for here.
  const lift = 1 + clamp(pick.l - base.l, -DROP_MAX, LIFT_MAX) * 4;

  const out = {} as Record<ThemeToken, string>;
  const rgb = {} as Record<ThemeToken, Rgb>;
  for (const token of THEME_TOKENS) {
    const hsl = hexToHsl(DEFAULT_PALETTE[token]);
    if (!hsl) {
      out[token] = DEFAULT_PALETTE[token];
      rgb[token] = hexToRgb(DEFAULT_PALETTE[token]) ?? [0, 0, 0];
      continue;
    }
    // A pure grey pick has no hue to give, so the palette keeps its own and
    // loses its colour through the saturation scale instead.
    const h = pick.s === 0 ? hsl.h : hsl.h + hueShift;
    const s = clamp(hsl.s * satScale, 0, 1);
    const was = luminance(hexToRgb(DEFAULT_PALETTE[token]) ?? [0, 0, 0]);
    const want = GROUNDS.includes(token) ? clamp(was * lift, 0, 0.35) : was;
    rgb[token] = atLuminance(want, h, s);
  }

  // The floor, enforced rather than hoped for: every ground is darkened until
  // the ink on it clears 4.5 to 1. A lighter pick lightens the studio up to
  // the point where it would stop being readable, and no further.
  const inkLum = Math.min(luminance(rgb.chalk), luminance(rgb.bone));
  const ceiling = (inkLum + 0.05) / MIN_CONTRAST - 0.05;
  for (const token of READING_GROUNDS) {
    if (luminance(rgb[token]) <= ceiling) continue;
    const hsl = rgbToHsl(rgb[token]);
    rgb[token] = atLuminance(Math.max(0, ceiling), hsl.h, hsl.s);
  }

  for (const token of THEME_TOKENS) out[token] = rgbToHex(rgb[token]);
  return out;
}

/** What the ink has to clear against any ground. */
const MIN_CONTRAST = 4.6;

/** The CSS custom property a token is published under. */
export function cssVarName(token: ThemeToken): string {
  return `--dice-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * Publish a palette as CSS variables.
 *
 * The values are space-separated channels, not hex, because Tailwind composes
 * them with its own alpha modifiers: `bg-maroon/40` becomes
 * `rgb(var(--dice-maroon) / 0.4)`, which only works on channels.
 */
export function applyPalette(
  palette: Record<ThemeToken, string>,
  root: { style: { setProperty(name: string, value: string): void } }
): void {
  for (const token of THEME_TOKENS) {
    const rgb = hexToRgb(palette[token]);
    if (!rgb) continue;
    root.style.setProperty(cssVarName(token), rgb.join(" "));
  }
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrastRatio(aHex: string, bHex: string): number {
  const a = hexToRgb(aHex);
  const b = hexToRgb(bHex);
  if (!a || !b) return 1;
  return ratio(luminance(a), luminance(b));
}

/** A colour read back out of the published variables, for canvas drawing. */
export function themeColor(
  token: ThemeToken,
  root?: { getPropertyValue(name: string): string }
): string {
  const fallback = DEFAULT_PALETTE[token];
  if (!root) return fallback;
  const raw = root.getPropertyValue(cssVarName(token)).trim();
  if (!raw) return fallback;
  const channels = raw.split(/[\s,]+/).map(Number);
  if (channels.length < 3 || channels.some((c) => !Number.isFinite(c))) return fallback;
  return rgbToHex([channels[0], channels[1], channels[2]]);
}
