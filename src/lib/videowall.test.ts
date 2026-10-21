import { describe, expect, it } from "vitest";
import {
  MAX_TAKES,
  cellRects,
  coverSource,
  takeLabel,
  visibleTakes,
  wallDurationMs,
  wallGrid,
  type VideoTake,
  importedLabel,
  looksPlayable,
  takeLevel,
} from "./videowall";

const take = (over: Partial<VideoTake> = {}): VideoTake => ({
  id: 1,
  url: "blob:x",
  blob: new Blob(),
  label: "take",
  durationMs: 1000,
  ...over,
});

describe("wallGrid", () => {
  it("puts two takes side by side, not stacked", () => {
    // A webcam frame is landscape; stacking two leaves a tall thin wall.
    expect(wallGrid(2)).toEqual({ cols: 2, rows: 1 });
  });

  it("grows to a square-ish grid", () => {
    expect(wallGrid(1)).toEqual({ cols: 1, rows: 1 });
    expect(wallGrid(3)).toEqual({ cols: 2, rows: 2 });
    expect(wallGrid(4)).toEqual({ cols: 2, rows: 2 });
    expect(wallGrid(6)).toEqual({ cols: 3, rows: 2 });
    expect(wallGrid(9)).toEqual({ cols: 3, rows: 3 });
  });

  it("never lays out more than it can hold", () => {
    expect(wallGrid(50)).toEqual(wallGrid(MAX_TAKES));
  });

  it("is empty for nothing", () => {
    expect(wallGrid(0)).toEqual({ cols: 0, rows: 0 });
    expect(wallGrid(-3)).toEqual({ cols: 0, rows: 0 });
  });

  it("always has room for every take", () => {
    for (let n = 1; n <= MAX_TAKES; n += 1) {
      const { cols, rows } = wallGrid(n);
      expect(cols * rows).toBeGreaterThanOrEqual(n);
    }
  });
});

describe("cellRects", () => {
  it("fills the wall with one take", () => {
    expect(cellRects(1, 1280, 720)).toEqual([{ x: 0, y: 0, width: 1280, height: 720 }]);
  });

  it("splits the wall in two, with no gap and no overlap", () => {
    const [a, b] = cellRects(2, 1280, 720);
    expect(a).toEqual({ x: 0, y: 0, width: 640, height: 720 });
    expect(b.x).toBe(640);
    expect(a.width + b.width).toBe(1280);
  });

  it("centres a short last row", () => {
    // Three takes: a row of two, then one centred underneath, not hanging left.
    const rects = cellRects(3, 1200, 800);
    expect(rects[0].x).toBe(0);
    expect(rects[1].x).toBe(600);
    expect(rects[2].x).toBe(300);
    expect(rects[2].x + rects[2].width / 2).toBe(600);
  });

  it("keeps every cell inside the wall", () => {
    for (let n = 1; n <= MAX_TAKES; n += 1) {
      for (const r of cellRects(n, 1280, 720, 8)) {
        expect(r.x).toBeGreaterThanOrEqual(-0.001);
        expect(r.y).toBeGreaterThanOrEqual(-0.001);
        expect(r.x + r.width).toBeLessThanOrEqual(1280.001);
        expect(r.y + r.height).toBeLessThanOrEqual(720.001);
      }
    }
  });

  it("gives every cell the same size", () => {
    const rects = cellRects(6, 1280, 720, 10);
    for (const r of rects) {
      expect(r.width).toBeCloseTo(rects[0].width, 6);
      expect(r.height).toBeCloseTo(rects[0].height, 6);
    }
  });

  it("returns nothing for a wall with no size", () => {
    expect(cellRects(4, 0, 720)).toEqual([]);
    expect(cellRects(0, 1280, 720)).toEqual([]);
  });
});

describe("coverSource", () => {
  it("crops the sides of a frame wider than its cell", () => {
    const src = coverSource(1920, 1080, { x: 0, y: 0, width: 100, height: 100 });
    expect(src.height).toBe(1080);
    expect(src.width).toBe(1080);
    expect(src.x).toBe(420); // centred
  });

  it("crops the top and bottom of a frame taller than its cell", () => {
    const src = coverSource(1080, 1920, { x: 0, y: 0, width: 100, height: 100 });
    expect(src.width).toBe(1080);
    expect(src.height).toBe(1080);
    expect(src.y).toBe(420);
  });

  it("takes the whole frame when the aspects match", () => {
    const src = coverSource(1280, 720, { x: 0, y: 0, width: 640, height: 360 });
    expect(src).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
  });

  it("never crops outside the source", () => {
    for (const [w, h] of [[1920, 1080], [640, 480], [720, 1280]]) {
      const src = coverSource(w, h, { x: 0, y: 0, width: 300, height: 200 });
      expect(src.x).toBeGreaterThanOrEqual(0);
      expect(src.y).toBeGreaterThanOrEqual(0);
      expect(src.x + src.width).toBeLessThanOrEqual(w + 0.001);
      expect(src.y + src.height).toBeLessThanOrEqual(h + 0.001);
    }
  });

  it("survives a zero-sized source", () => {
    expect(() => coverSource(0, 0, { x: 0, y: 0, width: 10, height: 10 })).not.toThrow();
  });
});

