// LyricPad.tsx - somewhere to write the words, next to the thing making them.
//
// Lyrics already existed in dice, inside the wall, where they are the prompt
// you sing from and the caption burnt into the bounce. That is the right home
// for them when you are recording and the wrong one when you are writing: the
// words arrive while you are playing the chord that caused them, and the wall
// is a panel away with a disclosure in front of it.
//
// So this is the same sheet, beside the camera. One sheet, not two, because
// two boxes of lyrics in one studio is a question nobody should have to answer
// about which one the video will use.

import { useRef } from "react";

export interface LyricPadProps {
  value: string;
  onChange(next: string): void;
  /** The chord being held, if any, so it can be written down as played. */
  chordLabel?: string | null;
  /** Lines the wall is set to show, for the note under the pad. */
  timedLineCount?: number;
}

/** Words, for the count under the pad. */
function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export default function LyricPad({
  value,
  onChange,
  chordLabel,
  timedLineCount = 0,
}: LyricPadProps) {
  const boxRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Write the chord in at the cursor.
   *
   * At the cursor rather than at the end, because the reason to press this is
   * that the chord belongs over the word you are on. The selection is put back
   * after the symbol so typing carries on where it left off.
   */
  const writeChord = () => {
    const box = boxRef.current;
    if (!box || !chordLabel) return;
    const at = box.selectionStart ?? value.length;
    const end = box.selectionEnd ?? at;
    const before = value.slice(0, at);
    const after = value.slice(end);
    const needsSpace = before !== "" && !/\s$/.test(before);
    const insert = `${needsSpace ? " " : ""}[${chordLabel}] `;
    const next = `${before}${insert}${after}`;
    onChange(next);
    const caret = at + insert.length;
    requestAnimationFrame(() => {
      box.focus();
      box.setSelectionRange(caret, caret);
    });
  };

  const lines = value.split(/\r?\n/).filter((l) => l.trim() !== "").length;

  return (
    <section className="mt-4 rounded-2xl border border-magenta/30 bg-purple/15 p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-white/70">
          Lyrics
        </h2>
        <span className="text-xs text-white/45">
          {lines === 0
            ? "nothing written yet"
            : `${lines} ${lines === 1 ? "line" : "lines"}, ${wordCount(value)} words`}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={writeChord}
            disabled={!chordLabel}
            title={
              chordLabel
                ? `Write ${chordLabel} where the cursor is`
                : "Hold a chord and it can be written in"
            }
            className="rounded-lg border border-purple/50 bg-purple/25 px-2 py-1 text-xs transition hover:bg-magenta/40 disabled:opacity-40 disabled:hover:bg-purple/25"
          >
            {chordLabel ? `write ${chordLabel}` : "write the chord"}
          </button>
          {value !== "" && (
            <button
              type="button"
              onClick={() => onChange("")}
              className="rounded-lg border border-purple/50 bg-purple/25 px-2 py-1 text-xs transition hover:bg-magenta/40"
            >
              clear
            </button>
          )}
        </div>
      </div>

      <textarea
        ref={boxRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={5}
        spellCheck
        placeholder={"write while you play\n\nthe chord you are holding goes in with the button above\n0:12 at the head of a line pins it to that moment in the video"}
        className="w-full resize-y rounded-xl border border-purple/40 bg-ink/40 px-3 py-2 text-sm leading-relaxed text-white/90 placeholder:text-white/30"
      />

      <p className="mt-2 text-[11px] leading-relaxed text-white/45">
        These are the same words the wall uses. They scroll past as a prompt
        while you record a take, and they are burnt into the video when you
        bounce it.{" "}
        {timedLineCount > 0
          ? `${timedLineCount} ${timedLineCount === 1 ? "line is" : "lines are"} timed against the takes on the wall.`
          : "Timing starts once there is a take to time against."}{" "}
        They travel in a shared song link, and they stay in this browser
        otherwise.
      </p>
    </section>
  );
}
