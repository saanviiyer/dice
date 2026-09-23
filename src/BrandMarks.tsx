// BrandMarks.tsx - the dice marks, drawn as inline SVG.
//
// The key art is thin bone line-work on a maroon ground with one solid chalk
// die, plus a sequencer grid of brick and salmon tiles. These components reproduce that vocabulary so the marketing page, the
// studio header and the desktop icon are literally the same drawing.

import { BRAND, COLORS } from "./brand";

/** The wordmark: heavy, lowercase, italic, and it keeps its period. */
export function Wordmark({
  className = "",
  as: Tag = "span",
}: {
  className?: string;
  as?: "span" | "h1" | "div";
}) {
  return (
    <Tag className={`dice-wordmark ${className}`} aria-label={BRAND.name}>
      {BRAND.wordmark}
    </Tag>
  );
}

/**
 * The die. Solid chalk faces with dark pips, isometric, showing 1 / 2 / 3 at
 * the near vertex (a real die: adjacent faces, opposite faces summing to 7).
 * Used as the app icon, the favicon and the loading mark.
 */
export function DiceMark({
  size = 48,
  className = "",
  title,
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  const pip = COLORS.maroonInk;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 105"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {/* top face */}
      <path d="M50 8 L90 31 L50 54 L10 31 Z" fill={COLORS.chalk} />
      {/* left face, a touch darker so the cube reads as a solid */}
      <path d="M10 31 L50 54 L50 97 L10 74 Z" fill="#cdc7c0" />
      {/* right face, darker still */}
      <path d="M90 31 L50 54 L50 97 L90 74 Z" fill="#b6afa7" />
      {/* 1 on top */}
      <circle cx="50" cy="31" r="4.4" fill={pip} />
      {/* 2 on the left */}
      <circle cx="22" cy="50.8" r="4" fill={pip} />
      <circle cx="38" cy="77.2" r="4" fill={pip} />
      {/* 3 on the right */}
      <circle cx="80" cy="47.5" r="4" fill={pip} />
      <circle cx="70" cy="64" r="4" fill={pip} />
      <circle cx="60" cy="80.5" r="4" fill={pip} />
    </svg>
  );
}

/**
 * The waveform rule from the key art. `seed` shifts the pseudo-random bar
 * heights so two waveforms on one page do not look copy-pasted; the generator
 * is deterministic so the drawing never flickers between renders.
 */
export function Waveform({
  bars = 96,
  height = 56,
  seed = 1,
  className = "",
}: {
  bars?: number;
  height?: number;
  seed?: number;
  className?: string;
}) {
  const width = bars * 4;
  const mid = height / 2;
  const items = [];
  let s = seed * 9301 + 49297;
  for (let i = 0; i < bars; i += 1) {
    s = (s * 9301 + 49297) % 233280;
    const r = s / 233280;
    // A slow envelope times a fast wobble reads as audio rather than noise.
    const env = 0.35 + 0.65 * Math.abs(Math.sin((i / bars) * Math.PI * 3.1 + seed));
    const h = Math.max(2, env * r * (height - 6));
    items.push(
      <line
        key={i}
        x1={i * 4 + 2}
        y1={mid - h / 2}
        x2={i * 4 + 2}
        y2={mid + h / 2}
      />
    );
  }
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* currentColor, so a waveform takes the colour of whatever band it sits
          in: bone on the maroon ground, a darker brick inside a brick panel. */}
      <g
        stroke="currentColor"
        fill="none"
        strokeWidth={2}
        strokeLinecap="round"
      >
        {items}
      </g>
    </svg>
  );
}

/** Headphones, drawn in the salmon accent as they are in the key art. */
export function Headphones({
  size = 64,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <g
        fill="none"
        stroke={COLORS.salmon}
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M18 62 V50 a32 32 0 0 1 64 0 v12" />
        <rect x="8" y="58" width="20" height="30" rx="9" />
        <rect x="72" y="58" width="20" height="30" rx="9" />
        <path d="M18 74 h4" />
        <path d="M78 74 h4" />
      </g>
    </svg>
  );
}

/** A single eighth note, the key art's punctuation. */
export function Note({
  size = 28,
  className = "",
  color = COLORS.bone,
}: {
  size?: number;
  className?: string;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <g fill="none" stroke={color} strokeWidth="6" strokeLinecap="round">
        <path d="M40 76 V20 c14 4 26 10 26 24" />
        <ellipse cx="28" cy="76" rx="14" ry="11" fill={color} stroke="none" />
      </g>
    </svg>
  );
}

/**
 * The deck: the two-platter controller that anchors the key art. Drawn as one
 * continuous line vocabulary (platters, knob grid, faders, pads) rather than a
 * literal device.
 */
