# dice

**produce music like a pro.** dice is a hand-gesture instrument, a vocal
studio, and a producer agent that mixes your takes and tells you why. It ships
as one build with two front doors: a website and a desktop app, both called
dice.

dice produces the takes *you* sing. It does not generate a song for you.

```bash
npm install
npm run dev      # site at /, studio at /#/studio
npm test         # 564 tests
npm run build    # tsc -b + vite build
```

---

## The two surfaces

One codebase, one brand, two ways in.

| | how | where |
|---|---|---|
| **website** | `npm run build`, deploy `dist/` | `/` is the marketing page, `/#/studio` is the studio |
| **desktop app** | `npm run desktop:build` | `release/dice-<platform>-<arch>/dice.app` |

Routing is hash-based (`src/lib/router.ts`). The same build has to work behind a
static host with SPA rewrites, behind one without them, and inside the desktop
shell loading off disk. A path router breaks in the last two; a hash never
leaves the document.

The studio and everything it drags in (MediaPipe, the audio engine, the mixer)
are code-split, so the front page does not download a DAW.

### Desktop

`npm run desktop:build` rasterises `public/dice.svg` into a real `.icns` and
packages the app with `@electron/packager`. Four things go in: `dist/`, the
three files in `desktop/`, and `package.json`. Vite has already bundled the
renderer's dependencies, so the packaged app ships no `node_modules`.

Two details in `desktop/main.cjs` are load-bearing:

- The app is served over a custom **`dice://` scheme registered as secure**, not
  over `file://`. `getUserMedia` only runs in a secure context, so a `file://`
  shell would ship with a camera and microphone that silently never work.
- The same handler **proxies `/engine/*`** to the local audio engine, mirroring
  the Vite dev proxy. The engine stays same-origin from the renderer's point of
  view, so the desktop build needs no CORS setup and no separate base URL baked
  into the bundle.

The build is unsigned. On macOS, right-click the app and choose Open the first
time or Gatekeeper will refuse it.

---

## The producer agent

The part that is genuinely new. Most "AI mixing" is a preset with a chat box in
front of it; this is a closed loop.

Each step it **hears** (measures every track), **judges** (turns that into
numbered problems), **scores** (collapses them into one number under your goal),
**acts** (makes exactly one move), and **checks** (re-scores, and reverts the
move if the mix did not get better).

The check is what makes it an agent rather than a macro. A move that does not
earn its place costs one step instead of ruining the mix, and the transcript
says by how much each surviving move helped:

```
1. set tone   Pad is covering Vocal take 1 in the mid, so the top comes off it
              instead of turning it down (3.9 to 2.1)
2. set level  Vocal take 1 is only 0.4 dB over Pad, and there is 6.2 dB of
              headroom, so the vocal comes up (2.1 to 1.2)
3. tried set pan, put it back  It did not improve the mix, so it was undone.
```

The whole run undoes with one button.

| file | what it is |
|---|---|
| `src/lib/ears.ts` | perception: FFT, gated loudness, band split, masking, session roll-up |
| `src/lib/producerTools.ts` | the action registry, every tool invertible |
| `src/lib/producerMixer.ts` | the mixer, including the per-track channel EQ |
| `src/lib/producerAgent.ts` | diagnostics, goals, scoring, the loop |
| `src/AgentPanel.tsx` | goals, transcript, and a read-out of what it hears |

**Runs offline.** No key, no account, no upload. Set `VITE_DICE_AGENT_URL` to
put a model-backed planner in front instead; it gets the same tool schemas and
the same veto, so it can only choose among moves the agent already knows how to
undo and verify.

**Bounded.** Levels, pan, tone, the ambience send, mute, and asking the engine
for a backing part. It cannot delete a take or clear your project.

### Things worth knowing

- **Re-hearing is modelled, not re-rendered.** Track audio is measured once,
  pre-fader and pre-filter. Level, pan and send are then exact; the tone knob's
  effect on the spectrum is modelled analytically. That is what lets the loop
  evaluate a candidate move in microseconds instead of bouncing the mix once per
  step. The spectral half of the score is a good model of the filter rather than
  a measurement of it.
- **Low collisions are filtered, not ducked.** The channel EQ gave the agent a
  high pass, so a part sitting on top of the bass gets moved out of the way at
  its own level. The bass itself is only ever ducked; high-passing it out of its
  own bottom end is not a fix.
- **Faders stop at unity.** A vocal already at 1.0 cannot be raised, so a buried
  vocal at full fader is fixed by bringing the track down around it.
- **Kick and bass overlapping at the bottom is not reported.** It is how records
  are made, and it is the one collision this mixer cannot fix properly:
  separating them wants a high-pass or sidechain, and the only available move is
  turning the kick down, which is usually wrong.

---

## Two kinds of clip

This is where dice's arrangement view stops looking like everyone else's.

In a conventional DAW every region is the same object: a rectangle with a
waveform in it, whether it holds a sung take or a programmed drum part. But
those are not the same kind of thing to work on. A performance is something you
listen back to and trim; a programmed part is a pattern you edit.

So dice draws them differently:

- **Performances keep their waveform.** The shape of the sound is the
  information: it is what tells you which take this was.
