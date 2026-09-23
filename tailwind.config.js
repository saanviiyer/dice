/** @type {import('tailwindcss').Config} */

// The dice palette (see src/brand.ts for the canonical tokens and the reasoning
// behind the font stack).
//
// The legacy names (yellow / orange / magenta / purple / ink) are kept as
// aliases and re-pointed at dice colours. The studio UI was written against
// those names across several thousand lines of JSX; re-pointing them re-skins
// the whole product in one place instead of rewriting every className, and new
// code uses the dice names directly.
const dice = {
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
