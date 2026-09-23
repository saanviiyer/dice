// Studio.tsx - the dice studio shell.
//
// The header and the Simple/Producer toggle. Only one mode is mounted at a
// time; switching unmounts the other, which releases its camera and its
// AudioContext through that component's own cleanup.

import { lazy, Suspense, useState } from "react";
import { DiceMark, Wordmark } from "./BrandMarks";
import { hrefFor } from "./lib/router";

const SimpleMode = lazy(() => import("./SimpleMode"));
const ProducerMode = lazy(() => import("./ProducerMode"));

type TopMode = "simple" | "producer";

const MODES: Array<[TopMode, string, string]> = [
  ["simple", "play", "the instrument on its own"],
  ["producer", "produce", "the instrument into a full studio"],
];

export default function Studio() {
  const [mode, setMode] = useState<TopMode>("simple");

  return (
    <div className="mx-auto min-h-full max-w-6xl px-4 py-5">
      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <a href={hrefFor("home")} className="flex shrink-0 items-center gap-2.5">
            <DiceMark size={30} />
            <Wordmark className="text-2xl text-chalk" />
          </a>

          <div
            className="ml-auto inline-flex rounded-full border border-salmonDim/35 bg-maroon/50 p-1"
            role="tablist"
            aria-label="dice mode"
          >
            {MODES.map(([m, label, hint]) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                role="tab"
                aria-selected={mode === m}
                title={hint}
                className={`rounded-full px-5 py-2 text-sm font-semibold transition ${
                  mode === m
                    ? "bg-bone text-maroonInk"
                    : "text-bone/75 hover:bg-maroonDeep/60"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-2 text-sm text-bone/60">
          {mode === "simple"
            ? "Play chords with your hands. Camera and microphone stay on your machine."
            : "Record loops into the mixer, stack your voice, and hand it to the producer agent."}
        </p>
      </header>

      <Suspense
        fallback={
          <div
            className="flex items-center justify-center gap-3 rounded-3xl border border-salmonDim/25 bg-maroon/40 p-10 text-bone/70"
            role="status"
          >
            <DiceMark size={26} />
            <span>loading the studio</span>
          </div>
        }
      >
        {mode === "simple" ? <SimpleMode /> : <ProducerMode />}
      </Suspense>

      <footer className="mt-8 text-xs text-bone/40">
        Best in Chrome or Edge. The camera needs HTTPS or localhost. Hand
        tracking by MediaPipe Tasks Vision, audio by the Web Audio API.
      </footer>
    </div>
  );
}
