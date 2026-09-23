// AgentPanel.tsx - the producer agent's face.
//
// Two halves. The read-out is what the agent hears right now: every part, what
// it thinks that part is, where it sits, and the problems it has measured. The
// run panel takes a goal and reports back move by move, each with the number
// that justified it and how much closer to the goal it got.
//
// The transcript is the point. An agent that quietly changes twelve faders is
// indistinguishable from a preset; one that says "the pad is 4 dB over the
// vocal, so it came down 3" is a producer you can argue with.

import { useCallback, useMemo, useRef, useState } from "react";
import {
  diagnose,
  GOALS,
  hearMixer,
  interpretGoal,
  offlinePlanner,
  remotePlanner,
  runProducerAgent,
  summarizeRun,
  type AgentEvent,
  type Goal,
  type Issue,
  type MeasureCache,
  type RunResult,
} from "./lib/producerAgent";
import { effectiveLoudnessDb, type SessionAnalysis, type TrackMeta } from "./lib/ears";
import type { AgentMixerPort, BackingKind } from "./lib/producerTools";

export interface AgentPanelProps {
  /** Null until the audio context exists. */
  port: AgentMixerPort | null;
  getTracks(): TrackMeta[];
  readAudio(id: number): { data: Float32Array; sampleRate: number } | null;
  /** Present only when the engine is reachable. */
  requestBacking?(kind: BackingKind, style?: string): Promise<void>;
  /** Bumped by the parent whenever the mixer changes, to refresh the read-out. */
  version: number;
  /** Called after the agent changes anything, so the parent can re-read state. */
  onChanged?(): void;
}

/**
 * Optional endpoint for a model-backed planner. Unset by default: the offline
 * planner needs no key and no network, and is what runs out of the box.
 */
const AGENT_URL = (import.meta.env.VITE_DICE_AGENT_URL as string | undefined) || "";

const round1 = (v: number) => Math.round(v * 10) / 10;

interface Line {
  kind: "act" | "revert" | "note" | "error" | "done";
  text: string;
  detail?: string;
}

