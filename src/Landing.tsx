// Landing.tsx - the dice website.
//
// The marketing half of the product, built from the same brand tokens and the
// same drawings as the studio so the two cannot drift apart. It carries no
// MediaPipe and no audio code: the studio is lazy-loaded only when someone
// opens it, so the front page stays a page rather than a whole DAW.
//
// The layout follows the key art's two grounds. Brick bands carry the hero and
// the call to action; maroon carries the content in between. Emphasis is always
// an italic on the word the line lands on.

import type { ReactNode } from "react";
import { BRAND } from "./brand";
import {
  Deck,
  DiceMark,
  Headphones,
  Note,
  SequencerGrid,
  Stave,
  Waveform,
  Wordmark,
} from "./BrandMarks";
import { hrefFor } from "./lib/router";

function Section({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`mx-auto w-full max-w-6xl px-5 ${className}`}>{children}</section>;
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-salmon/80">
      {children}
    </p>
  );
}

/** The brand's emphasis device. */
function Em({ children }: { children: ReactNode }) {
  return <span className="dice-emph">{children}</span>;
}

function Card({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col rounded-3xl border border-salmonDim/25 bg-maroon/35 p-6">
      {children && <div className="mb-4">{children}</div>}
      <h3 className="dice-display text-2xl text-chalk">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-bone/70">{body}</p>
    </div>
  );
}