- **Programmed parts become blocks of steps**, one cell per sixteenth, lit where
  the hits are. Where the hits fall is the information, and the waveform of a
  synthesised kick tells you nothing you wanted to know.
- **Vocal takes recorded as one stack share a spine** down the left of their
  lanes, so a stack reads as one thing rather than as several unrelated tracks.

Anything you recorded stays a performance whatever it contains — someone
beatboxing a drum part is still a performance, and the waveform is how they find
the right take. Only parts that came from a pattern draw as blocks.

Step cells collapse to a plain bar below about three pixels wide, because at
that size a grid of cells is mush rather than information.

`src/lib/clipview.ts` decides which is which and reduces a waveform to steps;
`src/Timeline.tsx` draws it.

**Both modes have the timeline.** It used to be produce-mode only, which meant
play mode could record a stack of loop takes and then show you nothing: where a
take actually sat in the bar was something you could hear and never see. The
same component draws both, reading play mode's loop takes dressed as mixer
tracks, so the two views cannot drift apart.

Play mode's takes are editable there in the same way - drag to move, edge
handles to trim, Copy, Del - with a few differences the loop engine forces:

- **A take is always exactly one cycle long**, and that length is what keeps the
  stack phase-locked. So a trim never shortens the buffer; it silences what you
  cut inside a cycle-length clip, and the take itself is kept, which means a
  trim can be widened again afterwards. `renderLoopClip` in
  `src/lib/vocalLooper.ts` does the placing, and it renders rather than rotating
  the playback node's read offset so the waveform you see, the WAV you download
  and the bounce all agree.
- **A clip that fills the cycle has nowhere to move**, so dragging one does
  nothing until it has been trimmed. Edits are heard from the top of the next
  cycle: swapping a buffer mid-bar would drop that take out of phase with the
  rest of the stack, which is the one thing a looper must never do.
- **The loop length is set by the first take**, so once anything is recorded the
  loop handle is hidden rather than left there looking live. Before that, the
  bars control sets the length of the next recording.

---

## A song in a link

Everything dice made used to die on the machine that made it. Projects live in
one browser's IndexedDB, videos land in a downloads folder, and there was no way
to hand someone the thing you wrote — which is the one thing people want to do
with a song. That is not a missing feature so much as a missing verb: without
it, every user is a leaf.

**Share song** puts the whole song in a link. Tempo, key, chords, the beat, the
basslines with their levels and mutes, the words, and the voice it was written
for. Open the link and the studio is that song.

It is deliberately **not a server**:

- **A fragment never leaves the browser.** The payload rides after the `#`, so it
  is not sent with the request. Sharing a song does not send it to us — the same
  promise the camera and the microphone already make here.
- **No account, no upload, no storage bill, no moderation queue, no outage.** A
  link works as long as the static build does, and a million people opening songs
  costs exactly what a million people opening the page costs.
- **It cannot be taken down or lost.** The song is the link.

**What never travels is the audio.** Recordings are megabytes and they are also
someone's actual voice; neither belongs in a URL that gets pasted around.

The format is binary rather than JSON, because a beat is 384 steps and JSON
spends five characters on each of them. Two bits per step, basslines stored
sparsely because a bassline is mostly rests, and a worst case — four bars, four
basslines, 600 characters of lyric — still comes in under the length that
survives a chat client. A test holds that.

Reading a link back is strict about the things that are the song and forgiving
about the things that are not. A truncated payload, an unknown version or a
scale this build cannot play returns **null**, because half a song opened
silently is worse than a link that says it did not work. An unknown *sound* is
the exception: a voice is cosmetic where the notes are not, so a song written
with an instrument you do not have still opens, on the default. Mangled links —
wrapped, truncated, uppercased, with a stray character appended — return null
rather than throwing, because that is what happens to links.

`src/lib/songlink.ts`, with the round trip and the mangling tested.

---

## Your projects

A shelf of projects across the top of produce mode: a `+` card starts a new one,
and every other card opens, renames or deletes a saved one.

dice used to hold exactly **one** project — a single autosave slot that whatever
you did last quietly overwrote.

Cards are drawn from summaries kept in their own record, not from the projects
themselves. A project carries every recorded audio buffer with it, so listing
ten of them by reading them whole would pull tens of megabytes out of IndexedDB
just to render ten names.

Autosave still runs on the working project, and both it and a named save go
through one `snapshotProject`, so they cannot drift apart in what they capture.
Deleting asks first, because it throws away recordings that exist nowhere else.

`src/lib/projectStore.ts` (storage, and the index logic that is unit tested),
`src/ProjectBrowser.tsx` (the shelf).

---

## Channel EQ

Every track has a three-band channel EQ: a **low cut**, a **mid bell** at 400 Hz,
and the tone control as the high cut.

The low cut is the one that mattered. The mixer used to have a single tone knob,
which is a lowpass — it can take the top off a part but cannot get a boomy one
out from under a vocal, so the only remedy was turning the whole part down. That
limitation was documented in this README and encoded in the producer agent,
which had to duck things it should have filtered. Now it filters them:

```
2. set low cut   Pad is covering Vocal take 1 in the low, so the pad gets a
                 high pass at 140 Hz instead of coming down (2.8 to 1.6)
```

The agent still ducks rather than filters when the masker is the **bass** — a
bass high-passed out of its own bottom end is not a fix — and falls back to
ducking entirely when a mixer has no EQ.

