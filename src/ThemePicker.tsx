// ThemePicker.tsx - the colour the studio is in.
//
// dice ships in one red, and the whole interface reads by the ladder that red
// makes: near-black ground, maroon panels, salmon tiles, bone text. A picker
// that painted the background some other colour would break the ladder, so
// what this changes is the hue of the entire palette. See lib/theme.ts for the
// maths and for the contrast floor it holds to.

import { useEffect, useState } from "react";
import {
  BASE_COLOR,
  DEFAULT_PALETTE,
  THEME_STORAGE_KEY,
  applyPalette,
  paletteFor,
} from "./lib/theme";

/** A few places to start, so the picker is not a blank colour well. */
const PRESETS: [string, string][] = [
  [BASE_COLOR, "dice red"],
  ["#1f5f4a", "pine"],
  ["#1e3f7a", "deep blue"],
  ["#4a2a6b", "plum"],
  ["#6b4a12", "amber"],
  ["#3a3a3a", "slate"],
];

function storedColor(): string {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return raw && /^#[0-9a-f]{6}$/i.test(raw) ? raw : BASE_COLOR;
  } catch {
    return BASE_COLOR;
  }
}

/** Put the stored colour on before the first paint anyone cares about. */
export function useStoredTheme(): [string, (next: string) => void] {
  const [color, setColor] = useState<string>(storedColor);

  useEffect(() => {
    applyPalette(paletteFor(color), document.documentElement);
    try {
      if (color === BASE_COLOR) localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, color);
    } catch {
      /* a studio that cannot remember the colour still has the colour */
    }
  }, [color]);

  return [color, setColor];
}

export default function ThemePicker({
  color,
  onColor,
}: {
  color: string;
  onColor(next: string): void;
}) {
  const [open, setOpen] = useState(false);
  const palette = paletteFor(color);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="The colour the studio is in"
        className="flex items-center gap-2 rounded-full border border-salmonDim/35 px-3 py-2 text-sm text-bone/75 transition hover:text-chalk"
      >
        <span
          aria-hidden
          className="h-4 w-4 rounded-full border border-chalk/30"
          style={{ background: palette.brick }}
        />
        colour
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-2 w-60 rounded-2xl border border-salmonDim/30 bg-maroonDeep/95 p-3 shadow-xl">
          <div className="grid grid-cols-6 gap-1.5">
            {PRESETS.map(([hex, name]) => (
              <button
                key={hex}
                type="button"
                onClick={() => onColor(hex)}
                title={name}
                aria-label={name}
                aria-pressed={color.toLowerCase() === hex.toLowerCase()}
                className={`h-7 w-7 rounded-full border transition ${
                  color.toLowerCase() === hex.toLowerCase()
                    ? "border-chalk"
                    : "border-chalk/20 hover:border-chalk/60"
                }`}
                style={{ background: paletteFor(hex).brick }}
              />
            ))}
          </div>

          <label className="mt-3 flex items-center gap-2 text-xs text-bone/70">
            <input
              type="color"
              value={color}
              onChange={(e) => onColor(e.target.value)}
              aria-label="studio colour"
              className="h-8 w-10 cursor-pointer rounded border border-salmonDim/40 bg-transparent"
            />
            any colour
          </label>

          <div className="mt-3 flex gap-1" aria-hidden>
            {(["maroonInk", "maroonDeep", "maroon", "brick", "salmon", "chalk"] as const).map(
              (token) => (
                <span
                  key={token}
                  className="h-5 flex-1 rounded-sm border border-chalk/10"
                  style={{ background: palette[token] }}
                />
              )
            )}
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-bone/50">
            The colour sets the hue of the whole palette. dice stays dark, and
            every ground is held above a readable contrast with the text on it,
            so no colour here can make the studio unreadable.
          </p>

          {color.toLowerCase() !== DEFAULT_PALETTE.maroon.toLowerCase() && (
            <button
              type="button"
              onClick={() => onColor(BASE_COLOR)}
              className="mt-2 text-[11px] text-salmon hover:text-chalk"
            >
              back to dice red
            </button>
          )}
        </div>
      )}
    </div>
  );
}