export default function Landing() {
  return (
    <div className="min-h-full pb-20">
      {/* Header */}
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-6">
        <a href={hrefFor("home")} className="flex items-center gap-2.5">
          <DiceMark size={30} />
          <Wordmark className="text-2xl text-chalk" />
        </a>
        <nav className="flex items-center gap-1">
          {[
            ["#what", "what it does"],
            ["#build", "build your own"],
            ["#agent", "the agent"],
            ["#get", "get it"],
          ].map(([href, label]) => (
            <a
              key={href}
              href={href}
              className="hidden rounded-full px-3 py-2 text-sm text-bone/70 transition hover:text-chalk sm:block"
            >
              {label}
            </a>
          ))}
          <a
            href={hrefFor("studio")}
            className="ml-2 rounded-full bg-brick px-4 py-2 text-sm font-semibold text-chalk transition hover:bg-brickDeep"
          >
            open the studio
          </a>
        </nav>
      </header>

      {/* Hero, on brick, laid out like the key art: line work left, type right. */}
      <Section className="pt-2">
        <div className="overflow-hidden rounded-[2rem] bg-brick px-6 py-10 sm:px-10 sm:py-12">
          <Waveform bars={120} height={54} seed={3} className="h-11 w-full text-bone" />

          <div className="mt-9 grid items-center gap-10 lg:grid-cols-[1.1fr_1fr]">
            <div className="order-2 lg:order-1">
              <Deck className="w-full" />
            </div>

            <div className="order-1 lg:order-2">
              <h1 className="dice-display text-5xl text-chalk sm:text-6xl lg:text-7xl">
                produce music
                <br />
                like a <Em>pro</Em>
              </h1>
              <p className="mt-5 max-w-md text-base leading-relaxed text-chalk/85">
                {BRAND.blurb} No band, no booth, no engineer. Your voice stays
                yours: {BRAND.name} produces the takes you sing, it does not
                generate a song for you.
              </p>
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <a
                  href={hrefFor("studio")}
                  className="rounded-full bg-chalk px-6 py-3 text-base font-semibold text-maroonInk transition hover:bg-bone"
                >
                  open the studio
                </a>
                <a
                  href="#get"
                  className="rounded-full border border-chalk/45 px-6 py-3 text-base font-semibold text-chalk transition hover:bg-chalk/10"
                >
                  get the desktop app
                </a>
              </div>
              <p className="mt-4 text-xs text-chalk/60">
                Runs in the browser. The camera and the microphone never leave
                your machine.
              </p>

              <div className="mt-8 flex items-center gap-6">
                <Headphones size={70} />
                <Note size={28} color="#f5f2ed" />
                <DiceMark size={52} />
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* Positioning, on maroon, with the sequencer grid. */}
      <Section className="mt-20">
        <div className="rounded-[2rem] border border-salmonDim/20 bg-maroon/35 px-6 py-10 sm:px-10">
          <div className="flex flex-wrap items-baseline justify-between gap-4">
            <h2 className="dice-display max-w-xl text-4xl text-chalk sm:text-5xl">
              music production
              <br />
              easy, intuitive, <Em>smart</Em>
            </h2>
            <div className="flex items-center gap-2.5">
              <DiceMark size={34} />
              <Wordmark className="text-2xl text-chalk" />
            </div>
          </div>

          <SequencerGrid rows={4} cols={16} className="mt-8 h-32 w-full" />

          <p className="dice-display dice-emph mt-8 text-3xl text-chalk sm:text-4xl">
            {BRAND.positioning}
          </p>
        </div>
      </Section>

      {/* What it does */}
      <Section className="mt-20">
        <div id="what" className="scroll-mt-24">
          <Eyebrow>what it does</Eyebrow>
          <h2 className="dice-display max-w-2xl text-4xl text-chalk sm:text-5xl">
            a studio that <Em>listens back</Em>
          </h2>
        </div>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <Card
            title="play with your hands"
            body="Point a webcam at yourself and play chords with hand gestures. Finger count picks the chord, one axis moves the inversion, the other opens the filter, a pinch rides the volume. Nothing leaves your machine."
          >
            <Note size={34} color="#efaf9f" />
          </Card>
          <Card
            title="stack your voice"
            body="Sing through the loop and every pass becomes its own phase-locked take, placed across the stereo field for you. Pick the double, the wide triple, the four-part harmony or the six-take choir, and it stops when it has them."
          >
            <Headphones size={40} />
          </Card>
          <Card
            title="let the agent mix it"
            body="Say what you want it to sound like. The producer agent measures every track, works out what is actually wrong, and fixes one thing at a time, telling you which number made it do that."
          >
            <DiceMark size={38} />
          </Card>
        </div>
      </Section>

      {/* Build your own */}
      <Section className="mt-20">
        <div
          id="build"
          className="relative overflow-hidden rounded-[2rem] bg-brick px-6 py-10 sm:px-10 sm:py-12"
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 text-brickDeep">
            <Waveform bars={140} height={70} seed={11} className="h-20 w-full" />
          </div>

          <div className="relative mt-16 grid gap-8 lg:grid-cols-[1fr_1fr]">
            <div>
              <h2 className="dice-display text-4xl text-chalk sm:text-5xl">
                build <Em>your own</Em>
              </h2>
              <p className="dice-display mt-6 text-4xl leading-[1.1] text-chalk sm:text-5xl">
                beat.
                <br />
                song.
                <br />
                arrangement.
                <br />
                remix.
              </p>
            </div>
            <div className="flex flex-col items-start justify-end gap-4 lg:items-end lg:text-right">
              <div className="flex items-center gap-2.5">
                <DiceMark size={34} />
                <Wordmark className="text-2xl text-chalk" />
              </div>
              <p className="max-w-xs text-sm font-semibold leading-snug text-chalk">
                a built-in library of instruments, drum kits and vocal effects,
                free and offline
              </p>
              <p className="dice-emph max-w-xs text-sm text-chalk/80">
                and that's just the prelude.
              </p>
            </div>
          </div>
        </div>
      </Section>

      {/* The agent, in detail. This is the part that is genuinely new. */}
      <Section className="mt-20">
        <div id="agent" className="scroll-mt-24 grid gap-10 lg:grid-cols-[1fr_1fr]">
          <div>
            <Eyebrow>the producer agent</Eyebrow>
            <h2 className="dice-display text-4xl text-chalk sm:text-5xl">
              it hears the mix, then <Em>earns every move</Em>
            </h2>
            <p className="mt-5 text-base leading-relaxed text-bone/75">
              Most "AI mixing" is a preset with a chat box in front of it. The
              agent in {BRAND.name} is a loop. It measures loudness, spectrum,
              transients and the stereo picture across every track, turns that
              into a list of numbered problems, makes exactly one move, then
              measures again.
            </p>
            <p className="mt-4 text-base leading-relaxed text-bone/75">
              If the move did not make the mix measurably better, it puts it
              back. You only ever hear changes that helped, and the transcript
              tells you by how much. The whole run undoes with one button.
            </p>
            <ul className="mt-6 flex flex-col gap-3 text-sm text-bone/65">
              <li>
                <span className="text-chalk">Runs offline.</span> No key, no
                account, no upload. A model planner can be pointed at it, and
                gets the same tools and the same veto.
              </li>
              <li>
                <span className="text-chalk">Bounded.</span> It can move faders,
                pans, tone and reverb sends, and ask the engine for a backing
                part. It cannot delete a take or clear your project.
              </li>
            </ul>
          </div>

          {/* A transcript in the agent's real voice and format. */}
          <div className="rounded-3xl border border-salmonDim/25 bg-maroon/35 p-5">
            <p className="text-xs uppercase tracking-[0.18em] text-salmon/80">
              put the voice on top
            </p>
            <ol className="mt-4 flex flex-col gap-2 text-xs">
              {[
                {
                  head: "1. set tone",
                  body: "Pad is covering Vocal take 1 in the mid, so the top comes off it instead of turning it down (3.9 to 2.1)",
                },
                {
                  head: "2. set level",
                  body: "Vocal take 1 is only 0.4 dB over Pad, and there is 6.2 dB of headroom, so the vocal comes up (2.1 to 1.2)",
                },
                {
                  head: "3. tried set pan, put it back",
                  body: "It did not improve the mix, so it was undone.",
                  dim: true,
                },
                {
                  head: "4. set space",
                  body: "3 vocal takes with no shared room, so Vocal take 2 joins the room the others sit in (1.2 to 0.6)",
                },
              ].map((line) => (
                <li
                  key={line.head}
                  className={`rounded-lg px-3 py-2 ${
                    line.dim ? "bg-maroonInk/50 text-bone/50" : "bg-maroonInk/60 text-chalk"
                  }`}
                >
                  <span className="font-semibold">{line.head}</span>
                  <span className="mt-0.5 block text-bone/60">{line.body}</span>
                </li>
              ))}
            </ol>
            <p className="mt-4 rounded-lg bg-salmon/15 px-3 py-2 text-xs text-chalk">
              3 moves, 85% closer to the goal
            </p>
            <p className="mt-3 text-xs text-bone/40">
              An example run. Your numbers come from your tracks.
            </p>
          </div>
        </div>
      </Section>

      {/* Bring your music to life */}
      <Section className="mt-20">
        <div className="relative overflow-hidden rounded-[2rem] border border-salmonDim/20 bg-maroon/35 px-6 py-10 sm:px-10">
          <div className="pointer-events-none absolute inset-y-0 right-0 w-1/2 text-bone/10">
            <Stave className="h-full w-full" />
          </div>
          <div className="relative">
            <div className="flex items-center gap-2.5">
              <DiceMark size={32} />
              <Wordmark className="text-2xl text-chalk" />
            </div>
            <h2 className="dice-display mt-10 max-w-md text-4xl text-chalk sm:text-5xl">
              bring your music
              <br />
              <Em>to life</Em>
            </h2>
            <div className="mt-8 grid max-w-3xl gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ["multitrack mixer", "Volume, pan, mute, solo, rename, duplicate, download and delete on every track."],
                ["timeline editing", "Coloured regions, drag to move, trim, and snapping off, to beats or to bars."],
                ["rhythm section", "A six-voice drum grid, a key-aware bass piano roll, and a bar-by-bar arrangement."],
                ["vocal stacks", "Doubles, triples, four-part harmony and six-take choirs, recorded hands-free."],
                ["tone and room", "A tone control per track and a shared room that makes a stack read as one voice."],
                ["undo and autosave", "Forty steps of history, and the project restores itself when you come back."],
                ["export", "Bounce the whole mix to a stereo WAV, exactly as you hear it."],
                ["the engine", "An offline audio engine renders beats, pads, basses and arps that fit your take."],
                ["your files, your machine", "Projects live in your browser. The camera feed never leaves the device."],
              ].map(([title, body]) => (
                <div key={title} className="border-t border-salmonDim/20 pt-4">
                  <h3 className="text-sm font-semibold text-chalk">{title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-bone/65">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/* Get it */}
      <Section className="mt-20">
        <div id="get" className="scroll-mt-24 rounded-[2rem] bg-brick px-6 py-10 sm:px-10 sm:py-12">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-chalk/70">
            two ways in
          </p>
          <h2 className="dice-display text-4xl text-chalk sm:text-5xl">
            same {BRAND.name}, <Em>either way</Em>
          </h2>
          <div className="mt-8 grid gap-8 md:grid-cols-2">
            <div>
              <h3 className="dice-display text-2xl text-chalk">in the browser</h3>
              <p className="mt-2 text-sm leading-relaxed text-chalk/80">
                Nothing to install. Open the studio, allow the camera and the
                microphone, and start. Best in Chrome or Edge; the camera needs
                HTTPS or localhost.
              </p>
              <a
                href={hrefFor("studio")}
                className="mt-4 inline-block rounded-full bg-chalk px-5 py-2.5 text-sm font-semibold text-maroonInk transition hover:bg-bone"
              >
                open the studio
              </a>
            </div>
            <div>
              <h3 className="dice-display text-2xl text-chalk">on the desktop</h3>
              <p className="mt-2 text-sm leading-relaxed text-chalk/80">
                The same studio in its own window, working entirely offline, with
                the engine reachable locally. Build it from the repository with{" "}
                <code className="rounded bg-maroonInk/40 px-1.5 py-0.5 text-xs text-chalk">
                  npm run desktop:build
                </code>
                .
              </p>
              <p className="mt-4 text-xs text-chalk/65">
                macOS, Windows and Linux. No signed installer is published yet,
                so building it yourself is the way in for now.
              </p>
            </div>
          </div>
        </div>
      </Section>

      {/* Footer */}
      <footer className="mx-auto mt-16 w-full max-w-6xl px-5">
        <Waveform bars={120} height={30} seed={7} className="h-6 w-full text-bone opacity-40" />
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 text-xs text-bone/45">
          <div className="flex items-center gap-2">
            <DiceMark size={20} />
            <Wordmark className="text-base text-bone/70" />
            <span className="ml-2">{BRAND.tagline}</span>
          </div>
          <p>Hand tracking by MediaPipe Tasks Vision. Audio by the Web Audio API.</p>
        </div>
      </footer>
    </div>
  );
}