export function Deck({ className = "" }: { className?: string }) {
  const knobs = [];
  for (let col = 0; col < 2; col += 1) {
    for (let row = 0; row < 3; row += 1) {
      const cx = 300 + col * 56;
      const cy = 96 + row * 56;
      knobs.push(
        <g key={`k${col}${row}`}>
          <circle cx={cx} cy={cy} r="20" />
          <path d={`M${cx} ${cy} L${cx} ${cy - 20}`} />
        </g>
      );
    }
  }
  const pads = [];
  for (let i = 0; i < 4; i += 1) {
    pads.push(<rect key={`pl${i}`} x={40 + i * 56} y="300" width="42" height="34" rx="6" />);
    pads.push(<rect key={`pr${i}`} x={420 + i * 56} y="300" width="42" height="34" rx="6" />);
  }
  const platter = (cx: number) => (
    <g>
      <circle cx={cx} cy="170" r="112" />
      <circle cx={cx} cy="170" r="46" />
      <circle cx={cx} cy="170" r="16" />
      <circle cx={cx} cy="170" r="4" />
      {/* tonearm */}
      <path d={`M${cx + 96} 62 a12 12 0 1 1 0.1 0`} />
      <path d={`M${cx + 96} 74 L${cx + 34} 214`} />
      <rect
        x={cx + 14}
        y="206"
        width="30"
        height="22"
        rx="4"
        transform={`rotate(-24 ${cx + 29} ${217})`}
      />
      {/* platter groove */}
      <path d={`M${cx - 74} 128 a92 92 0 0 1 52 -46`} />
    </g>
  );
  return (
    <svg
      viewBox="0 0 660 360"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <g className="dice-line" strokeWidth="5">
        <rect x="6" y="14" width="648" height="336" rx="30" />
        <circle cx="46" cy="52" r="12" />
        {platter(160)}
        {platter(500)}
        {knobs}
        {/* channel faders */}
        <path d="M300 224 v76" />
        <rect x="286" y="246" width="28" height="18" rx="4" />
        <path d="M356 224 v76" />
        <rect x="342" y="262" width="28" height="18" rx="4" />
        {/* crossfader */}
        <path d="M282 320 h92" />
        <rect x="316" y="308" width="20" height="26" rx="4" />
        {/* transport dashes */}
        <path d="M430 46 h22 M466 46 h22 M502 46 h22 M538 46 h22" />
        {pads}
      </g>
    </svg>
  );
}

/**
 * The sequencer grid from the key art: rows of rounded tiles, some lit in brick
 * and some in salmon. It is the drum grid the studio actually has, drawn as a
 * brand element, so the marketing page and the product are showing the same
 * object.
 *
 * The pattern is a real one rather than random: a four-on-the-floor kick with
 * offbeat hats, which is what the tiles would mean if you pressed play.
 */
export function SequencerGrid({
  rows = 4,
  cols = 16,
  className = "",
}: {
  rows?: number;
  cols?: number;
  className?: string;
}) {
  const cell = 34;
  const gap = 5;
  const w = cols * (cell + gap) - gap;
  const h = rows * (cell + gap) - gap;

  // row 0 kick, row 1 clap, row 2 hats, row 3 bass.
  const hits = [
    (c: number) => c % 4 === 0,
    (c: number) => c % 8 === 4,
    (c: number) => c % 2 === 1,
    (c: number) => c % 4 === 0 || c % 8 === 6,
  ];

  const tiles = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const on = (hits[r % hits.length] ?? (() => false))(c);
      tiles.push(
        <rect
          key={`${r}-${c}`}
          x={c * (cell + gap)}
          y={r * (cell + gap)}
          width={cell}
          height={cell}
          rx={7}
          fill={on ? COLORS.brick : COLORS.salmon}
        />
      );
    }
  }

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className={className}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      {tiles}
    </svg>
  );
}

/**
 * A staff with a scattering of notes on it, the motif behind "bring your music
 * to life". Decorative: the notes do not spell a tune, they set a texture, so
 * it is drawn faintly and never carries meaning.
 */
export function Stave({
  className = "",
  lines = 5,
  seed = 5,
}: {
  className?: string;
  lines?: number;
  seed?: number;
}) {
  const w = 620;
  const gap = 13;
  const staves = [0, 1, 2, 3];
  const rows: React.ReactNode[] = [];
  let s = seed * 7919 + 104729;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };

  staves.forEach((_block, bi) => {
    const top = 20 + bi * (lines * gap + 46);
    for (let i = 0; i < lines; i += 1) {
      rows.push(
        <line key={`l${bi}-${i}`} x1={0} y1={top + i * gap} x2={w} y2={top + i * gap} />
      );
    }
    for (let n = 0; n < 11; n += 1) {
      const x = 34 + n * 52 + rand() * 14;
      const step = Math.floor(rand() * (lines * 2 - 1));
      const cy = top + (step * gap) / 2;
      rows.push(
        <g key={`n${bi}-${n}`}>
          <ellipse cx={x} cy={cy} rx={6.5} ry={5} fill="currentColor" stroke="none" />
          <line x1={x + 6} y1={cy} x2={x + 6} y2={cy - 26} />
        </g>
      );
    }
  });

  return (
    <svg
      viewBox={`0 0 ${w} ${staves.length * (lines * gap + 46)}`}
      className={className}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <g stroke="currentColor" strokeWidth={1.4} fill="none">
        {rows}
      </g>
    </svg>
  );
}
