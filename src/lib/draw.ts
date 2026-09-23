// draw.ts - canvas overlay for the hand skeleton.
import type { Landmark } from "./gestures";

// MediaPipe hand connections (pairs of landmark indices).
export const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], // thumb
  [0, 5], [5, 6], [6, 7], [7, 8], // index
  [5, 9], [9, 10], [10, 11], [11, 12], // middle
  [9, 13], [13, 14], [14, 15], [15, 16], // ring
  [13, 17], [17, 18], [18, 19], [19, 20], // pinky
  [0, 17], // palm base
];

export function drawHand(
  ctx: CanvasRenderingContext2D,
  landmarks: Landmark[],
  width: number,
  height: number,
  color: string
): void {
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;

  for (const [a, b] of HAND_CONNECTIONS) {
    const p = landmarks[a];
    const q = landmarks[b];
    ctx.beginPath();
    ctx.moveTo(p.x * width, p.y * height);
    ctx.lineTo(q.x * width, q.y * height);
    ctx.stroke();
  }

  for (const lm of landmarks) {
    ctx.beginPath();
    ctx.arc(lm.x * width, lm.y * height, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * The strings, drawn across the picture, for strum mode.
 *
 * Strumming a chord you cannot see is guesswork: you learn where the strings
 * are by hitting them. Drawing them turns the frame into an instrument you can
 * aim at, and the one nearest your hand is brightened so you can see which one
 * you are about to cross.
 */
export function drawStrings(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  strings: number,
  handY: number | null,
  /** Per-string 0..1: how recently it sounded, for the flash. */
  lit: number[] = [],
  color = "#efaf9f"
): void {
  const n = Math.max(1, Math.floor(strings));
  // The same line positions the strum maths uses: the centre of each band.
  const nearest =
    handY === null ? -1 : Math.round(Math.max(0, Math.min(1, handY)) * n - 0.5);
  ctx.save();
  for (let i = 0; i < n; i += 1) {
    const y = ((i + 0.5) / n) * height;
    const near = i === nearest;
    const hit = Math.max(0, Math.min(1, lit[i] ?? 0));
    ctx.beginPath();
    // A string that just sounded goes white-hot and fades back to the palette.
    ctx.strokeStyle = hit > 0 ? "#f5f2ed" : color;
    ctx.globalAlpha = Math.max(near ? 0.85 : 0.28, hit);
    // Lower strings are drawn heavier, the way a wound string looks thicker.
    ctx.lineWidth = (near ? 2.5 : 1.5) + ((n - i) / n) * 1.5 + hit * 3;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();
}
