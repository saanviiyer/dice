// StrumPad.tsx - hold a chord on the number keys, strum it on the trackpad.
//
// Chords on 1-7, strum by sweeping the strip. The timing between the notes is
// your gesture rather than a "strum speed" setting, which is the whole point:
// flick it and it snaps, drag it and it arpeggiates, stop halfway and only the
// strings you crossed sound. Sweep back the other way for an upstroke.
//
// The gesture maths is in lib/strum.ts; this file is the surface and the
// scheduling.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildChord,
  midiToFreq,
  midiToName,
  scaleDegreeCount,
  type ChordExtension,
  type KeyConfig,
} from "./lib/music";
import { strum, stringVoicing, strumDirection } from "./lib/strum";

const STRINGS = 6;
const DEGREE_KEYS = ["1", "2", "3", "4", "5", "6", "7"];

export interface StrumPadProps {
  keyConfig: KeyConfig;
  extension: ChordExtension;
  /** Play one note now-ish. Null before sound is enabled. */
  playNote: ((freq: number, atSeconds: number, gate: number, velocity: number) => void) | null;
  /** Audio clock, for scheduling a sweep's notes at their own offsets. */
  now: () => number;
}

export default function StrumPad({ keyConfig, extension, playNote, now }: StrumPadProps) {
  const degreeCount = scaleDegreeCount(keyConfig.scale);
  const [degree, setDegree] = useState(0);
  const [ring, setRing] = useState<Record<number, number>>({});
  const [stroke, setStroke] = useState<"down" | "up" | "none">("none");

  const chord = useMemo(
    () => buildChord(keyConfig, degree, extension),
    [keyConfig, degree, extension]
  );
  const voicing = useMemo(() => stringVoicing(chord.notes, STRINGS), [chord]);

  // The gesture's last position and time, read by handlers that must not go
  // stale between renders.
  const gesture = useRef<{ pos: number; time: number; down: boolean }>({
    pos: 0,
    time: 0,
    down: false,
  });
  const live = useRef({ chord, playNote, now });
  live.current = { chord, playNote, now };

  const flash = useCallback((stringIndex: number) => {
    setRing((prev) => ({ ...prev, [stringIndex]: (prev[stringIndex] ?? 0) + 1 }));
    window.setTimeout(
      () =>
        setRing((prev) => ({
          ...prev,
          [stringIndex]: Math.max(0, (prev[stringIndex] ?? 1) - 1),
        })),
      160
    );
  }, []);

  /** Sweep from the last position to `pos`, sounding whatever it crosses. */
  const sweep = useCallback(
    (pos: number, seconds?: number) => {
      const l = live.current;
      const g = gesture.current;
      const t = performance.now();
      const elapsed = seconds ?? Math.max(0, (t - g.time) / 1000);
      const from = g.pos;
      g.pos = pos;
      g.time = t;

      const notes = strum({ chord: l.chord.notes, strings: STRINGS, from, to: pos, seconds: elapsed });
      if (notes.length === 0) return;
      setStroke(strumDirection(from, pos));

      const base = l.now();
      const order = stringVoicing(l.chord.notes, STRINGS);
      for (const n of notes) {
        l.playNote?.(midiToFreq(n.midi), base + n.at, 1.6, n.velocity);
        const idx = order.indexOf(n.midi);
        if (idx >= 0) window.setTimeout(() => flash(idx), n.at * 1000);
      }
    },
    [flash]
  );

  // Chords on the number keys, the way laurie does it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT"
      ) {
        return;
      }
      const i = DEGREE_KEYS.indexOf(event.key);
      if (i < 0 || i >= degreeCount) return;
      event.preventDefault();
      setDegree(i);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [degreeCount]);

  const posFromEvent = (el: HTMLElement, clientY: number) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientY - r.top) / r.height));
  };

  return (
    <section className="rounded-2xl border border-salmonDim/30 bg-maroon/40 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-bone/80">
          strum
        </h2>
        <span className="text-xs text-bone/45">
          {chord.name}
          {stroke !== "none" && <span className="ml-2 text-salmon">{stroke}stroke</span>}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: Math.min(degreeCount, DEGREE_KEYS.length) }, (_, i) => {
          const c = buildChord(keyConfig, i, extension);
          return (
            <button
              key={i}
              type="button"
              onClick={() => setDegree(i)}
              aria-pressed={degree === i}
              title={c.name}
              className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                degree === i
                  ? "bg-bone text-maroonInk"
                  : "bg-maroonDeep/60 text-bone/75 hover:bg-maroonDeep"
              }`}
            >
              <span className="mr-1 opacity-60">{DEGREE_KEYS[i]}</span>
              {c.label}
            </button>
          );
        })}
      </div>

      {/* The strings. Sweep across them. */}
      <div
        role="application"
        aria-label="strum the chord"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const pos = posFromEvent(e.currentTarget, e.clientY);
          gesture.current = { pos, time: performance.now(), down: true };
        }}
        onPointerMove={(e) => {
          if (!gesture.current.down) return;
          sweep(posFromEvent(e.currentTarget, e.clientY));
        }}
        onPointerUp={() => {
          gesture.current.down = false;
          setStroke("none");
        }}
        onPointerLeave={() => {
          gesture.current.down = false;
        }}
        onWheel={(e) => {
          // Two-finger scroll is the trackpad strum. A wheel event is a jump
          // with no duration of its own, so the sweep spreads it just enough to
          // read as a strum rather than a block chord.
          const step = Math.max(-1, Math.min(1, e.deltaY / 120)) * 0.5;
          const next = Math.max(0, Math.min(1, gesture.current.pos + step));
          if (next === gesture.current.pos) {
            gesture.current.pos = step > 0 ? 0 : 1;
          }
          sweep(next, 0.05);
        }}
        className="mt-3 flex touch-none cursor-ns-resize select-none flex-col justify-between rounded-xl border border-salmonDim/30 bg-maroonInk/40 py-3"
        style={{ height: 132 }}
      >
        {voicing.map((midi, i) => {
          const lit = (ring[i] ?? 0) > 0;
          return (
            <div key={i} className="flex items-center gap-2 px-3">
              <span className="w-8 shrink-0 text-[10px] tabular-nums text-bone/40">
                {midiToName(midi)}
              </span>
              <span
                className={`h-[2px] flex-1 rounded-full transition-all ${
                  lit ? "bg-salmon" : "bg-bone/25"
                }`}
                style={lit ? { height: 3, boxShadow: "0 0 8px rgba(239,175,159,0.7)" } : undefined}
              />
            </div>
          );
        })}
      </div>

      <p className="mt-2 text-xs leading-relaxed text-bone/50">
        {playNote
          ? "Pick a chord with 1-7, then drag or two-finger scroll across the strings. Sweep back for an upstroke; how fast you move is how hard it hits."
          : "Turn on camera and sound, then pick a chord with 1-7 and sweep across the strings."}
      </p>
    </section>
  );
}
