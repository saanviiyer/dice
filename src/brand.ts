// brand.ts - the dice brand identity, in one place.
//
// Taken from the dice key art. The system has two grounds, not one: brick red
// carries the hero pieces and every call to action, and a deep maroon carries
// the content pieces and the whole studio. Salmon is the accent that fills the
// sequencer tiles. Bone is the line-work. Italic is the emphasis device, always
// on the last word of a line, and the wordmark keeps its period.
//
// Type note: the wordmark is set in a heavy system grotesque rather than a
// webfont. The app ships under a strict Content-Security-Policy with no
// font-src for third-party hosts, and the desktop build loads from disk with no
// network at all, so a downloaded face would silently fail in both. The stack
// below resolves to Helvetica Neue on macOS, Segoe UI on Windows, and Inter or
// Roboto on Linux, at weight 800/900.

export const BRAND = {
  name: "dice",
  /** The wordmark always carries the period. */
  wordmark: "dice.",
  tagline: "a hand-gesture instrument and a vocal studio",
  /** The positioning line. */
  positioning: "a garage band in a browser tab.",
  /** One sentence, for the meta description and the desktop about box. */
  blurb:
    "dice is a hand-gesture instrument and a vocal studio. You sing the takes; the producer agent mixes them and shows its working.",
} as const;

/**
 * Brand palette.
 *
 * `brick` is the hero and action colour, `maroon` the ground everything sits
 * on, `salmon` the single accent, `bone` the line-work. `live` is functional
 * rather than brand: it marks record and armed states, where a hot, unmistakable
 * red is the only honest signal and the muted brick would not read as "on".
 */
export const COLORS = {
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
} as const;

/** Font stacks. Display is the wordmark and headline face; text is the rest. */
export const FONTS = {
  display:
    '"Helvetica Neue", "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  text: '"Helvetica Neue", "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
} as const;