**A bug this surfaced:** the live graph ran the tone filter at the browser's
default Q of 1 while the offline bounce used 0.7, so an export never quite
matched what you heard. Both are Butterworth (0.707) now, from one constant, and
the tone model the agent reasons with no longer needs its "the air band reads a
decibel hot" caveat.

Projects saved before the EQ existed restore with both bands out of the way, so
they sound exactly as they did.

---

## Smart tempo

Play something in freely and let the project take its tempo from the
performance, rather than making the performance chase a click. After a beatbox
take, if what you played disagrees with the project by more than 2 BPM, dice
offers to move the project.

It is deliberately conservative and reports nothing rather than a number it does
not believe: silently retuning a project to a wrong tempo is far worse than
staying quiet, because every part already recorded would end up fighting a grid
that moved under it. A reading needs a real pulse, at least four distinct hits,
and at least two seconds. `readTempo` and `explainTempo` in
`src/lib/transcribe.ts`.

---

## Progression mode

Play mode's other way in: instead of a key and a scale, you type the chords -
`Am E F C`, `G7 Cmaj7 Dm7 F6` - and your fingers pick slots from that list.
Quality comes from the symbol you typed, which is why the Triad/6th/7th control
is switched off here. `parseProgression` in `src/lib/music.ts` reads the line;
anything it cannot read keeps its slot and is flagged rather than dropped, so a
half-typed chord never silently shortens the palette.

**The progression can be transposed** - one semitone at a time, or straight to a
chosen root ("put it in my singer's key"). Three decisions in that:

- **The text is rewritten in place.** Nothing is remembered about an original
  key and how far you have moved from it, because there is nothing to remember:
  what is in the field is the progression, and pressing −1 after +1 puts it back
  exactly as it was.
- **Qualities survive as typed.** `C-` up three is `D#-`, not `D#m`. The parser
  accepts several spellings of the same chord and normalizing them on the way
  through would be rewriting someone's line while claiming to transpose it.
- **A flat progression stays in flats.** `Bb Eb F` up one is `B E Gb`, not
  `B E F#`, because the second is the same notes spelled in a way nobody who
  wrote that line would use. The text keeps whichever accidental it already
  leans on; sharps only when it has none.

Spacing, commas and unparseable tokens come through untouched.
`transposeProgression`, `progressionAccidental` and `semitonesToRoot` in
`src/lib/music.ts`.

---

## The beat

The drums have their own transport, and in **both modes** it sits **under the
camera and the "now playing" chord box** rather than in the sidebar, because
that is where there is room to work on a groove while you are playing it.
`src/BeatTransport.tsx` is one component used by both, so they cannot drift.

- **play / pause / stop.** Pause holds the groove mid-bar and resume picks it up
  from there; stop rewinds to the top. The difference matters once a pattern is
  more than a bar long: restarting from bar one every time you glance away means
  never hearing the bar you are working on in context.
- Pattern, BPM, bass and the metronome are all in the same panel, the step grid
  is full width underneath so all six lanes are visible at once, and the
  **bassline** piano roll folds out below it.
- The bass lives here rather than in a sidebar because it runs off this same
  transport: the drum machine schedules both, so pausing the beat pauses the
  bass with it. Splitting them across the page made that shared fate invisible.
- **The bassline holds up to four notes per step**, so you can write a root with
  a fifth or an octave under it. Clicking a cell layers a note in; clicking a
  lit one takes it out. A step at the limit is disabled rather than swallowing
  the click. Basslines saved before layers existed open unchanged.
- **Basslines stack, up to four of them.** Four notes in one step is a chord,
  not a second part: a sub holding the root while a line walks over the top is
  two rhythms, and one grid can only hold one. So `+ bassline` adds a lane, and
  each lane is a whole bassline with its own bars, preset, name, mute and
  **level**. The level is not decoration - stacked bass parts land in the same
  octave on the same bus, and without it the layer you add second buries the
  foundation you wrote first. Lanes can be duplicated (how an octave doubling
  gets written), reordered and removed, though never the last one, because the
  stack always needs somewhere to write.
- Each lane loops at **its own length**, so a one-bar sub repeats under a
  four-bar line, and the transport cycles over the longest lane. A new lane
  starts at the stack's length rather than at one bar, so layers line up instead
  of wrapping against each other from the first bar.
- Projects save the stack **and** its first lane on its own, so a project saved
  here still opens in a build of dice that predates stacking - and a project
  saved before stacking opens as a single lane. A corrupt stack falls back to
  that single bassline rather than costing you the part.

**Tempo is one field with one range** (40 to 220). There used to be three
controls writing it, two capped at 200 and one at 220, so what the tempo could
be depended on which one you happened to touch. The field also holds what you
type as text and only commits on blur or Enter: clamping every keystroke meant
typing "90" over "120" sent "9", which clamped to 40, and the next keystroke
appended to *that* giving "400", which clamped to the maximum. The field stuck
at 220 and could not be typed out of.

`DrumMachine.stop()` rewinds; `pause()` holds position and `resume()` continues.
Both drop the scheduled lookahead queue as well as the timer, because the
scheduler runs about a tenth of a second ahead of the audio clock — without
that, hits already queued would keep sounding after you pressed stop.