describe("the wall's takes", () => {
  it("leaves hidden takes off without deleting them", () => {
    const takes = [take({ id: 1 }), take({ id: 2, hidden: true }), take({ id: 3 })];
    expect(visibleTakes(takes).map((t) => t.id)).toEqual([1, 3]);
  });

  it("shows no more than the wall can hold", () => {
    const many = Array.from({ length: 20 }, (_, i) => take({ id: i }));
    expect(visibleTakes(many)).toHaveLength(MAX_TAKES);
  });

  it("runs as long as its longest take, since they start together", () => {
    expect(wallDurationMs([take({ durationMs: 1000 }), take({ durationMs: 4200 })])).toBe(4200);
  });

  it("reports no duration when nothing is known yet", () => {
    expect(wallDurationMs([])).toBe(0);
    expect(wallDurationMs([take({ durationMs: 0 })])).toBe(0);
  });

  it("ignores hidden takes when measuring", () => {
    expect(
      wallDurationMs([take({ durationMs: 1000 }), take({ durationMs: 9000, hidden: true })])
    ).toBe(1000);
  });
});

describe("takeLabel", () => {
  it("numbers takes from one and says how long they are", () => {
    expect(takeLabel(0, 4230)).toBe("take 1 · 4.2s");
    expect(takeLabel(2, 0)).toBe("take 3");
  });
});

describe("bringing a clip in from a file", () => {
  it("takes anything claiming to be a video, and tries", () => {
    // Browsers disagree about codecs inside containers and canPlayType mostly
    // says "maybe", so the honest test is to play it rather than guess here.
    expect(looksPlayable({ type: "video/mp4", name: "a.mp4" })).toBe(true);
    expect(looksPlayable({ type: "video/quicktime", name: "a.mov" })).toBe(true);
    expect(looksPlayable({ type: "video/x-matroska", name: "a.mkv" })).toBe(true);
  });

  it("turns away what is plainly not a video", () => {
    expect(looksPlayable({ type: "image/png", name: "a.png" })).toBe(false);
    expect(looksPlayable({ type: "audio/mpeg", name: "a.mp3" })).toBe(false);
    expect(looksPlayable({ type: "application/pdf", name: "a.pdf" })).toBe(false);
  });

  it("falls back to the name when the system gives no type", () => {
    expect(looksPlayable({ type: "", name: "holiday.MOV" })).toBe(true);
    expect(looksPlayable({ type: "", name: "notes.txt" })).toBe(false);
    expect(looksPlayable({})).toBe(false);
  });

  it("labels a clip by its own name, shortened from the middle", () => {
    expect(importedLabel("chorus.mp4")).toBe("chorus");
    const long = importedLabel("a-very-long-clip-name-from-my-phone-final-v2.mov");
    expect(long.length).toBeLessThanOrEqual(22);
    expect(long).toMatch(/^a-very/); // the start still says what it is
    expect(long).toMatch(/v2$/); // ...and so does the end
  });

  it("always has something to call a clip", () => {
    expect(importedLabel("")).toBe("clip");
    expect(importedLabel(".mp4")).toBe("clip");
  });
});

describe("balancing the takes", () => {
  it("drops each take as the stack grows, so four do not clip one", () => {
    // Four full-scale vocal takes summed raw is what "the harmonies sound
    // distorted" was: equal-power staging is the fix.
    expect(takeLevel({}, 1)).toBe(1);
    expect(takeLevel({}, 4)).toBeCloseTo(0.5, 5);
    expect(takeLevel({}, 9)).toBeCloseTo(1 / 3, 5);
  });

  it("lets a take's own level ride on top of the staging", () => {
    expect(takeLevel({ level: 0.5 }, 4)).toBeCloseTo(0.25, 5);
    expect(takeLevel({ level: 1 }, 4)).toBeCloseTo(0.5, 5);
  });

  it("silences a muted take whatever its fader says", () => {
    expect(takeLevel({ muted: true, level: 1 }, 1)).toBe(0);
  });

  it("quietens the whole wall when it is only a guide", () => {
    const loud = takeLevel({}, 2, 1);
    const guide = takeLevel({}, 2, 0.55);
    expect(guide).toBeLessThan(loud);
    expect(guide).toBeCloseTo(loud * 0.55, 5);
  });

  it("treats a missing or nonsense level as unity, not as silence", () => {
    expect(takeLevel({}, 1)).toBe(1);
    expect(takeLevel({ level: Number.NaN }, 1)).toBe(1);
    expect(takeLevel({ level: -2 }, 1)).toBe(0);
    expect(takeLevel({ level: 5 }, 1)).toBe(1);
  });
});
