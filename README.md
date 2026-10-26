# dice

dice is a hand-gesture instrument and a vocal studio with a producer agent. The agent mixes your takes and explains each move. dice produces the takes you sing. It does not generate a song for you.

One build has two front doors. The website serves the marketing page at `/` and the studio at `/#/studio`. The desktop app wraps the same build in Electron.

## Features

- **Play mode.** The camera tracks your hand. Finger count picks the chord. One axis moves the inversion and the other opens the filter. A pinch sets the volume. Play mode also has an arpeggiator, a vocal harmonizer and a looper that records 2, 3, 4 or 6 phase-locked passes hands-free. The camera feed stays on the device.
- **Produce mode.** A multitrack studio with record and import, a six-voice drum grid, a bass piano roll, a bar-by-bar arrangement and vocal-stack take folders. It has 40-step undo and redo, IndexedDB autosave, and a stereo WAV bounce of the mix you hear.
- **Producer agent.** Each step, the agent measures every track and turns the result into numbered problems. It scores them under your goal, makes one move, and scores again. If the mix did not improve, it reverts the move. The whole run undoes with one button. It runs offline with no key and no upload. It can change level, pan, tone, the ambience send, mute and the channel EQ, and it can ask the engine for a backing part. It cannot delete a take or clear a project.
- **Channel EQ.** Each track has a low cut, a mid bell at 400 Hz, and a tone control that acts as the high cut.
- **Beatbox to grid.** Beatbox a bar or two and dice writes the pattern into the step sequencer, quantised to sixteenths at the project tempo. It transcribes kick, snare, hat and tom. It leaves clap and shaker to you.
- **Smart tempo.** After a beatbox take, dice offers to move the project tempo if your playing differs by more than 2 BPM. A reading needs at least four distinct hits and at least two seconds.
- **Drum level.** A kit fader sits in the beat panel in both modes. The bassline and the metronome are not on it: a bassline has its own level per lane, and a click you cannot hear is not doing its job.
- **Pads and typed beats.** Keys `A S D F G H` play the six drum lanes. Hold shift for an accent. You can also type a beat as text (`kick x...x...`). Velocity has three levels: accent (1), normal (0.72) and ghost (0.4).
- **Strum.** Hold a chord on keys 1 to 7 and sweep the trackpad across the strings. In play mode, your hand frets the chord on camera and the trackpad strums. The strum interaction comes from [laurie.fm](https://laurie.fm/).
- **Progression mode.** Type chords (`Am E F C`) and your fingers pick from that list. You can transpose the progression in place. A search finds a progression by name, feel or roman numerals (`blues`, `sad`, `ii7`) and writes it in your key. It holds 24 common progressions offline. It does not look up the chords to a particular recording, which would mean sending the search to someone's server. **Strum the progression** plays those chords as a guitar against the beat, one chord to the bar, with six patterns from a stroke on each beat to sixteenth pushes. Down strokes run low string to high and up strokes run back, which is most of why a strummed guitar sounds like one.
- **Instruments.** Guitars, keys, strings, brass, mallets, synths. None are samples. Each is a subtractive voice with a short attack transient. The chord voice sits in the Performance panel, so a gestured chord can sound like a piano without going looking for it.
- **Harmonies for what you sang.** A take can suggest its key and a chord under each stretch. The key comes from Krumhansl-Schmuckler profiles.
- **The wall.** Stack video takes in a grid, record over them with a count-in, add lyrics as captions, and bounce the grid and the full mix to one video. You can import a video file to produce over. Imported files are not uploaded. Each take has a level in the mix panel. Takes are gain-staged by how many are playing and pass through a limiter, so a stack does not clip, and the guide runs quieter while you record over it.
- **Share song.** A link holds the tempo, key, chords, beat, basslines, lyrics and voice. The data sits after the `#`, so it is not sent to a server. Audio is never put in the link.
- **Projects.** Save, open, rename and delete named projects from a shelf in produce mode.
- **Bring in a song.** In progression mode, a lyrics search asks [LRCLIB](https://lrclib.net), an open database with no key and no account, and drops the words into the notepad. Where the database has timings, they arrive as stamps the wall can caption from. This is the only part of dice that sends anything anywhere, so it is off until you switch it on, and the panel says what it sends. Chords for a particular song cannot be looked up: the sites that hold them are licensed or would have to be scraped. Paste a sheet instead, chords above the words or in `[brackets]`, and dice reads the progression into the chord box and the words into the pad.
- **Lyrics.** A notepad sits beside the camera in play mode. It holds the same sheet the wall uses, so what you write while playing is already the prompt you sing from and the caption burnt into the bounce. A button writes the chord you are holding in at the cursor. The sheet stays in this browser and travels in a shared song link.
- **Colour.** The studio ships dark red. The picker in the header changes the hue of the whole palette, not the background alone, since every contrast in the interface comes from one ladder of that red. Each colour keeps the brightness it had, so the ink stays readable; rotating hue while keeping HSL lightness does not hold, because a yellow ground at the maroon's lightness is much brighter and measured 2.5 to 1 against the text where the red measures 7.9. Grounds that would still come out too light are darkened until they clear 4.6 to 1.

## Run it

```bash
git clone https://github.com/saanviiyer/dice
cd dice
npm install
npm run dev          # site at /, studio at /#/studio
npm test             # 746 tests (vitest)
npm run build        # tsc -b and vite build, output in dist/
```

Use Chrome or Edge. The camera needs HTTPS or localhost.

Nothing leaves the machine except the optional lyrics search, which is off by default and sends only what you type into it.

### Desktop app

```bash
npm run desktop          # build, then open in Electron
npm run desktop:build    # package to release/dice-<platform>-<arch>/
```

The desktop shell serves the app over a custom `dice://` scheme that is registered as secure. The camera and microphone need a secure context. The shell also proxies `/engine/*` to the audio engine. The build is unsigned. On macOS, right-click the app and choose Open the first time.

### Deploy

`netlify.toml` and `vercel.json` build with `npm run build` and publish `dist/`. Both set a strict Content-Security-Policy and allow the camera and microphone only for the site itself.

### The dice engine

Generated backing parts (beat, pad, bass, arp) come from a separate Python audio service. This repo does not include it. Start it on port 8000:

```bash
python3 -m uvicorn app.server:app --port 8000
```

In dev, Vite proxies `/engine/*` to `http://localhost:8000`. If the engine is down, the instrument, mixer, agent, beatbox transcriber and export still work.

## Environment variables

All are optional. The app runs without any of them.

| Name | Purpose |
|---|---|
| `VITE_DICE_ENGINE_URL` | Base URL of the dice engine. Default is the `/engine` dev proxy. |
| `VITE_DEEJAI_URL` | Old name for the engine URL, read as a fallback. |
| `VITE_DICE_AGENT_URL` | Endpoint for a model-backed planner for the producer agent. Unset means the offline planner. |
| `DICE_ENGINE_URL` | Engine URL for the desktop shell. Default is `http://localhost:8000`. |
| `DICE_PLATFORM`, `DICE_ARCH` | Target platform and architecture for `desktop:build`. Default is the current machine. |

See `.env.example`.

## Layout

```
src/
  App.tsx, Landing.tsx, Studio.tsx   routing, website, studio shell
  SimpleMode.tsx                     play mode (gesture instrument)
  ProducerMode.tsx                   produce mode (multitrack studio)
  AgentPanel.tsx                     producer agent UI
  BeatboxChat.tsx, PadDeck.tsx       beatbox input, pads and typed beats
  StrumPad.tsx, VideoWall.tsx        strum surface, video wall
  lib/                               audio, agent, transcription and music logic, with tests
desktop/                             Electron shell (main, preload, request mapping)
scripts/                             install-time fetch scripts and desktop packager
public/dice.svg                      app icon source
```

## Files not in the repo

The postinstall scripts fetch two things. `scripts/copy-wasm.mjs` copies the MediaPipe WASM files into `public/wasm`. `scripts/fetch-model.mjs` downloads `public/models/hand_landmarker.task`. If either step fails, the app loads them from the CDN at runtime. The desktop packaging output in `release/` and `build/` (including icons) is also not committed.

## Tech

Vite, React, TypeScript (strict) and Tailwind. Hand tracking uses MediaPipe Tasks Vision. Audio uses the Web Audio API. The desktop app uses Electron.