Drums, bass, the pattern picker and the metronome each exist in exactly one
place now, in each mode. They used to be split between the sidebar and the
transport row, and two controls for one state is how you end up clicking the
wrong one.

In play mode, stopping the beat leaves the metronome clicking if that is what
you asked for; pausing holds everything, the click included.

---

## The deck

Two ways at the same grid, because they suit different moments.

**pads** — six pads on the home row, one per sequencer lane, in lane order:

```
A      S       D      F     G     H
kick   snare   clap   hat   tom   shaker
```

Hitting a key fires the sound immediately. **Hold shift for an accent.** Turn on
**record in** and each hit is also written to the grid at the nearest step,
quantised to sixteenths, eighths or quarters. Play a groove in, then edit it on
the grid like anything you drew by hand.

The layout avoids `R`, `M` and Space on purpose: the studio binds those to
record, metronome and transport. The deck claims its keys on the capture phase
and stops them there, so `A`–`H` never reach the transport handler and `R`/`M`
still work while the deck is up. Both directions are covered by tests.

Hits quantise against the drum machine's **own playhead**, not the wall clock.
The scheduler runs about 100 ms ahead of what you are hearing, so a wall-clock
reading would place every hit a step late.

### Velocity

A lane cell holds a velocity in 0..1, not a flag, so a pattern can breathe.
Three named levels — **accent** (1), **normal** (0.72) and **ghost** (0.4) —
because that is what a pad player and a drum tab can both express and what the
notation round-trips without loss.

- **Pads**: shift is the accent.
- **Grid**: shift-click paints an accent; cell opacity tracks velocity, so a
  ghost note looks like one.
- **Notation**: `X` accent, `x` normal, `o` ghost, the convention drum tabs
  already use.
- **Beatbox**: the transcriber keeps the velocity it measured. Flattening every
  hit to full is what makes a transcription sound like a drum machine instead
  of like the person who played it.

Two things this had to get right. Drum voices scale as `velocity^1.4` rather
than linearly, so a ghost note sits *under* an accent the way it does on a real
kit, and every peak is floored above zero because these envelopes use
exponential ramps — a ramp to or from 0 is silent for its whole duration, and a
ghost note would simply vanish. Changing a pattern's bar count carries the
velocities across; flattening them there would erase a groove's dynamics the
moment someone extended the loop.

**type** — write the beat out instead:

```
kick  x...x...x...x...
snare ....x.......x...
hat   ..x...x...x...x.
```

- Lane names take their abbreviations: `k` `bd`, `s` `sn` `sd`, `c` `cp`,
  `h` `hh`, `t`, `sh`.
- Any of `.` `-` `_` and space is a rest; `x` `*` `o` `1` and `#` are hits.
- Bar lines (`|`), colons, blank lines and `//` comments are ignored.
- **A short lane repeats to fill the bar**, so `hat x.` means hats on every
  other step rather than one hat and then silence.
- **Naming a lane again continues it**, so a four-bar part can be written a bar
  a line instead of keeping a 64-character string straight.

The editor shows what it could not read, line by line, and still applies
everything it could, so a typo in one lane does not blank the rest.

`src/lib/padkit.ts` and `src/lib/beatnotation.ts`, fronted by `src/PadDeck.tsx`.
`formatBeat` round-trips, so the text box always reflects whatever is in the
sequencer however it got there.

---

## Strum