export default function AgentPanel({
  port,
  getTracks,
  readAudio,
  requestBacking,
  version,
  onChanged,
}: AgentPanelProps) {
  const cacheRef = useRef<MeasureCache>(new Map());
  const [goal, setGoal] = useState<Goal>("radio-ready");
  const [freeText, setFreeText] = useState("");
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [summary, setSummary] = useState("");
  const [lastRun, setLastRun] = useState<RunResult | null>(null);
  const [listened, setListened] = useState<SessionAnalysis | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const abortRef = useRef({ aborted: false });

  const ready = port !== null && getTracks().length > 0;

  // Measuring is real work, so it happens when asked rather than on every
  // render. `version` invalidates the memo when the mixer changes.
  const listen = useCallback(() => {
    const session = hearMixer(getTracks, readAudio, cacheRef.current);
    setListened(session);
    setIssues(diagnose(session, goal));
  }, [getTracks, readAudio, goal, version]);

  const run = useCallback(async () => {
    if (!port) return;
    setBusy(true);
    setLines([]);
    setSummary("");
    setLastRun(null);
    abortRef.current = { aborted: false };

    const goalText = freeText.trim() || GOALS.find((g) => g.id === goal)?.label || "";
    const collected: Line[] = [];
    const push = (line: Line) => {
      collected.push(line);
      setLines([...collected]);
    };

    try {
      const result = await runProducerAgent({
        port: requestBacking ? { ...port, requestBacking } : port,
        getTracks,
        readAudio,
        goalText,
        goal: freeText.trim() ? interpretGoal(freeText) : goal,
        planner: AGENT_URL ? remotePlanner(AGENT_URL) : offlinePlanner,
        signal: abortRef.current,
        onEvent: (e: AgentEvent) => {
          if (e.type === "act") {
            push({
              kind: "act",
              text: `${e.step}. ${e.call.tool.replace(/_/g, " ")}`,
              detail: `${e.call.reason} (${round1(e.scoreBefore)} to ${round1(e.scoreAfter)})`,
            });
          } else if (e.type === "revert") {
            push({
              kind: "revert",
              text: `${e.step}. tried ${e.call.tool.replace(/_/g, " ")}, put it back`,
              detail: `${e.call.reason}. It did not improve the mix, so it was undone.`,
            });
          } else if (e.type === "error") {
            push({ kind: "error", text: e.message });
          } else if (e.type === "note") {
            push({ kind: "note", text: e.message });
          }
        },
      });
      setLastRun(result);
      setSummary(summarizeRun(result));
      onChanged?.();
      listen();
    } catch (err) {
      push({ kind: "error", text: err instanceof Error ? err.message : "the run failed" });
    } finally {
      setBusy(false);
    }
  }, [port, goal, freeText, getTracks, readAudio, requestBacking, onChanged, listen]);

  const undoRun = useCallback(() => {
    lastRun?.undoAll();
    setLastRun(null);
    setSummary("put back the way it was");
    setLines([]);
    onChanged?.();
    listen();
  }, [lastRun, onChanged, listen]);

  const goalSpec = useMemo(() => GOALS.find((g) => g.id === goal), [goal]);

  return (
    <section className="rounded-2xl border border-salmonDim/30 bg-maroon/50 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-bone/80">
          producer agent
        </h2>
        <span className="text-xs text-bone/40">
          {AGENT_URL ? "model planner" : "runs offline"}
        </span>
      </div>

      {/* Goals */}
      <div className="flex flex-wrap gap-1.5">
        {GOALS.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => setGoal(g.id)}
            aria-pressed={goal === g.id}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${
              goal === g.id
                ? "bg-bone text-maroonInk"
                : "bg-maroonDeep/60 text-bone/75 hover:bg-maroonDeep"
            }`}
          >
            {g.label}
          </button>
        ))}
      </div>
      {goalSpec && <p className="mt-2 text-xs text-bone/50">{goalSpec.brief}</p>}

      <div className="mt-3 flex gap-2">
        <input
          type="text"
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy && ready) run();
          }}
          placeholder="or say it in your own words"
          className="w-full rounded-lg border border-salmonDim/40 bg-maroonDeep/50 px-2 py-1.5 text-sm placeholder:text-bone/35"
        />
        <button
          type="button"
          onClick={busy ? () => (abortRef.current.aborted = true) : run}
          disabled={!ready && !busy}
          className={`shrink-0 rounded-lg px-4 py-1.5 text-sm font-semibold transition ${
            busy
              ? "bg-maroonDeep/70 text-bone/70"
              : ready
                ? "bg-bone text-maroonInk hover:bg-chalk"
                : "cursor-not-allowed bg-maroonDeep/40 text-bone/30"
          }`}
        >
          {busy ? "stop" : "produce"}
        </button>
      </div>

      {!ready && (
        <p className="mt-2 text-xs text-bone/50">
          Record or import something first, then the agent has a mix to work on.
        </p>
      )}

      {/* Transcript */}
      {lines.length > 0 && (
        <ol className="mt-3 flex flex-col gap-1.5">
          {lines.map((l, i) => (
            <li
              key={i}
              className={`rounded-lg px-2.5 py-1.5 text-xs ${
                l.kind === "revert"
                  ? "bg-maroonInk/50 text-bone/55"
                  : l.kind === "error"
                    ? "border border-live/50 bg-live/10 text-chalk"
                    : "bg-maroonInk/60 text-chalk"
              }`}
            >
              <span className="font-semibold lowercase">{l.text}</span>
              {l.detail && <span className="block text-bone/60">{l.detail}</span>}
            </li>
          ))}
        </ol>
      )}

      {summary && (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-lg bg-salmon/10 px-2.5 py-2 text-xs">
          <span className="text-chalk">{summary}</span>
          {lastRun && lastRun.applied.length > 0 && (
            <button
              type="button"
              onClick={undoRun}
              className="shrink-0 rounded px-2 py-1 font-medium text-salmon hover:bg-salmon/15"
            >
              undo this run
            </button>
          )}
        </div>
      )}

      {/* What it hears */}
      <div className="mt-4 border-t border-salmonDim/20 pt-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-bone/55">
            what it hears
          </h3>
          <button
            type="button"
            onClick={listen}
            disabled={!ready}
            className="rounded px-2 py-1 text-xs text-salmon hover:bg-salmon/15 disabled:text-bone/25"
          >
            listen
          </button>
        </div>

        {listened && listened.tracks.length > 0 ? (
          <>
            <p className="mt-1.5 text-xs text-bone/50">
              peak {round1(listened.mixPeakDb)} dB, spread {round1(listened.loudnessSpreadDb)} dB
              {listened.tempoBpm ? `, about ${Math.round(listened.tempoBpm)} BPM` : ""}
            </p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {listened.tracks.map((t) => (
                <li
                  key={t.id}
                  className="flex items-baseline justify-between gap-2 text-xs text-bone/75"
                >
                  <span className="truncate">
                    {t.name}
                    <span className="ml-1.5 text-bone/40">{t.part}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-bone/50">
                    {round1(effectiveLoudnessDb(t))} dB
                    {t.pan !== 0 && ` · ${t.pan < 0 ? "L" : "R"}${Math.abs(Math.round(t.pan * 100))}`}
                  </span>
                </li>
              ))}
            </ul>
            {issues.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-1">
                {issues.slice(0, 4).map((i, n) => (
                  <li key={n} className="text-xs text-salmon/85">
                    {i.detail}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-bone/45">nothing it would change</p>
            )}
          </>
        ) : (
          <p className="mt-1.5 text-xs text-bone/45">
            {ready ? "press listen to measure the mix" : "no audio yet"}
          </p>
        )}
      </div>
    </section>
  );
}
