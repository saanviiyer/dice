/** @type {import('tailwindcss').Config} */

// The dice palette (see src/brand.ts for the canonical tokens and the reasoning
// behind the font stack).
//
// The legacy names (yellow / orange / magenta / purple / ink) are kept as
// aliases and re-pointed at dice colours. The studio UI was written against
// those names across several thousand lines of JSX; re-pointing them re-skins
// the whole product in one place instead of rewriting every className, and new
// code uses the dice names directly.
// Each colour is a CSS variable holding channels, not a hex, so the palette can
// be changed at runtime by the colour picker in the studio. The channels form
// is what lets Tailwind keep its alpha modifiers working: `bg-maroon/40`
// compiles to `rgb(var(--dice-maroon) / 0.4)`. The defaults live in index.css
// and the maths that produces another palette lives in src/lib/theme.ts.
const token = (name) => `rgb(var(--dice-${name}) / <alpha-value>)`;

const dice = {
  brick: token("brick"),
  brickDeep: token("brick-deep"),
  maroon: token("maroon"),
  maroonDeep: token("maroon-deep"),
  maroonInk: token("maroon-ink"),
  salmon: token("salmon"),
  salmonDim: token("salmon-dim"),
  bone: token("bone"),
  boneDim: token("bone-dim"),
  chalk: token("chalk"),
  live: token("live"),
};

const display = [
  "'Helvetica Neue'",
  "Inter",
  "'Segoe UI'",
  "Roboto",
  "Helvetica",
  "Arial",
  "sans-serif",
];

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ...dice,
        // Legacy aliases, re-pointed at the dice palette.
        yellow: dice.salmon,
        orange: dice.brick,
        magenta: dice.salmonDim,
        purple: dice.maroon,
        ink: dice.maroonInk,
      },
      fontFamily: {
        sans: display,
        serif: display,
        display,
      },
      letterSpacing: {
        wordmark: "-0.03em",
      },
    },
  },
  plugins: [],
};
