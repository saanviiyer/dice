// PadDeck.tsx - play the kit with the keyboard, or type the beat out.
//
// Two ways at the same grid, because they suit different moments. Pads are for
// when you can feel the groove and want to play it; the text editor is for when
// you know exactly what you want and typing it is faster than clicking sixteen
// cells. Both write the custom pattern the step sequencer already owns, so
// whatever comes out is editable, undoable and saved by paths that exist.
//
// Recording is quantised against the running drum machine's own playhead, so a
// hit lands on the step you heard, not the step the scheduler is a hundred
// milliseconds ahead on.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PADS,
  RESOLUTIONS,
  padForKey,
  quantizeStep,
  velocityFor,
  withHit,
  type Pad,
} from "./lib/padkit";
import { EXAMPLE_BEAT, formatBeat, parseBeat } from "./lib/beatnotation";
import {
  MAX_PATTERN_BARS,
  STEPS_PER_BAR,
  emptyPattern,
  setPatternBars,
  type DrumInstrument,
  type DrumPattern,
} from "./lib/drums";

export interface PadDeckProps {
  /** The pattern being built. Owned by the parent so the sequencer shares it. */
  pattern: DrumPattern;
  onChange(next: DrumPattern): void;
  /** Fire a drum voice now. Null before sound is enabled. */
  trigger: ((voice: DrumInstrument, velocity: number) => void) | null;
  /** Fractional step the transport is on, or -1 when stopped. */
  getPosition(): number;
  /** True while the drum machine is running. */
  running: boolean;
  bpm: number;
}

type Mode = "pads" | "type";