Hold a chord on the number keys, then sweep across the strings and they sound
one at a time in the direction you moved. The interaction comes from
[laurie.fm](https://laurie.fm/) — chords on 1–7, strum on the trackpad — and the
reason it feels like an instrument rather than a chord button is that the timing
between the notes is your gesture, not a "strum speed" slider.

- **Flick it** and it snaps; **drag it** and it arpeggiates.
- **Sweep back** for an upstroke: the strings sound high to low.
- **Stop halfway** and only the strings you crossed sound.
- How fast you move is how hard it hits, and the tail of a sweep rings a little
  softer, the way the last string of a real strum does.

The chord is laid out guitar-fashion: tones repeat upward in octaves, so six
strings over a triad give root-third-fifth-root-third-fifth across two octaves
rather than three notes and three silent strings. A two-finger scroll works too;
a wheel event is a jump with no duration of its own, so the sweep spreads it just
enough to read as a strum instead of a block chord.

Strings sit on lines at the centre of their bands, so a gesture reported as two
segments meeting at the same point does not sound the boundary string twice.

`src/lib/strum.ts`, fronted by `src/StrumPad.tsx`. Notes go through
`Synth.triggerNote`, so a strummed string uses the same voice, filter and
effects as anything else the instrument plays.

### Strumming in play mode: the hand frets, the trackpad strums

Turn **Strum** on in play mode and your fingers fret the chord in the air while
your other hand sweeps the trackpad: drag down the camera picture for a
downstroke, back up for an upstroke, two-finger scroll for either. Six strings
are drawn over the picture and light up as you cross them.

The first version of this put the strum on the camera too — sweep your hand up
and down and it strummed. It reads well on paper and does not survive contact
with a hand: **one hand cannot hold a chord still and sweep across it at the same
time**, so every strum smeared the fretting, and a hand that is always somewhere
and never still needed a deadband, a re-anchor on chord change and a pile of
jitter defence before it was even playable. Two hands doing two jobs is how a
guitar is actually played, and the trackpad is a surface with a real beginning
and end to a gesture — pointer down, pointer up — so none of that machinery is
needed.

The camera picture is the strum surface rather than a strip somewhere else: it is
the biggest target on the page and the place you are already looking, and putting
the strings anywhere else would mean watching one thing while strumming another.

- **Flick it** and it snaps; **drag it** and it arpeggiates; **stop halfway** and
  only the strings you crossed sound.
- **A string can only ring once.** Picking one that is still sounding damps it
  first, over 35ms — the length of a finger landing on a ringing string. Without
  that, every stroke piles six more voices onto the ones still decaying and four
  strums a second is two dozen overlapping notes, which is the difference between
  a guitar and a mess. `Synth.triggerNote` returns a `NoteHandle` for exactly
  this; nothing else in the studio needs one.
- **One stroke, one chord.** The hand keeps tracking while you strum, so a finger
  straightening or a drift across the inversion boundary would re-voice the chord
  mid-sweep and leave the second half of a stroke in a different chord from the
  first. The chord is frozen when the stroke starts — on pointer-down, or after a
  pause in a two-finger scroll, since a scroll has no pointer-down to start it.
- **A fist damps the strings**, and so does changing the shape. A fist is already
  this instrument's word for rest, and a fretting hand that moves stops what the
  last shape left ringing. It watches the chord's *name*, not its notes: a
  re-voicing of the same chord is not a new shape, and damping on that would chop
  the strings every time the hand drifted.
- **The held chord goes silent while you strum.** A sustained pad under a strum
  is two instruments playing the same chord, and that drone is what strum mode
  exists to get rid of. A **strum level** sits next to the toggle, since with the
  pad off that is the whole level of the instrument.
- **Hand up/down is still the filter**, because the strings no longer want that
  axis. That is a straight gain over the camera version, which had to park the
  filter to avoid every downstroke ending dark.
- If the chosen sound has a slow attack, the panel says so rather than quietly
  overriding it: a strum on a pad swells instead of snapping, and the sound is
  the player's choice to make.
- Chord latch and strum work together — latch a chord with your hand, then put
  that hand down and strum with the trackpad.

**Two-finger scroll needed different treatment from the drag.** A drag reports a
smooth stream of positions and each segment can sound the moment it arrives. A
trackpad scroll does not: it arrives in bursts, several strings deep. The first
version moved half the strings per wheel event and fired them together at full
force, and when a scroll ran off the end of the strings it teleported to the
other end and did the whole thing again — so a long scroll, or the tail of a
momentum scroll, lashed out on its own. Three changes:

- **Scaled travel.** A sweep takes about 560px of scrolling, roughly the travel
  a finger would make, instead of half the strings per event.
- **Queued strings.** Each string sounds at least 28ms after the one before it,
  so bursty events still come out as separate strings in order rather than a
  slap. It is a floor, not a fixed spacing: a slow scroll keeps its own wider
  timing. Notes that would fall more than 400ms behind the gesture are dropped,
  because someone scrolling hard can cross strings faster than a strum can sound
  them and a flurry seconds after the fingers stopped is worse than a strum that
  ends. `sequenceStrum` in `src/lib/strum.ts`, with tests.
- **No wrap.** A scroll that reaches the end of the strings stops there.

Two-finger scroll is attached by hand rather than through React's `onWheel`, so
it can be non-passive: without `preventDefault` the page scrolls out from under
you on every stroke. `src/lib/strum.ts` does the string maths for both this and
the producer-mode pad; `src/SimpleMode.tsx` holds the drag.

---

## Instruments, not only synths

The sound picker used to be one flat list of synth patches, which is fine until
you are looking for a guitar. It is grouped by family now:

| group | sounds |
|---|---|
| **Guitars** | Acoustic, Nylon, Electric, Rock, Muted |
| **Keys** | Piano, E-piano, Organ, Rock organ |
| **Strings & mallets** | Strings, Pizzicato strings, Harp, Marimba, Bell |
| **Synths** | Basic, Warm Pad, Pluck, Chiptune, Supersaw Lead, Sub Bass, Dream |

What separates one guitar from another here is not the waveform, which barely
matters: it is **how much pick you hear, how long the note holds, and how hard
the amp is being pushed**. An acoustic is mostly plectrum and is gone quickly; a
nylon is the same string played with a fingertip, so the transient drops and the
top comes off; a clean electric rings on where an acoustic has already died;
distortion compresses, so a rock guitar holds far longer and the pick matters
less because the amp is doing the shouting; a palm mute is all attack and no
ring. Tests hold those relationships, and hold that every guitar keeps an
instant attack — a guitar that swells cannot be strummed.

`Guitar` became a family of five, and the sound you picked is remembered by
name, so the plain name still resolves to the acoustic through an alias table
rather than dropping you back on Basic with no idea why.

None of these are samples. There is no sample library in a 4MB web app, so they
are the same subtractive voice pointed at the parts of a real instrument an ear
actually listens for: how fast the body decays, how much top is left when it
does, and above all **the attack transient**.

That last one is new. What tells an ear "guitar" or "piano" rather than "synth"
is mostly the first few milliseconds — the pick scraping the string, the hammer
hitting it — and oscillators with an envelope cannot make that sound. So
`attackNoise` gives a note its own short burst of noise, band-passed around the
third harmonic (contact noise sits *above* the note; a broad hiss reads as tape)
and gone in 55ms. It goes straight to the instrument filter with its own
envelope, so neither the amp envelope nor the per-note filter sweep can swallow
it, and it rides note velocity — a softly picked string is a softer pick, not the
same pick turned down afterwards. Bowed Strings set it to zero, having no contact
noise to speak of.

The field is optional, so a sound saved before instruments existed still loads.
Every preset belongs to exactly one picker group and a test holds that, so a new
sound cannot quietly go missing from the list.

`src/lib/presets.ts` is the catalogue; `Synth.attackTransient` in
`src/lib/synth.ts` plays the pick.

---

## Harmonies for what you sang

The harmonizer sings harmonies onto **the chord your hand is holding** — it has
to be told what the harmony is. That is fine while you are playing and useless
the moment you have sung something and do not know what you sang. So every loop
take has a **Harmonies** button that listens back to it and answers exactly that:
the key it is in, and a chord under each stretch of it.

It reads the take in one pass — pitch, notes, key, chords — and the answers land
on the controls that already exist rather than in a readout you have to act on
yourself: **use this key** sets the key and scale, **play these chords** fills
the progression box and switches to progression mode. Hold those with your hand
and the harmonizer has its targets.

- **The pitch detector is the harmonizer's own**, so the suggestions hear exactly
  what the live harmony hears.
- **The audio is averaged down to about 8kHz first.** Autocorrelation costs
  window times lag count, and at 48kHz that is tens of millions of operations per
  second of audio for information a voice does not carry. Averaging is also a
  crude low-pass, so what is thrown away is the part that would alias.
- **Frames become notes by joining what stays within a tolerance**, and a note
  has to last long enough to have been meant — shorter than that is the slide
  between two notes rather than a note. The pitch of a note is the **median** of
  its frames, not the mean: the scoop into a note and the fall out of it both
  drag an average off the pitch actually held.
- **The key comes from Krumhansl-Schmuckler profiles** correlated against how
  long the melody spends on each pitch class, rotated to all 24 keys. Confidence
  is how far the winner stood above the rest, and the card says "not certain"
  rather than sounding sure about a melody that fits a dozen keys.
- **Each chord is scored by how long the melody spends on its tones**, with the
  note a segment opens on counted twice: the ear takes the first note of a bar as
  the one the chord has to agree with. A stretch with nothing sung in it holds
  the previous chord instead of inventing one.

`src/lib/melody.ts`, tested against synthesised tones.

### How wide the stack sits

Every harmony voice sits in the octave nearest your voice, which is the tightest
and most vocal-sounding stack — and used to be the only one. The **Span** slider
opens it: the lowest voice drops, the highest rises, and the middle ones move
later than the edges, so the stack widens from the outside in rather than jumping
an octave all at once.

Displacement is in **whole octaves**, because a harmony voice has to stay a chord
tone and a chord tone moved by anything else is a different note. A voice that
would leave the range anything sounds musical in stays where it was: silence and
a dog whistle are both worse than a tight harmony. At zero the behaviour is
exactly what it always was, which a test holds.

---

## The wall

Record a take, record another over the top, and they play side by side.
Photobooth for performances: stack a harmony over yourself, or put four takes in
a grid and bounce the lot to one video.

**Export is a real bounce, not a screen capture.** The picture is a canvas
redrawn every frame from the playing elements; the sound is every take's audio
summed through the studio's own AudioContext. Both go into one MediaRecorder, so
what comes out is a single video with the grid and the full mix.

Layout details that are easy to get subtly wrong and are covered by tests: two
takes go **side by side, not stacked** (a webcam frame is landscape, and
stacking two leaves a tall thin wall with bars down both sides); a short last row
is **centred**, so three takes read as a row of two above one centred take;
frames are cropped to fill their cell rather than letterboxed, which is
`object-fit: cover` in numbers, because `drawImage` has no such thing.

Takes now land on the wall instead of downloading immediately. Downloading each
one straight away made stacking impossible — to put two side by side you would
have had to re-import files the app had just thrown away. Each take keeps its own
save button.

### Recording lives on the wall

Recording used to be a panel of its own above the wall, with a button labelled
**"Stop & download"** that had not downloaded anything since takes started
landing here. The one thing this surface is for — sing a part, sing another over
the top — was split across two boxes that never mentioned each other, and the
second take had nothing to sing along to.

It is one panel now, and it does the three things stacking actually needs:

- **A count-in.** Clicks scheduled on the audio clock, not by timer, so they land
  where a metronome would. "Press record, then find the downbeat" is how takes
  end up a beat apart.
- **The wall plays while you record.** The takes already up there run from the
  top as a guide, so the new part lands *on* the old ones rather than near them.
  The guide plays to the speakers, never through the studio's record bus, so it
  is not baked into the new take: the wall mixes every take on export, and
  hearing one twice is not stacking. Headphones keep it out of the microphone.
  The recorder starts *before* the guide, because whichever goes second starts
  late, and a guide a few milliseconds early is inaudible while a take a few
  milliseconds late is a stack that drifts.
- **Your live camera sits in the next empty cell**, so the grid you are about to
  make is the grid you are looking at. No camera, no cell — a denied camera would
  leave a black square promising a picture.

Per-take controls (hide, save, delete) are on the take itself and **stay
visible**: hiding them until the pointer happens to cross a cell means a take you
want rid of has no visible way to go. The list that used to hold them under the
wall said every label twice; hidden takes get a row of chips instead, which is
the one thing the list was actually needed for.

**Deleting a take takes two clicks.** The first arms it and the button turns into
"delete?", the second does it, and an armed delete goes cold after a few seconds
so a stray click cannot sit there waiting to catch the next one. A take cannot be
got back — the blob is dropped and its object URL revoked — and a two-step button
is the smallest thing that respects that without a modal nobody reads.

### Importing a video to produce over

The wall used to hold only what dice recorded, which meant everything it can do
— stacking, the guide playback, captions, the bounce — was unavailable to a clip
you already had. **Import video** puts a file on the wall as a take like any
other, and from there the whole surface applies: sing over it with the wall
playing as your guide, stack more takes beside it, caption it, bounce the grid
and the mix to one video.

- **The file is not copied or uploaded.** A take points at it through an object
  URL, so importing an hour of footage costs nothing until it plays — and, like
  everything else here, it never leaves the machine.
- **Mute keeps the picture and drops the sound**, which is how you produce over
  a clip: its video stays, the audio becomes yours. A muted take is left out of
  the bounce as well as the speakers, because browsers do not agree about
  whether a muted element silences its own source node, and a clip you muted
  turning up in the export is the kind of surprise you only find afterwards.
- **Imported clips are not mirrored.** Takes recorded here are flipped, because
  that is how you saw yourself while singing; a clip filmed somewhere else is
  not a mirror image of anybody.
- **A file that will not decode says so on its own cell** rather than sitting
  there as a black square. The check at the door is deliberately permissive —
  browsers disagree about codecs inside containers and `canPlayType` mostly
  answers "maybe", so anything claiming to be a video gets a try and failure is
  reported honestly.
- **The export button says how long the bounce will take.** It records in real
  time, and an imported clip can be minutes rather than the seconds a sung take
  runs to.

### Lyrics on the video

Type the words and they do two jobs: the line of the moment is the prompt you
sing from, and the same line is burnt into the picture when you bounce. Writing
them once for both is the point — a lyric you typed to read from is already the
caption you wanted.

Timing is deliberately forgiving. A line can carry a stamp (`0:12 hold me`,
`[1:04]`, `12s`), and any line without one is spread evenly through the gap it
sits in, so a plain block of lyrics works with no timing at all and you can pin
the one line that matters without stamping the rest. A blank line is a gap with
no caption over it. A stamp that runs backwards is pulled up to the line before
it rather than producing a cue that ends before it starts.

Cues need a length to spread across and the wall's length comes from its takes,
so before the first take the words are shown as a plain sheet to read from rather
than being timed against a guess. On export the caption shrinks until it fits and
carries an outline, because lyrics land on whatever the singer happened to be
wearing.

`src/lib/lyrics.ts` holds the timing, `src/lib/videowall.ts` the layout, and
`src/VideoWall.tsx` fronts both.

---

## Beatbox it

Beatbox a bar or two and dice writes it into the step sequencer, quantised to
sixteenths at your project tempo. It says back what it heard in musician's
language ("2 bars at your 96 BPM: kick on 1 and 3, snare on 2 and 4, hat on the
offbeats") and offers to put it in the grid, where it is editable, undoable and
saved like anything you drew by hand.

`src/lib/transcribe.ts`, in four inspectable stages: onsets, voices, grid,
pattern. `src/BeatboxChat.tsx` fronts it.

- **Onsets are detected per register** (low / mid / high) with a *local* median
  threshold, then merged. One broadband flux curve is dominated by whichever
  voice is loudest: beatbox a kick under a hat pattern and the kick contributes
  a few percent of the flux, so against one global threshold the part of the
  groove that matters most simply disappears.
- **The absolute floor comes from the quiet parts**, not from the loudest hit. A
  floor set at a fraction of the peak quietly discards every soft hit in a
  groove with real dynamics.
- **Beat one is the first hit**, not a searched-for downbeat. That is what a
  person means when they start beatboxing, and it is the only reading they can
  predict; searching every sub-position of a bar finds alignments that are
  numerically better and musically wrong.
- **Tempo is folded** into the range people count in. Any periodic signal
  correlates as well at half and double its tempo, and someone beatboxing
  eighths produces an onset stream whose strongest period is the eighth.
- **It transcribes kick, snare, hat and tom.** Clap and shaker are left for you:
  a beatboxed clap and a beatboxed snare are the same broadband noise burst in
  the same register, and guessing between them would just put hits in the wrong
  lane.
- **Analysis is sample-rate independent.** Windows are specified in seconds, not
  samples, and the analysed band stops at 10 kHz, below the Nyquist of every
  rate this handles. Both matter: a window fixed at 1024 samples is 46 ms at
  22 kHz but 21 ms at 48 kHz, barely one cycle of a kick, and a top band running
  to Nyquist makes every share depend on the rate.
- **Voices are told apart by tail and air, not centroid.** A snare rings for a
  moment and a hat is gone instantly, so the energy 30 to 120 ms after the
  transient separates them even though both are bright noise. A real mouth snare
  lands anywhere from 2 to 6 kHz depending on the person and the mic, so
  centroid alone is a poor discriminator.
- **Decay tails are suppressed.** A snare's noise tail and a kick's fundamental
  each produce a second, weaker flux peak 50 to 90 ms later, which would land on
  the grid as a phantom sixteenth after every backbeat. A wider merge window
  cannot fix this, because a genuine sixteenth at 220 BPM is only 68 ms away;
  what marks a tail is that it is much quieter than what produced it.
- **A bad take is one click to discard**, and the whole conversation clears.
  Discarding also removes your own message above it, so a thrown-away attempt
  leaves nothing to scroll past.

> These tests used to run only at 22 kHz, which no real recording uses. That hid
> a complete failure at 44.1 and 48 kHz, where every snare classified as a
> hi-hat. The fixtures now run at 48 kHz, with a cross-rate test so it cannot
> come back.

You can also point it at any track already in the project, which needs no
microphone permission at all: loop takes in play mode, mixer tracks in produce
mode.

It sits directly under the beat grid in both modes, because the grid is what it
fills. It used to be in produce mode's sidebar only, which meant that from play
mode, where the grid lives, there was no way to beatbox into it at all.

---

## The studio

Two modes, one at a time; switching unmounts the other, releasing its camera and
AudioContext.

**play** — the gesture instrument, with the beat transport under the chord
readout. Finger count picks the chord, one axis moves
the inversion, the other opens the filter, a pinch rides the volume. Sound
design, arpeggiator, drums, bass, a vocal harmonizer, and a looper that captures
2/3/4/6 phase-locked passes hands-free. The camera feed never leaves the device.

**produce** — the same instrument into a multitrack studio: record and import
loops, a beat transport with its own play/pause/stop under the camera, a
six-voice drum grid you can play from the keyboard or type out, a key-aware bass piano roll, a bar-by-bar
arrangement, vocal-stack take folders, coloured timeline regions with beat and
bar snapping, per-track tone and a shared room send, 40-step undo/redo,
IndexedDB autosave, and a stereo WAV bounce of exactly what you hear.

Recording captures the webcam plus the full audio mix: the raw mic is folded
into the recording bus only, so there is no latency echo, and the camera track is
muxed in. Takes land on **the wall**, where several can be stacked and bounced to
one video.

---

## The dice engine

Generated backing parts (beat / pad / bass / arp) come from an offline Python
audio engine wrapped in a small FastAPI service. It is a separate project that
dice does not modify; everything the user sees calls it the dice engine.

```bash
python3 -m uvicorn app.server:app --port 8000
```

- In dev, Vite proxies `/engine/*` to `http://localhost:8000`, so there is no
  CORS setup. In the desktop app, the shell does the same.
- Override with `VITE_DICE_ENGINE_URL`. `VITE_DEEJAI_URL` is still read as a
  fallback.
- Both the command box and the agent's `add_backing` tool go through one path,
  so they produce identical stems and identical errors.
- With the engine down, the instrument, the mixer, the agent, the beatbox
  transcriber and export all keep working. The panel says so and offers a retry.

---

## Layout

```
src/
  App.tsx              route between the site and the studio
  Landing.tsx          the website
  Studio.tsx           the studio shell and the play/produce toggle
  SimpleMode.tsx       the gesture instrument
  ProducerMode.tsx     the studio
  AgentPanel.tsx       the producer agent's face
  BeatboxChat.tsx      beatbox in, pattern out
  PadDeck.tsx          play the kit on the keyboard, or type the beat out
  StrumPad.tsx         hold a chord, sweep the strings
  VideoWall.tsx        stack takes side by side and bounce them to one video
  brand.ts             the palette, the type stack, the words
  BrandMarks.tsx       the die, the deck, the waveform, the sequencer grid
  lib/
    ears.ts            what the agent hears
    producerTools.ts   what the agent can do
    producerAgent.ts   the loop
    transcribe.ts      beatbox to drum pattern
    padkit.ts          keyboard pads, velocity and live quantising
    beatnotation.ts    typed beats to patterns, and back
    strum.ts           gesture to strummed notes
    videowall.ts       grid layout and cover-cropping for the wall
    producerMixer.ts   the multitrack mixer
    router.ts          the two places dice can be
    ...                music, gestures, mapping, synth, drums, arp, harmonizer
desktop/
  main.cjs             the Electron shell
  preload.cjs          deliberately almost empty
  serve.cjs            request mapping, tested without Electron
public/                MediaPipe WASM and hand model, vendored at install
```

## Brand

`src/brand.ts` is the single source. Brick red carries the hero pieces and every
call to action; a deep maroon carries the content and the whole studio; salmon
is the accent; bone is the line-work. Italic is the emphasis device, on the word
the line lands on. The wordmark keeps its period.

The wordmark is set in a heavy **system** grotesque rather than a webfont: the
app ships under a strict CSP with no third-party `font-src`, and the desktop
build loads from disk with no network at all, so a downloaded face would
silently fail in both.

## Tech

Vite + React + TypeScript (strict) + Tailwind. Hand tracking: MediaPipe Tasks
Vision. Audio: Web Audio API. Desktop: Electron. Best in Chrome or Edge; the
camera requires HTTPS or localhost.
