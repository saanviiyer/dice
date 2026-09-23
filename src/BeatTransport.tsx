// BeatTransport.tsx - the drums, with a transport, where you can reach them.
//
// Shared by both modes and placed under the camera and the chord readout,
// because that is where there is room to work on a groove while you are playing
// over it. It used to be a checkbox in a sidebar and a step grid folded into a
// <details>, which meant turning the beat on was easy and doing anything about
// it afterwards was not.
//
// Play, pause and stop are three different things here and the distinction
// earns its place: pause holds the groove mid-bar so resume picks it up from
// there, while stop rewinds to the top. Once a pattern is longer than a bar,
// restarting from bar one every time you glance away means never hearing the
// bar you are working on in context.

import BassStack from "./BassStack";
import BeatSequencer from "./BeatSequencer";
import type { BassLane } from "./lib/bass";
import type { ScaleName } from "./lib/music";
import { useEffect, useState } from "react";
import {
  BPM_MAX,
  BPM_MIN,
  CUSTOM_PATTERN,
  DRUM_PATTERN_CHOICES,
  commitBpm,
  type DrumEnables,
  type DrumPattern,
  type DrumPatternChoice,
} from "./lib/drums";

export type BeatState = "playing" | "paused" | "stopped";

/**
 * A tempo field you can actually type in.
 *
 * The draft is held as text while the field has focus and only becomes a number
 * on blur or Enter. Clamping every keystroke instead means typing "90" over
 * "120" sends "9", which clamps to 40, and the next keystroke appends to that
 * giving "400", which clamps to the maximum: the field sticks at 220 and cannot
 * be typed out of.
 */
function TempoField({ bpm, onBpm }: { bpm: number; onBpm(next: number): void }) {
  const [draft, setDraft] = useState(String(bpm));
  const [editing, setEditing] = useState(false);

  // Follow the project when it changes from anywhere else, but never yank the
  // field out from under someone mid-edit.
  useEffect(() => {
    if (!editing) setDraft(String(bpm));
  }, [bpm, editing]);

  const commit = () => {
    const next = commitBpm(draft, bpm);
    setEditing(false);
    setDraft(String(next));
    if (next !== bpm) onBpm(next);
  };

  return (
    <input
      type="number"
      inputMode="numeric"
      min={BPM_MIN}
      max={BPM_MAX}
      value={draft}
      aria-label="tempo in BPM"
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(String(bpm));
          setEditing(false);
          e.currentTarget.blur();
        }
      }}
      className="w-16 rounded-lg border border-salmonDim/40 bg-maroonDeep/60 px-2 py-1.5 text-sm tabular-nums"
    />
  );
}

export interface BeatTransportProps {
  state: BeatState;
  onPlay(): void;
  onPause(): void;
  onStop(): void;

  pattern: DrumPatternChoice;
  onPattern(next: DrumPatternChoice): void;
  bpm: number;
  onBpm(next: number): void;

  bassOn: boolean;
  onBass(next: boolean): void;
  metronome: boolean;
  onMetronome(next: boolean): void;

  customBeat: DrumPattern;
  onCustomBeat(next: DrumPattern): void;
  getPlayhead(): number;
  /** Per-lane mutes, drawn dimmed. Play mode has these; produce mode does not. */
  enables?: DrumEnables;

  /**
   * The basslines - a stack of them - which live here rather than in a sidebar
   * because they run off this same transport: the drum machine schedules the
   * beat and every bass lane together, so pausing the beat pauses all of them
   * with it. Splitting them across the page made that shared fate invisible.
   */
  bassLanes: BassLane[];
  onBassLanes(next: BassLane[]): void;
  tonic: number;
  scale: ScaleName;
}

export default function BeatTransport({
  state,
  onPlay,
  onPause,
  onStop,
  pattern,
  onPattern,
  bpm,
  onBpm,
  bassOn,
  onBass,
  metronome,
  onMetronome,
  customBeat,
  onCustomBeat,
  getPlayhead,
  enables,
  bassLanes,
  onBassLanes,
  tonic,
  scale,
}: BeatTransportProps) {
  return (
    <section className="mt-4 rounded-2xl border border-salmonDim/30 bg-maroon/40 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-bone/80">
          the beat
        </h2>
        <span className="text-xs text-bone/45">
          {state === "playing" ? "playing" : state === "paused" ? "held" : "stopped"}
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={state === "playing" ? onPause : onPlay}
            className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition ${
              state === "playing"
                ? "bg-salmon text-maroonInk hover:bg-chalk"
                : "bg-bone text-maroonInk hover:bg-chalk"
            }`}
          >
            {state === "playing" ? "pause" : state === "paused" ? "resume" : "play"}
          </button>
          <button
            type="button"
            onClick={onStop}
            disabled={state === "stopped"}
            title="Stop and rewind to the top of the pattern"
            className="rounded-lg border border-salmonDim/45 px-3 py-1.5 text-sm font-semibold text-chalk transition hover:bg-salmon/10 disabled:opacity-40"
          >
            stop
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1.5">
          <span className="text-bone/65">pattern</span>
          <select
            value={pattern}
            onChange={(e) => onPattern(e.target.value as DrumPatternChoice)}
            className="rounded-lg border border-salmonDim/40 bg-maroonDeep/60 px-2 py-1.5 text-sm"
          >
            {DRUM_PATTERN_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n === CUSTOM_PATTERN ? "Custom (my beat)" : n}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5">
          <span className="text-bone/65">bpm</span>
          <TempoField bpm={bpm} onBpm={onBpm} />
        </label>

        <label className="flex items-center gap-2 text-bone/80">
          <input type="checkbox" checked={bassOn} onChange={(e) => onBass(e.target.checked)} />
          bass
        </label>

        <label className="flex items-center gap-2 text-bone/80">
          <input
            type="checkbox"
            checked={metronome}
            onChange={(e) => onMetronome(e.target.checked)}
          />
          metronome
        </label>
        <span className="text-xs text-bone/40">M</span>
      </div>

      {/* The grid, full width. This is the room the sidebar never had. */}
      <div className="mt-3 overflow-x-auto">
        <BeatSequencer
          pattern={customBeat}
          onChange={(next) => {
            onCustomBeat(next);
            onPattern(CUSTOM_PATTERN);
            if (state === "stopped") onPlay();
          }}
          getPlayhead={getPlayhead}
          enables={enables}
          running={state === "playing" && pattern === CUSTOM_PATTERN}
        />
      </div>
      <p className="mt-1 text-xs text-bone/45">
        {pattern === CUSTOM_PATTERN
          ? "Shift-click a step for an accent."
          : "Editing here switches the pattern to Custom."}{" "}
        Or beatbox the beat and let dice write it in for you, below.
      </p>

      <details className="mt-3 border-t border-salmonDim/20 pt-3" open={bassOn}>
        <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-wide text-bone/60">
          {bassLanes.length > 1 ? `basslines (${bassLanes.length})` : "bassline"}
          {!bassOn && <span className="ml-2 font-normal text-bone/40">off</span>}
        </summary>
        <div className="mt-2 overflow-x-auto">
          <BassStack
            lanes={bassLanes}
            onChange={(next, wroteNotes) => {
              onBassLanes(next);
              // Writing a note is asking to hear it. Adding an empty lane or
              // moving a fader is not, so those leave the transport alone.
              if (!wroteNotes) return;
              onBass(true);
              if (state === "stopped") onPlay();
            }}
            tonic={tonic}
            scale={scale}
            getPlayhead={getPlayhead}
            running={state === "playing" && bassOn}
          />
        </div>
      </details>
    </section>
  );
}