export default function PadDeck({
  pattern,
  onChange,
  trigger,
  getPosition,
  running,
  bpm,
}: PadDeckProps) {
  const [mode, setMode] = useState<Mode>("pads");
  const [armed, setArmed] = useState(false);
  const [resolution, setResolution] = useState(1);
  const [lit, setLit] = useState<Record<string, number>>({});
  const [accented, setAccented] = useState<Record<string, number>>({});
  const [shift, setShift] = useState(false);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);

  // Read by the key handler, which is installed once and must not go stale.
  const live = useRef({ pattern, armed, resolution, trigger, getPosition, onChange });
  live.current = { pattern, armed, resolution, trigger, getPosition, onChange };

  const bars = Math.max(1, Math.round(pattern.kick.length / STEPS_PER_BAR));

  const hit = useCallback((pad: Pad, accent = false) => {
    const l = live.current;
    const velocity = velocityFor(accent);
    l.trigger?.(pad.voice, velocity);
    setLit((prev) => ({ ...prev, [pad.key]: (prev[pad.key] ?? 0) + 1 }));
    if (accent) {
      setAccented((prev) => ({ ...prev, [pad.key]: (prev[pad.key] ?? 0) + 1 }));
      window.setTimeout(
        () =>
          setAccented((prev) => ({
            ...prev,
            [pad.key]: Math.max(0, (prev[pad.key] ?? 1) - 1),
          })),
        130
      );
    }
    window.setTimeout(
      () => setLit((prev) => ({ ...prev, [pad.key]: Math.max(0, (prev[pad.key] ?? 1) - 1) })),
      130
    );

    if (!l.armed) return;
    const position = l.getPosition();
    if (position < 0) return;
    const step = quantizeStep(position, l.pattern.kick.length, l.resolution);
    l.onChange(withHit(l.pattern, pad.voice, step, velocity));
  }, []);

  // Pads listen globally so you can play while looking at the timeline, but
  // never while you are typing into something.
  useEffect(() => {
    if (mode !== "pads") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT"
      ) {
        return;
      }
      const pad = padForKey(event.key);
      if (!pad) return;
      event.preventDefault();
      // Stop the studio's own shortcut handler seeing this keystroke too.
      event.stopPropagation();
      hit(pad, event.shiftKey);
    };
    // Shift on its own is tracked so the pads can show they are armed for an
    // accent before you hit anything.
    const onShift = (event: KeyboardEvent) => setShift(event.shiftKey);
    // Losing focus mid-chord would otherwise leave the accent stuck on.
    const clearShift = () => setShift(false);

    // Capture phase, so the deck claims its keys before the window-level
    // transport shortcuts run.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keydown", onShift);
    window.addEventListener("keyup", onShift);
    window.addEventListener("blur", clearShift);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keydown", onShift);
      window.removeEventListener("keyup", onShift);
      window.removeEventListener("blur", clearShift);
    };
  }, [mode, hit]);

  // The editor is seeded from the pattern, and reseeded whenever the pattern
  // changes underneath it, unless you have started typing.
  useEffect(() => {
    if (mode !== "type" || dirty) return;
    setText(formatBeat(pattern) || EXAMPLE_BEAT);
  }, [mode, pattern, dirty]);

  const parsed = useMemo(() => (mode === "type" ? parseBeat(text) : null), [mode, text]);

  const applyTyped = useCallback(() => {
    if (!parsed?.pattern) return;
    onChange(parsed.pattern);
    setDirty(false);
  }, [parsed, onChange]);

  const setBars = useCallback(
    (n: number) => onChange(setPatternBars(pattern, n)),
    [onChange, pattern]
  );

  return (
    <section className="rounded-2xl border border-salmonDim/30 bg-maroon/40 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-bone/80">
          the deck
        </h2>
        <div
          className="inline-flex rounded-full border border-salmonDim/35 bg-maroonDeep/50 p-0.5"
          role="tablist"
          aria-label="deck mode"
        >
          {(
            [
              ["pads", "pads"],
              ["type", "type"],
            ] as [Mode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                mode === m ? "bg-bone text-maroonInk" : "text-bone/70 hover:bg-maroonDeep"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {mode === "pads" ? (
        <>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {PADS.map((pad) => {
              const on = (lit[pad.key] ?? 0) > 0;
              const hard = (accented[pad.key] ?? 0) > 0;
              return (
                <button
                  key={pad.key}
                  type="button"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    hit(pad, e.shiftKey);
                  }}
                  className={`flex aspect-square flex-col items-center justify-center rounded-xl border transition ${
                    on
                      ? hard
                        ? "border-chalk bg-salmon text-maroonInk"
                        : "border-salmon bg-brick text-chalk"
                      : shift
                        ? "border-salmon/60 bg-maroonDeep/60 text-bone/80 hover:bg-maroonDeep"
                        : "border-salmonDim/30 bg-maroonDeep/60 text-bone/80 hover:bg-maroonDeep"
                  }`}
                >
                  <span className="text-lg font-bold">{pad.label}</span>
                  <span className="text-[10px] uppercase tracking-wide opacity-70">
                    {pad.voice}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setArmed((a) => !a)}
              aria-pressed={armed}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                armed ? "bg-live text-chalk" : "bg-bone text-maroonInk hover:bg-chalk"
              }`}
            >
              {armed ? "recording" : "record in"}
            </button>

            <label className="flex items-center gap-1.5 text-xs text-bone/60">
              snap
              <select
                value={resolution}
                onChange={(e) => setResolution(Number(e.target.value))}
                className="rounded-lg border border-salmonDim/40 bg-maroonDeep/60 px-2 py-1 text-xs"
              >
                {RESOLUTIONS.map((r) => (
                  <option key={r.steps} value={r.steps}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-1.5 text-xs text-bone/60">
              bars
              <select
                value={bars}
                onChange={(e) => setBars(Number(e.target.value))}
                className="rounded-lg border border-salmonDim/40 bg-maroonDeep/60 px-2 py-1 text-xs"
              >
                {Array.from({ length: MAX_PATTERN_BARS }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              onClick={() => onChange(emptyPattern(bars))}
              className="ml-auto rounded-lg px-2.5 py-1.5 text-xs text-salmon transition hover:bg-salmon/15"
            >
              clear
            </button>
          </div>

          <p className="mt-2 text-xs text-bone/50">
            {armed
              ? running
                ? `Playing in at ${Math.round(bpm)} BPM. Hits land on the nearest ${
                    RESOLUTIONS.find((r) => r.steps === resolution)?.label
                  }.`
                : "Start the beat and the hits will land on the grid. Until then the pads just play."
              : "Hit the keys to play the kit. Hold shift for an accent. Turn on record in to write what you play into the grid."}
          </p>
        </>
      ) : (
        <>
          <textarea
            value={text}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
            }}
            rows={7}
            placeholder={EXAMPLE_BEAT}
            className="w-full resize-y rounded-xl border border-salmonDim/40 bg-maroonInk/50 p-3 font-mono text-xs leading-relaxed text-chalk placeholder:text-bone/30"
          />

          {parsed && parsed.issues.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {parsed.issues.map((issue, i) => (
                <li key={i} className="text-xs text-salmon">
                  {issue.line > 0 ? `line ${issue.line}: ` : ""}
                  {issue.message}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={applyTyped}
              disabled={!parsed?.pattern}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                parsed?.pattern
                  ? "bg-bone text-maroonInk hover:bg-chalk"
                  : "cursor-not-allowed bg-maroonDeep/50 text-bone/35"
              }`}
            >
              put it in the grid
            </button>
            <button
              type="button"
              onClick={() => {
                setText(EXAMPLE_BEAT);
                setDirty(true);
              }}
              className="rounded-lg px-2.5 py-1.5 text-xs text-salmon transition hover:bg-salmon/15"
            >
              example
            </button>
            {parsed?.pattern && (
              <span className="ml-auto text-xs text-bone/50">
                {parsed.bars} bar{parsed.bars === 1 ? "" : "s"}
              </span>
            )}
          </div>

          <p className="mt-2 text-xs leading-relaxed text-bone/50">
            One lane per line: <code className="text-bone/70">kick x...x...</code>. Any of{" "}
            <code className="text-bone/70">. - _</code> is a rest. A short lane repeats to fill
            the bar, and naming a lane again continues it, so you can write a bar a line.
          </p>
        </>
      )}
    </section>
  );
}
