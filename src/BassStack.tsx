// BassStack.tsx - more than one bassline, stacked, running off one transport.
//
// A single grid holds four notes per step, which is a chord and not a second
// part: a sub sitting on the root while a line walks over the top is two
// rhythms, and no amount of stacking notes into one lane will express that. So
// a bassline is a lane here, and you can have a few of them.
//
// Everything that makes a stack usable rather than merely possible lives in the
// lane header: a name, a mute, a level, and the order they sit in. The level in
// particular is not decoration - stacked bass parts land in the same octave on
// the same bus, so without one, the layer you add second buries the foundation
// you wrote first and the feature sounds broken.

import BassSequencer from "./BassSequencer";
import {
  MAX_BASS_LANES,
  addBassLane,
  duplicateBassLane,
  moveBassLane,
  removeBassLane,
  updateBassLane,
  type BassLane,
} from "./lib/bass";
import type { ScaleName } from "./lib/music";

export interface BassStackProps {
  lanes: BassLane[];
  /**
   * `wroteNotes` separates writing a note from housekeeping. Writing a note is
   * asking to hear it, so the transport starts; adding an empty lane or nudging
   * a fader is not, and starting playback for those would be noise.
   */
  onChange(next: BassLane[], wroteNotes?: boolean): void;
  tonic: number;
  scale: ScaleName;
  getPlayhead?: () => number;
  running?: boolean;
}

const ctrl =
  "rounded-md border border-purple/50 bg-purple/25 px-2 py-1 text-xs transition hover:bg-purple/40 disabled:opacity-40 disabled:hover:bg-purple/25";

export default function BassStack({
  lanes,
  onChange,
  tonic,
  scale,
  getPlayhead,
  running = false,
}: BassStackProps) {
  const full = lanes.length >= MAX_BASS_LANES;

  return (
    <div className="space-y-2">
      {lanes.map((lane, index) => {
        const level = Math.round(lane.gain * 100);
        return (
          <div
            key={lane.id}
            className={`rounded-xl border p-2 ${
              lane.muted ? "border-white/10 bg-white/[0.02]" : "border-purple/40 bg-purple/10"
            }`}
          >
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
              <div className="flex items-center">
                <button
                  type="button"
                  aria-label={`Move ${lane.name} up`}
                  title="Move this bassline up the stack"
                  disabled={index === 0}
                  onClick={() => onChange(moveBassLane(lanes, lane.id, -1))}
                  className={`${ctrl} rounded-r-none px-1.5`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move ${lane.name} down`}
                  title="Move this bassline down the stack"
                  disabled={index === lanes.length - 1}
                  onClick={() => onChange(moveBassLane(lanes, lane.id, 1))}
                  className={`${ctrl} -ml-px rounded-l-none px-1.5`}
                >
                  ↓
                </button>
              </div>

              <input
                value={lane.name}
                aria-label={`Name of bassline ${index + 1}`}
                onChange={(event) =>
                  onChange(updateBassLane(lanes, lane.id, { name: event.target.value }))
                }
                className="w-28 rounded-md border border-purple/50 bg-purple/25 px-1.5 py-1 text-xs"
              />

              <button
                type="button"
                aria-pressed={lane.muted}
                title={lane.muted ? "Unmute this bassline" : "Mute this bassline"}
                onClick={() => onChange(updateBassLane(lanes, lane.id, { muted: !lane.muted }))}
                className={
                  lane.muted
                    ? "rounded-md border border-white/40 bg-white/20 px-2 py-1 text-xs font-semibold"
                    : ctrl
                }
              >
                {lane.muted ? "muted" : "mute"}
              </button>

              <label className="flex items-center gap-1 text-white/65">
                <span>level</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={level}
                  aria-label={`Level of bassline ${index + 1}`}
                  onChange={(event) =>
                    onChange(
                      updateBassLane(lanes, lane.id, { gain: Number(event.target.value) / 100 })
                    )
                  }
                  className="w-20 accent-cyan-300"
                />
                <span className="w-9 tabular-nums text-white/50">{level}%</span>
              </label>

              <div className="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={full}
                  title={
                    full
                      ? `A stack holds ${MAX_BASS_LANES} basslines`
                      : "Copy this bassline into a new lane"
                  }
                  onClick={() => onChange(duplicateBassLane(lanes, lane.id))}
                  className={ctrl}
                >
                  duplicate
                </button>
                <button
                  type="button"
                  disabled={lanes.length <= 1}
                  title={
                    lanes.length <= 1
                      ? "The stack keeps one bassline. Clear it instead."
                      : "Remove this bassline"
                  }
                  onClick={() => onChange(removeBassLane(lanes, lane.id))}
                  className={ctrl}
                >
                  remove
                </button>
              </div>
            </div>

            <div className={lane.muted ? "opacity-45" : undefined}>
              <BassSequencer
                pattern={lane.pattern}
                onChange={(next) =>
                  onChange(updateBassLane(lanes, lane.id, { pattern: next }), true)
                }
                tonic={tonic}
                scale={scale}
                getPlayhead={getPlayhead}
                // A muted lane's playhead would run against notes you cannot
                // hear, which reads as a bug rather than as a mute.
                running={running && !lane.muted}
                showHint={false}
              />
            </div>
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={full}
          title={
            full
              ? `A stack holds ${MAX_BASS_LANES} basslines`
              : "Add another bassline under this one"
          }
          onClick={() => onChange(addBassLane(lanes))}
          className="rounded-md border border-purple/50 bg-purple/25 px-2 py-1 text-xs font-semibold transition hover:bg-purple/40 disabled:opacity-40 disabled:hover:bg-purple/25"
        >
          + bassline
        </button>
        <span className="text-[11px] text-white/50">
          {full
            ? `${MAX_BASS_LANES} of ${MAX_BASS_LANES} lanes. Remove one to add another.`
            : `${lanes.length} of ${MAX_BASS_LANES} lanes, all playing off the beat's transport.`}
        </span>
      </div>

      <p className="text-[11px] text-white/50">
        Click to layer notes into a step, up to four per lane: a root with a fifth or an octave
        under it. Stack lanes for parts that move against each other - a sub holding the root under
        a line that walks. Each lane keeps its own bars, so a one-bar sub repeats under a four-bar
        line. The rows follow the current key and scale.
      </p>
    </div>
  );
}
