import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { createHandLandmarker } from "./lib/handLandmarker";
import { readHand, type Landmark, type HandPose } from "./lib/gestures";
import {
  mapHandsToSelection,
  type Selection,
  type PlayMode,
} from "./lib/mapping";
import { sequenceStrum, strum, stringVoicing } from "./lib/strum";
import {
  NOTE_NAMES,
  midiToFreq,
  midiToName,
  keyName,
  parseProgression,
  voiceParsed,
  progressionAccidental,
  progressionRoot,
  semitonesToRoot,
  spellPitchClass,
  transposeProgression,
  SCALES,
  SCALE_LABELS,
  type ScaleName,
  type ChordExtension,
} from "./lib/music";
import { Synth, type NoteHandle } from "./lib/synth";
import {
  PRESET_GROUPS,
  PRESET_NAMES,
  getPreset,
  resolvePresetName,
  defaultSound,
  cloneSound,
  DEFAULT_PRESET,
  type SoundConfig,
  type Waveform,
  type LfoTarget,
} from "./lib/presets";
import {
  Arpeggiator,
  type ArpPattern,
  type ArpDivision,
} from "./lib/arp";
import {
  BPM_MAX,
  BPM_MIN,
  CUSTOM_PATTERN,
  DrumMachine,
  clampBpm,
  emptyPattern,
  resolvePattern,
  type DrumPattern,
  type DrumPatternChoice,
} from "./lib/drums";
import { bassPatternFromPreset, bassStackFromPattern, type BassLane } from "./lib/bass";
import { LandmarkSmoother } from "./lib/smoothing";
import { Harmonizer } from "./lib/harmonizer";
import {
  BEATS_PER_BAR,
  VocalLooper,
  sourcesForSelection,
  type RecordSource,
  type LoopTrackState,
  type LooperCycleProgress,
} from "./lib/vocalLooper";
import { InputMeter } from "./lib/meter";
import { InputLevelMeter } from "./InputLevelMeter";
import BeatTransport from "./BeatTransport";
import BeatboxChat from "./BeatboxChat";
import LyricPad from "./LyricPad";
import Timeline from "./Timeline";
import type { MixerTrackState } from "./lib/producerMixer";
import { secondsPerBar } from "./lib/transport";
import VideoWall from "./VideoWall";
import { MAX_TAKES, importedLabel, takeLabel, type VideoTake } from "./lib/videowall";
import { analyzeMelody, type MelodyAnalysis } from "./lib/melody";
import { progressionInKey, searchProgressions } from "./lib/progressions";
import {
  STRUM_PATTERNS,
  chordIndexAt,
  strokeAt,
  strokeSeconds,
  strokeSweep,
} from "./lib/strumpattern";
import {
  SONG_LINK_COMFORTABLE_CHARS,
  songFromUrl,
  songLinkUrl,
  type SongLink,
} from "./lib/songlink";
import { drawHand, drawStrings } from "./lib/draw";
import { Legend } from "./Legend";

/** Clip colours, cycled: neighbouring lanes have to be told apart at a glance. */
const TAKE_COLORS = ["#efaf9f", "#ff5a3d", "#d5d0cb", "#cf8f7e"];

/** Strings under the hand in strum mode, and how long a strummed one rings. */
const STRUM_STRINGS = 6;
const STRUM_GATE = 1.4;
/** A gap this long in a two-finger scroll starts a new stroke. */
const SCROLL_STROKE_GAP_MS = 250;
/**
 * How much scrolling makes one end-to-end sweep, in wheel pixels.
 *
 * The old handler moved half the strings per wheel event, so a single flick of
 * two fingers crossed three strings at once and fired them almost together.
 * Scaling it like this makes a scroll travel across the strings at about the
 * speed a finger does.
 */
const SCROLL_FULL_SWEEP_PX = 560;
/**
 * The gap between strings on a scrolled strum.
 *
 * A trackpad reports scrolling in bursts, not continuously, so several strings
 * can be crossed by one event and would otherwise sound as a block. Spacing them
 * is what makes a scroll read as a strum - six separate strings, one after
 * another - rather than a chord with a smear on the front.
 */
const SCROLL_STRING_GAP_SEC = 0.028;
/** Never queue a scrolled strum further ahead than this. */
const SCROLL_MAX_LAG_SEC = 0.4;
/** How long a string stays lit after it sounds. */
const STRUM_FLASH_MS = 220;

const LS_LYRICS = "dice.lyrics.v1";

function loadLyrics(): string {
  try {
    return localStorage.getItem(LS_LYRICS) ?? "";
  } catch {
    return "";
  }
}

const LS_SOUND = "dice.sound.v1";
const LS_PRESET = "dice.preset.v1";

function loadSound(): SoundConfig {
  try {
    const raw = localStorage.getItem(LS_SOUND);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && p.env && p.fx && p.lfo) return p as SoundConfig;
    }
  } catch {
    /* ignore */
  }
  return defaultSound();
}

function loadPreset(): string {
  try {
    const stored = localStorage.getItem(LS_PRESET);
    // Through the alias table, so a sound picked before a rename comes back as
    // the sound it was rather than silently reverting to the default.
    return stored ? resolvePresetName(stored) : DEFAULT_PRESET;
  } catch {
    return DEFAULT_PRESET;
  }
}

function Range({
  label,
  value,
  min,
  max,
  step,
  onChange,
  fmt,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  fmt?: (v: number) => string;
  disabled?: boolean;
}) {
  return (
    <label className={`mb-2 block text-sm ${disabled ? "opacity-50" : ""}`}>
      <span className="mb-1 flex justify-between text-white/70">
        <span>{label}</span>
        <span className="text-white/55">{fmt ? fmt(value) : value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
    </label>
  );
}


/** Nearest note name (e.g. "C4") for a frequency in Hz. */
function freqToNoteLabel(hz: number): string {
  if (!hz || hz <= 0) return "-";
  const midi = Math.round(12 * Math.log2(hz / 440) + 69);
  return midiToName(midi);
}

type Phase =
  | "idle"
  | "loading-model"
  | "requesting-camera"
  | "running"
  | "camera-denied"
  | "error";

// Hand overlay colours: the playing hand in salmon, the modifier hand in bone.
const HAND_COLORS = ["#efaf9f", "#d5d0cb"];

// dice's play mode: the full gesture instrument. Carried over from the
// handsynth project and rendered as one of dice's two top-level modes.
export default function SimpleMode() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const synthRef = useRef<Synth>(new Synth());
  const arpRef = useRef<Arpeggiator | null>(null);
  const drumsRef = useRef<DrumMachine | null>(null);
  const harmonizerRef = useRef<Harmonizer | null>(null);
  // Frequencies of the chord the user is currently holding, updated each frame
  // so the harmonizer can lock its voices onto the held chord's tones.
  const heldChordFreqsRef = useRef<number[]>([]);
  const micStreamRef = useRef<MediaStream | null>(null);
  // The webcam stream, kept so Record can capture a video of the performer.
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastVideoTimeRef = useRef<number>(-1);

  // Per-hand landmark smoothers (index 0/1), latch + record state.
  const smoothersRef = useRef<LandmarkSmoother[]>([
    new LandmarkSmoother(),
    new LandmarkSmoother(),
  ]);
  const latchedChordRef = useRef<{ notes: number[]; freqs: number[] } | null>(
    null
  );
  const latchedCtrlRef = useRef<{ cutoff: number; expr: number }>({
    cutoff: 4000,
    expr: 0.8,
  });
  const recorderRef = useRef<MediaRecorder | null>(null);
  /** Recorded video takes, shown together on the wall. */
  const [takes, setTakes] = useState<VideoTake[]>([]);
  // One lyric sheet for the wall, not one per take: the words belong to the
  // song being stacked, and the video that comes out is one video.
  // Written beside the camera, used by the wall as a prompt and a caption.
  // One sheet, so there is never a question about which words the video has.
  const [lyrics, setLyrics] = useState<string>(loadLyrics);
  // The link for this song, once someone asks for one, and what to say about it.
  const [shareLink, setShareLink] = useState<string>("");
  const [shareNote, setShareNote] = useState<string>("");
  /** What was typed into the chord search, if anything. */
  const [chordQuery, setChordQuery] = useState<string>("");
  /** Play the progression as a strummed guitar, in time with the beat. */
  const [autoStrum, setAutoStrum] = useState<boolean>(false);
  const [strumPatternId, setStrumPatternId] = useState<string>(STRUM_PATTERNS[0].id);
  const [songName, setSongName] = useState<string>("");
  const nextTakeId = useRef(1);
  const chunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordStartRef = useRef<number>(0);
  const looperRef = useRef<VocalLooper | null>(null);
  const inputMeterRef = useRef<InputMeter | null>(null);
  const [micReady, setMicReady] = useState<boolean>(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string>("");

  // Musical controls
  const [mode, setMode] = useState<PlayMode>("diatonic");
  const [tonic, setTonic] = useState<number>(0); // C
  const [scale, setScale] = useState<ScaleName>("major");
  const [octave, setOctave] = useState<number>(3);
  const [extension, setExtension] = useState<ChordExtension>("triad");
  const [progressionText, setProgressionText] = useState<string>("Am E F C");

  // Synth controls
  const [sound, setSound] = useState<SoundConfig>(loadSound);
  const [presetName, setPresetName] = useState<string>(loadPreset);
  const [volume, setVolume] = useState<number>(0.5);
  const [twoHand, setTwoHand] = useState<boolean>(false);

  // Arpeggiator controls
  const [arpOn, setArpOn] = useState<boolean>(false);
  const [arpPattern, setArpPattern] = useState<ArpPattern>("up");
  const [arpDivision, setArpDivision] = useState<ArpDivision>("1/8");
  const [arpBpm, setArpBpm] = useState<number>(120);
  const [arpOctaves, setArpOctaves] = useState<number>(1);
  const [arpGate, setArpGate] = useState<number>(0.6);

  // Drum machine + metronome
  const [drumsOn, setDrumsOn] = useState<boolean>(false);
  const [drumPattern, setDrumPattern] =
    useState<DrumPatternChoice>("Four-on-floor");
  const [customBeat, setCustomBeat] = useState<DrumPattern>(() => emptyPattern(1));
  const [bassOn, setBassOn] = useState<boolean>(false);
  const [bassLanes, setBassLanes] = useState<BassLane[]>(() =>
    bassStackFromPattern(bassPatternFromPreset("Root pulse", 0, 1))
  );
  const [kickOn, setKickOn] = useState<boolean>(true);
  const [snareOn, setSnareOn] = useState<boolean>(true);
  const [clapOn, setClapOn] = useState<boolean>(true);
  const [hatOn, setHatOn] = useState<boolean>(true);
  const [tomOn, setTomOn] = useState<boolean>(true);
  const [shakerOn, setShakerOn] = useState<boolean>(true);
  const [metronomeOn, setMetronomeOn] = useState<boolean>(false);
  /** Held mid-bar rather than stopped, so resuming keeps the position. */
  const [beatPaused, setBeatPaused] = useState<boolean>(false);
  const wasPausedRef = useRef(false);

  // Playability
  const [smoothing, setSmoothing] = useState<number>(0.4);
  const [latchOn, setLatchOn] = useState<boolean>(false);
  // Strum mode: the fingers fret the chord and the hand's up-and-down movement
  // sounds it, one string at a time, the way a guitar is played.
  const [strumOn, setStrumOn] = useState<boolean>(false);
  // How hard the strings are hit. The held chord is silent in strum mode, so
  // this is the whole level of the instrument while strumming.
  const [strumLevel, setStrumLevel] = useState<number>(0.85);
  // What the hand is fretting right now, for the trackpad to strum. Held in a
  // ref because the pointer handlers run between animation frames.
  const strumChordRef = useRef<number[]>([]);
  /** The progression the auto-strummer is walking through, voiced. */
  const autoStrumChordsRef = useRef<number[][]>([]);
  const strumSurfaceRef = useRef<HTMLDivElement | null>(null);
  const strumGestureRef = useRef({ pos: 0.5, time: 0, down: false });
  /**
   * The chord this stroke is playing, frozen when the stroke starts.
   *
   * The hand is still tracking while you strum: a finger straightening, or the
   * hand drifting across the inversion boundary, re-voices the chord mid-sweep
   * and the second half of the stroke belongs to a different chord than the
   * first. One stroke, one chord.
   */
  const strokeChordRef = useRef<number[]>([]);
  /** What each string is currently ringing, so re-picking it damps it first. */
  const strumStringsRef = useRef<(NoteHandle | null)[]>([]);
  /** Audio-clock time of the last string a sequenced strum scheduled. */
  const strumNextAtRef = useRef<number>(0);
  /**
   * The name of the chord being fretted, watched for changes.
   *
   * The name rather than the notes, because the notes also change when the hand
   * drifts across an inversion boundary, and re-voicing the same chord is not a
   * new shape: damping on that would chop the strings every time the hand moved.
   */
  const strumChordNameRef = useRef<string>("");
  // When each string last sounded, so the overlay can light it. Seeing the
  // string flash is how you learn where the strings are.
  const strumFlashRef = useRef<number[]>([]);

  // Recording
  const [recording, setRecording] = useState<boolean>(false);
  const [recordElapsed, setRecordElapsed] = useState<number>(0);
  const [recordError, setRecordError] = useState<string>("");

  // Harmonizer controls
  const [harmonizerOn, setHarmonizerOn] = useState<boolean>(false);
  const [micError, setMicError] = useState<string>("");
  const [harmonizerLevel, setHarmonizerLevel] = useState<number>(1.0);
  // Fully wet by default: the raw voice is captured into the recording
  // separately, so the harmonizer adds harmonies on top rather than doubling it.
  const [harmonizerDryWet, setHarmonizerDryWet] = useState<number>(1.0);
  const [harmonizerVoices, setHarmonizerVoices] = useState<number>(4);
  // How far the harmony stack opens out around the voice. 0 is the tight stack
  // the harmonizer has always made; up from there it spreads by whole octaves.
  const [harmonizerSpan, setHarmonizerSpan] = useState<number>(0);
  // Live readout of the detected sung pitch (Hz), for on-screen feedback.
  const [sungPitch, setSungPitch] = useState<number | null>(null);

  // Vocal looper
  const [loopSource, setLoopSource] = useState<RecordSource>("mic");
  const [loopBars, setLoopBars] = useState<number>(2);
  const [loopFree, setLoopFree] = useState<boolean>(false);
  const [loopCountIn, setLoopCountIn] = useState<boolean>(true);
  const [loopCycleOn, setLoopCycleOn] = useState<boolean>(true);
  const [loopStackTakes, setLoopStackTakes] = useState<number>(3);
  const [loopCycleProgress, setLoopCycleProgress] =
    useState<LooperCycleProgress | null>(null);
  const [loopRecording, setLoopRecording] = useState<boolean>(false);
  const [loopPlaying, setLoopPlaying] = useState<boolean>(false);
  const [loopTracks, setLoopTracks] = useState<LoopTrackState[]>([]);
  // The loop's own length and playhead, for the timeline. The length is fixed
  // by the first take, so it is read from the looper rather than from the bars
  // control, which only configures the next recording.
  const [loopDurSec, setLoopDurSec] = useState<number>(0);
  const [loopPos, setLoopPos] = useState<number>(0);
  const [loopError, setLoopError] = useState<string>("");
  // What dice heard in a sung take, and which take it was listening to.
  const [melody, setMelody] = useState<{ id: number; analysis: MelodyAnalysis } | null>(null);
  const [exportCycles, setExportCycles] = useState<number>(1);

  // Live readout
  const [selection, setSelection] = useState<Selection | null>(null);
  const [handCount, setHandCount] = useState<number>(0);

  // Parse the progression text into slots (labels + validity + parsed chords).
  const progressionSlots = useMemo(
    () => parseProgression(progressionText, octave),
    [progressionText, octave]
  );

  // The progression's own root and spelling, for the transpose controls. Both
  // are read back out of the text every time rather than tracked alongside it,
  // because the text is the progression: typing over it has to move the
  // controls, not leave them describing a line that is no longer there.
  const progressionRootPc = useMemo(() => progressionRoot(progressionText), [progressionText]);
  const progressionSpelling = useMemo(
    () => progressionAccidental(progressionText),
    [progressionText]
  );
  /**
   * What the chord search has to offer for what was typed.
   *
   * Written out in the key already chosen, because a progression in the wrong
   * key is one more thing to fix rather than an answer.
   */
  /**
   * The progression, voiced, for the auto-strummer.
   *
   * Held in a ref because the scheduler runs between renders, and rebuilt from
   * the same parsed slots the hand plays from, so what is strummed is what the
   * fingers would have picked.
   */
  useEffect(() => {
    autoStrumChordsRef.current = progressionSlots
      .map((slot) => (slot.chord ? voiceParsed(slot.chord, octave, 0).notes : []))
      .filter((notes) => notes.length > 0);
  }, [progressionSlots, octave]);

  const chordMatches = useMemo(
    () =>
      searchProgressions(chordQuery, 5).map(({ progression }) => ({
        progression,
        text: progressionInKey(progression, tonic),
      })),
    [chordQuery, tonic]
  );

  const transpose = useCallback(
    (semitones: number) =>
      setProgressionText((text) => transposeProgression(text, semitones)),
    []
  );

  // Latest values for the rAF loop without re-subscribing every render.
  const cfgRef = useRef({
    mode,
    tonic,
    scale,
    octave,
    extension,
    twoHand,
    arpOn,
    latchOn,
    strumOn,
    strumLevel,
    bpm: arpBpm,
    progression: progressionSlots.map((s) => s.chord),
  });
  useEffect(() => {
    cfgRef.current = {
      mode,
      tonic,
      scale,
      octave,
      extension,
      twoHand,
      arpOn,
      latchOn,
      strumOn,
      strumLevel,
      bpm: arpBpm,
      progression: progressionSlots.map((s) => s.chord),
    };
  }, [
    mode,
    tonic,
    scale,
    octave,
    extension,
    twoHand,
    arpOn,
    latchOn,
    strumOn,
    strumLevel,
    arpBpm,
    progressionSlots,
  ]);

  // A notepad that forgets what was written is not a notepad.
  useEffect(() => {
    try {
      if (lyrics) localStorage.setItem(LS_LYRICS, lyrics);
      else localStorage.removeItem(LS_LYRICS);
    } catch {
      /* the words are still on the screen */
    }
  }, [lyrics]);

  // Push smoothing amount into the per-hand landmark smoothers.
  useEffect(() => {
    for (const s of smoothersRef.current) s.setAmount(smoothing);
  }, [smoothing]);

  // When latch turns off, drop the held chord.
  useEffect(() => {
    if (!latchOn) latchedChordRef.current = null;
  }, [latchOn]);

  // Apply the sound config to the synth and persist it.
  useEffect(() => {
    synthRef.current.applyConfig(sound);
    try {
      localStorage.setItem(LS_SOUND, JSON.stringify(sound));
    } catch {
      /* ignore */
    }
  }, [sound]);
  useEffect(() => {
    try {
      localStorage.setItem(LS_PRESET, presetName);
    } catch {
      /* ignore */
    }
  }, [presetName]);
  useEffect(() => {
    synthRef.current.setMasterVolume(volume);
  }, [volume]);

  // Sound-config editing helpers.
  // Sounding drum step for the sequencer playhead; stable so the sequencer's
  // rAF loop survives re-renders.
  /** Loop takes the beatbox transcriber can read, as plain metadata. */
  const beatboxTracks = useCallback(
    () =>
      loopTracks.map((t) => ({
        id: t.id,
        name: t.name,
        role: t.source,
        volume: t.volume,
        pan: 0,
        tone: 1,
        lowCut: 20,
        space: 0,
        muted: t.muted,
      })),
    [loopTracks]
  );

  const beatboxAudio = useCallback(
    (id: number) => looperRef.current?.getTrackAudio(id) ?? null,
    []
  );

  // Playhead for the timeline, polled ~20fps while the stack plays. It gets its
  // own loop rather than riding the camera's draw loop, because the takes keep
  // playing whether or not the camera is up.
  useEffect(() => {
    if (!loopPlaying) {
      setLoopPos(0);
      return;
    }
    const timer = setInterval(() => setLoopPos(looperRef.current?.positionSec ?? 0), 50);
    return () => clearInterval(timer);
  }, [loopPlaying]);

  /**
   * Loop takes as timeline clips.
   *
   * The timeline is the producer mode's component and it reads mixer tracks, so
   * a take is dressed as one here rather than forking the view. Everything the
   * mixer has and the looper does not - pan, EQ, sends - is left at its neutral
   * value, because play mode has no controls for them and a clip does not draw
   * them anyway.
   */
  const timelineTracks = useMemo<MixerTrackState[]>(
    () =>
      loopTracks.map((t, i) => ({
        id: t.id,
        name: t.name,
        kind: "loop" as const,
        role: t.source,
        source: t.source,
        muted: t.muted,
        solo: t.solo,
        volume: t.volume,
        pan: 0,
        tone: 1,
        lowCut: 20,
        midGain: 0,
        space: 0,
        color: TAKE_COLORS[i % TAKE_COLORS.length],
        favorite: false,
        durationSec: t.durationSec,
        armed: false,
        offsetSec: t.offsetSec,
      })),
    [loopTracks]
  );

  const getTakePeaks = useCallback(
    (id: number, buckets: number) => looperRef.current?.getPeaks(id, buckets) ?? null,
    []
  );

  // The bars control writes the length of the NEXT recording; once a take has
  // fixed the loop, the ruler has to follow the loop that is actually running.
  const timelineBars = useMemo(() => {
    if (loopDurSec <= 0) return loopBars;
    return Math.max(1, Math.round(loopDurSec / secondsPerBar(arpBpm, BEATS_PER_BAR)));
  }, [loopDurSec, loopBars, arpBpm]);

  const beatboxContext = useCallback(
    () => synthRef.current.getContext() as BaseAudioContext | null,
    []
  );

  const beatState: "playing" | "paused" | "stopped" =
    !drumsOn && !bassOn ? "stopped" : beatPaused ? "paused" : "playing";

  const playBeat = useCallback(() => {
    setBeatPaused(false);
    setDrumsOn(true);
  }, []);
  const pauseBeat = useCallback(() => setBeatPaused(true), []);
  const stopBeat = useCallback(() => {
    setBeatPaused(false);
    setDrumsOn(false);
    setBassOn(false);
  }, []);

  /**
   * One segment of a trackpad sweep: sound whatever strings it crossed.
   *
   * The timing between the notes is the gesture, not a "strum speed" setting -
   * flick it and it snaps, drag it and it arpeggiates - so each segment is
   * spread across the time that movement actually took.
   */
  /**
   * The progression, strummed, against the transport.
   *
   * The trackpad strum takes its rhythm from your hand, which is the best way
   * to play a chord and no use when you want to hear what a progression sounds
   * like. This is the other hand: a written pattern, one chord to the bar,
   * scheduled on the step the drums are scheduling against so the guitar lands
   * with the kick instead of near it.
   */
  useEffect(() => {
    const dm = drumsRef.current;
    if (!dm) return;
    if (!autoStrum) {
      dm.setStepListener(null);
      return;
    }
    const pattern =
      STRUM_PATTERNS.find((p) => p.id === strumPatternId) ?? STRUM_PATTERNS[0];

    dm.setStepListener((step, time) => {
      const chords = autoStrumChordsRef.current;
      if (chords.length === 0) return;
      const stroke = strokeAt(pattern, step);
      if (!stroke) return;
      const chord = chords[chordIndexAt(step, chords.length)];
      if (!chord || chord.length === 0) return;

      const sweep = strokeSweep(stroke.direction);
      const seconds = strokeSeconds(cfgRef.current.bpm, stroke.direction);
      const notes = strum({
        chord,
        strings: STRUM_STRINGS,
        from: sweep.from,
        to: sweep.to,
        seconds,
      });
      const synth = synthRef.current;
      const level = cfgRef.current.strumLevel * stroke.velocity;
      const order = stringVoicing(chord, STRUM_STRINGS);
      for (const n of notes) {
        const at = time + n.at;
        const idx = order.indexOf(n.midi);
        if (idx >= 0) strumStringsRef.current[idx]?.stop(at);
        const handle = synth.triggerNote(
          midiToFreq(n.midi),
          at,
          STRUM_GATE,
          n.velocity * level
        );
        if (idx >= 0) strumStringsRef.current[idx] = handle;
      }
    });
    return () => dm.setStepListener(null);
  }, [autoStrum, strumPatternId]);

  /** Stop every ringing string, the way a palm across them would. */
  const dampStrings = useCallback((at?: number) => {
    const when = at ?? synthRef.current.getContext()?.currentTime ?? 0;
    for (const handle of strumStringsRef.current) handle?.stop(when);
    strumStringsRef.current = [];
  }, []);

  /** Take the chord the hand is holding as this stroke's chord. */
  const beginStroke = useCallback((pos: number) => {
    strokeChordRef.current = strumChordRef.current;
    strumGestureRef.current = { pos, time: performance.now(), down: true };
  }, []);

  const strumSweep = useCallback(
    (pos: number, opts: { minGap?: number; sequence?: boolean } = {}) => {
    const chord = strokeChordRef.current;
    if (chord.length === 0) return;
    const synth = synthRef.current;
    const g = strumGestureRef.current;
    const t = performance.now();
    // Clamped: a burst of events a millisecond apart would read as an
    // impossibly fast sweep and hit every string at full force, and a long
    // pause would stretch one segment across a quarter of a second.
    const elapsed = Math.min(0.25, Math.max(0.008, (t - g.time) / 1000));
    const from = g.pos;
    g.pos = pos;
    g.time = t;

    const played = strum({
      chord,
      strings: STRUM_STRINGS,
      from,
      to: pos,
      seconds: elapsed,
      minGap: opts.minGap,
    });
    if (played.length === 0) return;
    const base = synth.getContext()?.currentTime ?? 0;
    const order = stringVoicing(chord, STRUM_STRINGS);
    const level = cfgRef.current.strumLevel;

    // A drag reports positions smoothly enough to play each segment as it
    // arrives. A scroll arrives in bursts and has to queue, or the second burst
    // lands on top of the first. See sequenceStrum.
    const plays = opts.sequence
      ? (() => {
          const seq = sequenceStrum(
            played,
            base,
            strumNextAtRef.current,
            opts.minGap ?? SCROLL_STRING_GAP_SEC,
            SCROLL_MAX_LAG_SEC
          );
          strumNextAtRef.current = seq.after;
          return seq.plays;
        })()
      : played.map((note) => ({ note, at: base + note.at }));

    for (const { note, at } of plays) {
      const idx = order.indexOf(note.midi);
      // A string can only ring once. Picking one that is still sounding damps
      // it first, which is what stops a fast strum turning into a pile-up.
      if (idx >= 0) strumStringsRef.current[idx]?.stop(at);
      const handle = synth.triggerNote(
        midiToFreq(note.midi),
        at,
        STRUM_GATE,
        note.velocity * level
      );
      if (idx >= 0) {
        strumStringsRef.current[idx] = handle;
        // Light the string when it sounds, not when it was scheduled.
        strumFlashRef.current[idx] = t + (at - base) * 1000;
      }
    }
  },
    []
  );

  const strumPosFromEvent = (el: HTMLElement, clientY: number) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientY - r.top) / r.height));
  };

  /**
   * Two-finger scroll, the other trackpad strum.
   *
   * A trackpad does not report scrolling continuously the way a drag reports a
   * pointer: it arrives in bursts, and every burst used to move half the strings
   * at once and fire them together at full force, which is a slap rather than a
   * strum. Three things fix that. The scroll is scaled so a sweep takes about
   * the travel a finger would take; the strings it crosses are queued one after
   * another with a real gap between them, so bursty events still come out as
   * separate strings in order; and a scroll that runs off the end of the strings
   * simply stops, rather than teleporting to the other end and firing all six
   * again - which is what made a long scroll, or the tail of a momentum scroll,
   * lash out on its own.
   *
   * Attached by hand rather than through React's onWheel so it can be
   * non-passive: without preventDefault the page scrolls out from under you on
   * every stroke.
   */
  useEffect(() => {
    const el = strumSurfaceRef.current;
    if (!el || !strumOn) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const g = strumGestureRef.current;
      const now = performance.now();
      // A scroll has no pointerdown to start it, so a pause is what separates
      // one stroke from the next: after a gap, this is a new stroke, it takes
      // the chord the hand is holding now, and it starts from the edge the
      // scroll is coming from rather than wherever the last one stopped.
      if (now - g.time > SCROLL_STROKE_GAP_MS) {
        strokeChordRef.current = strumChordRef.current;
        g.pos = event.deltaY >= 0 ? 0 : 1;
        strumNextAtRef.current = synthRef.current.getContext()?.currentTime ?? 0;
      }
      // Wheels that report lines or pages instead of pixels (mice, mostly).
      const px =
        event.deltaMode === 1
          ? event.deltaY * 16
          : event.deltaMode === 2
            ? event.deltaY * 400
            : event.deltaY;
      const next = Math.max(0, Math.min(1, g.pos + px / SCROLL_FULL_SWEEP_PX));
      strumSweep(next, { minGap: SCROLL_STRING_GAP_SEC, sequence: true });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [strumOn, strumSweep]);

  const getDrumPlayhead = useCallback(
    () => drumsRef.current?.playheadStep() ?? -1,
    []
  );

  const updateSound = useCallback((mut: (s: SoundConfig) => void) => {
    setSound((prev) => {
      const next = cloneSound(prev);
      mut(next);
      return next;
    });
    setPresetName("custom");
  }, []);
  const selectPreset = useCallback((name: string) => {
    setSound(getPreset(name));
    setPresetName(name);
  }, []);

  // Keep arpeggiator params in sync.
  useEffect(() => {
    arpRef.current?.setParams({
      pattern: arpPattern,
      division: arpDivision,
      bpm: arpBpm,
      octaveRange: arpOctaves,
      gate: arpGate,
    });
  }, [arpPattern, arpDivision, arpBpm, arpOctaves, arpGate]);

  // On enabling the arp, clear any sustained block chord so it doesn't linger.
  useEffect(() => {
    if (arpOn) synthRef.current.releaseAll();
  }, [arpOn]);

  // Strum and arp are both ways of sounding the held chord one note at a time,
  // and running them together is two instruments fighting over one chord.
  useEffect(() => {
    if (!strumOn) {
      strumChordRef.current = [];
      strokeChordRef.current = [];
      dampStrings();
      return;
    }
    setArpOn(false);
    // The block chord would otherwise hang under the strings for its whole
    // release, which is the drone strum mode exists to get rid of.
    synthRef.current.releaseAll();
  }, [strumOn]);

  // Keep the drum machine in sync. It shares the transport BPM with the arp.
  useEffect(() => {
    const dm = drumsRef.current;
    if (!dm) return;
    dm.setBpm(arpBpm);
    dm.setPattern(resolvePattern(drumPattern, customBeat));
    dm.setBassPattern(bassLanes);
    dm.setBassEnabled(bassOn);
    dm.setEnables({ kick: kickOn, snare: snareOn, clap: clapOn, hat: hatOn, tom: tomOn, shaker: shakerOn });
    dm.setMetronome(metronomeOn);
    // Stopping the beat leaves the metronome clicking if that is what you
    // asked for; pausing holds everything, including the click.
    // Stopping the beat leaves the metronome clicking if that is what you asked
    // for; pausing holds everything, the click included.
    const shouldRun = (drumsOn || bassOn || metronomeOn) && !beatPaused;
    if (shouldRun && !dm.isRunning) {
      // Resuming continues mid-bar; starting rewinds. The wrong one here means
      // a four-bar groove snaps back to bar one every time you glance away.
      if (wasPausedRef.current) dm.resume();
      else dm.start();
      wasPausedRef.current = false;
    } else if (!shouldRun && dm.isRunning) {
      if (beatPaused) {
        dm.pause();
        wasPausedRef.current = true;
      } else {
        dm.stop();
        wasPausedRef.current = false;
      }
    }
  }, [
    drumsOn,
    beatPaused,
    bassOn,
    drumPattern,
    customBeat,
    bassLanes,
    kickOn,
    snareOn,
    clapOn,
    hatOn,
    tomOn,
    shakerOn,
    metronomeOn,
    arpBpm,
  ]);

  // Keep the harmonizer's live parameters in sync with the UI controls.
  useEffect(() => {
    harmonizerRef.current?.setOutputLevel(harmonizerLevel);
  }, [harmonizerLevel]);
  useEffect(() => {
    harmonizerRef.current?.setDryWet(harmonizerDryWet);
  }, [harmonizerDryWet]);
  useEffect(() => {
    harmonizerRef.current?.setMaxVoices(harmonizerVoices);
  }, [harmonizerVoices]);
  useEffect(() => {
    harmonizerRef.current?.setSpan(harmonizerSpan);
  }, [harmonizerSpan]);

  // Keep the looper config synced (shares the transport BPM with arp/drums).
  useEffect(() => {
    looperRef.current?.setConfig({ bpm: arpBpm, bars: loopBars, free: loopFree });
  }, [arpBpm, loopBars, loopFree]);
  useEffect(() => {
    looperRef.current?.setRecordSource(loopSource);
  }, [loopSource]);

  const loop = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const landmarker = landmarkerRef.current;
    const synth = synthRef.current;
    if (!video || !canvas || !landmarker) {
      rafRef.current = requestAnimationFrame(loop);
      return;
    }

    const ctx = canvas.getContext("2d");
    if (video.readyState >= 2 && ctx) {
      if (canvas.width !== video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }

      let playHand: HandPose | null = null;
      let modHand: HandPose | null = null;

      if (video.currentTime !== lastVideoTimeRef.current) {
        lastVideoTimeRef.current = video.currentTime;
        const result = landmarker.detectForVideo(video, performance.now());

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const hands = result.landmarks ?? [];
        setHandCount(hands.length);

        const tSec = performance.now() / 1000;
        for (let i = 0; i < hands.length; i++) {
          // One-Euro smoothing on the raw landmarks (per hand index).
          const raw = hands[i] as Landmark[];
          const smoother = smoothersRef.current[i] ?? smoothersRef.current[0];
          const lm = smoother.filter(raw, tSec) as Landmark[];

          const handedness =
            result.handednesses?.[i]?.[0]?.categoryName ?? "Right";
          const isModifier =
            cfgRef.current.twoHand && handedness === "Left";
          drawHand(
            ctx,
            lm,
            canvas.width,
            canvas.height,
            HAND_COLORS[isModifier ? 1 : 0]
          );

          const pose = readHand(lm);
          pose.x = 1 - pose.x; // mirror X to match the mirrored display
          if (isModifier) modHand = pose;
          else if (!playHand) playHand = pose;
        }

        const c = cfgRef.current;
        if (c.strumOn) {
          const nowMs = performance.now();
          const lit = Array.from({ length: STRUM_STRINGS }, (_, i) => {
            const age = nowMs - (strumFlashRef.current[i] ?? -Infinity);
            return age >= 0 && age < STRUM_FLASH_MS ? 1 - age / STRUM_FLASH_MS : 0;
          });
          drawStrings(
            ctx,
            canvas.width,
            canvas.height,
            STRUM_STRINGS,
            playHand ? playHand.y : null,
            lit
          );
        }
        const sel = mapHandsToSelection(playHand, modHand, {
          mode: c.mode,
          key: { tonic: c.tonic, scale: c.scale, octave: c.octave },
          extension: c.extension,
          twoHand: c.twoHand,
          progression: c.progression,
        });

        // Chord latch: keep the last chord sounding hands-free until a new
        // chord is selected or latch is turned off.
        let notes: number[] = [];
        let freqs: number[] = [];
        let cutoff = sel.cutoffHz;
        let expr = sel.expression;
        if (!sel.rest && sel.chord) {
          notes = sel.chord.notes;
          freqs = sel.chord.freqs;
          if (c.latchOn) {
            latchedChordRef.current = { notes, freqs };
            latchedCtrlRef.current = { cutoff, expr };
          }
        } else if (c.latchOn && latchedChordRef.current) {
          // Hand dropped / fist but latched: hold the chord and its last
          // expressive settings so it does not mute.
          notes = latchedChordRef.current.notes;
          freqs = latchedChordRef.current.freqs;
          cutoff = latchedCtrlRef.current.cutoff;
          expr = latchedCtrlRef.current.expr;
        }

        synth.setCutoff(cutoff);
        synth.setExpression(expr);

        if (c.strumOn) {
          // The hand frets and the trackpad strums: your fingers pick the
          // chord, and it stays silent until the other hand sweeps the pad.
          // Two hands doing two jobs, which is how a guitar is played and is
          // also why the strum left the camera: one hand cannot hold a chord
          // still and sweep across it at the same time.
          arpRef.current?.setChord([]);
          synth.playFreqs([]);
          // A fist is this instrument's word for "rest", and on a guitar that
          // is a palm on the strings rather than six notes ringing on. Changing
          // the shape damps them too: a fretting hand that moves stops what the
          // last shape left sounding.
          const name = sel.rest ? "" : (sel.chord?.label ?? "");
          if (name !== strumChordNameRef.current && strumChordNameRef.current) {
            dampStrings();
          }
          strumChordNameRef.current = name;
          strumChordRef.current = notes;
        } else if (c.arpOn) {
          arpRef.current?.setChord(notes);
          synth.playFreqs([]); // arp handles note-on; keep block chord silent
        } else {
          arpRef.current?.setChord([]); // ensure arp is idle
          synth.playFreqs(freqs);
        }

        // Vocal harmonizer: the tones of the chord the user is holding are the
        // harmony targets. Feed them to the harmonizer each frame; it detects
        // the sung pitch on the mic and re-locks a pitch-shifted copy of the
        // voice onto each chord tone. It no-ops cheaply while disabled. When
        // resting (no chord), the empty list fades the harmonies out.
        heldChordFreqsRef.current = freqs;
        const harm = harmonizerRef.current;
        if (harm) {
          harm.update(freqs);
          setSungPitch(harm.getDetectedPitch());
        }

        setSelection(sel);
      }
    }

    rafRef.current = requestAnimationFrame(loop);
  }, []);

  const start = useCallback(async () => {
    setErrorMsg("");
    try {
      await synthRef.current.ensureStarted();
      synthRef.current.applyConfig(sound);
      synthRef.current.setMasterVolume(volume);

      // Build the arpeggiator + drum machine now that the AudioContext exists.
      const audioCtx = synthRef.current.getContext();
      if (audioCtx && !arpRef.current) {
        arpRef.current = new Arpeggiator(audioCtx, (f, t, g) =>
          synthRef.current.triggerNote(f, t, g)
        );
        arpRef.current.setParams({
          pattern: arpPattern,
          division: arpDivision,
          bpm: arpBpm,
          octaveRange: arpOctaves,
          gate: arpGate,
        });
      }
      if (audioCtx && !drumsRef.current) {
        const s = synthRef.current;
        drumsRef.current = new DrumMachine(audioCtx, {
          kick: (t, v) => s.triggerKick(t, v),
          snare: (t, v) => s.triggerSnare(t, v),
          clap: (t, v) => s.triggerClap(t, v),
          hat: (t, v) => s.triggerHat(t, v),
          tom: (t, v) => s.triggerTom(t, v),
          shaker: (t, v) => s.triggerShaker(t, v),
          bass: (midi, t, gate, gain) => s.triggerBass(midi, t, gate, gain),
          click: (t, accent) => s.triggerClick(t, accent),
        });
        drumsRef.current.setBpm(arpBpm);
        drumsRef.current.setPattern(resolvePattern(drumPattern, customBeat));
        drumsRef.current.setBassPattern(bassLanes);
        drumsRef.current.setBassEnabled(bassOn);
        drumsRef.current.setEnables({ kick: kickOn, snare: snareOn, clap: clapOn, hat: hatOn, tom: tomOn, shaker: shakerOn });
        drumsRef.current.setMetronome(metronomeOn);
        if (drumsOn || bassOn || metronomeOn) drumsRef.current.start();
      }
      if (audioCtx && !looperRef.current) {
        const s = synthRef.current;
        // Loop tracks feed the master mix bus (so the master recorder captures
        // them); the "Instrument" tap reads the feedback-safe instrument bus.
        const out = s.getOutputBus() ?? audioCtx.destination;
        looperRef.current = new VocalLooper(audioCtx, out, (t, accent) =>
          s.triggerClick(t, accent)
        );
        const instr = s.getInstrumentBus();
        if (instr) looperRef.current.setInstrumentNode(instr);
        looperRef.current.setConfig({ bpm: arpBpm, bars: loopBars, free: loopFree });
        looperRef.current.setRecordSource(loopSource);
        if (!inputMeterRef.current) inputMeterRef.current = new InputMeter(audioCtx);
        looperRef.current.onChange = () => {
          const lp = looperRef.current;
          if (!lp) return;
          setLoopTracks(lp.getStates());
          setLoopDurSec(lp.loopDurationSec);
          setLoopRecording(lp.isRecording);
          setLoopPlaying(lp.isPlaying);
          setLoopCycleProgress(lp.getCycleProgress());
        };
      }
      for (const sm of smoothersRef.current) sm.setAmount(smoothing);

      setPhase("loading-model");
      landmarkerRef.current = await createHandLandmarker({
        numHands: 2,
        onStatus: setStatus,
      });

      setPhase("requesting-camera");
      setStatus("Requesting camera…");
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720, facingMode: "user" },
          audio: false,
        });
      } catch (err) {
        setPhase("camera-denied");
        setErrorMsg(
          err instanceof Error ? err.message : "Camera permission denied."
        );
        return;
      }

      cameraStreamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();

      setPhase("running");
      setStatus("Tracking. Show a hand to the camera.");
      rafRef.current = requestAnimationFrame(loop);
    } catch (err) {
      setPhase("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [
    loop,
    volume,
    sound,
    arpPattern,
    arpDivision,
    arpBpm,
    arpOctaves,
    arpGate,
    drumPattern,
    customBeat,
    bassLanes,
    kickOn,
    snareOn,
    clapOn,
    hatOn,
    tomOn,
    shakerOn,
    metronomeOn,
    drumsOn,
    bassOn,
    smoothing,
    loopBars,
    loopFree,
    loopSource,
  ]);

  // Acquire the microphone once and route it into the synth's single shared mic
  // hub, so the harmonizer, looper and level meter all read ONE source node (only
  // one MediaStreamAudioSourceNode may exist per stream, or the recorder gets
  // silence).
  const getSharedMic = useCallback(async (): Promise<MediaStream> => {
    if (micStreamRef.current) return micStreamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micStreamRef.current = stream;
    synthRef.current.setMicStream(stream);
    setMicReady(true);
    return stream;
  }, []);

  // Point the input meter at the node(s) the current source records from, so the
  // bar reflects exactly what a take would capture.
  const updateMeterInputs = useCallback((sel: RecordSource) => {
    const meter = inputMeterRef.current;
    if (!meter) return;
    const s = synthRef.current;
    const nodes: AudioNode[] = [];
    for (const kind of sourcesForSelection(sel)) {
      const node = kind === "mic" ? s.getMicNode() : s.getInstrumentBus();
      if (node) nodes.push(node);
    }
    meter.setInputs(nodes);
  }, []);

  // Choose the record source. For a source that needs the mic, request it up
  // front so the meter is live before recording; the shared hub means this never
  // conflicts with the harmonizer.
  const selectLoopSource = useCallback(
    async (sel: RecordSource) => {
      setLoopSource(sel);
      setLoopError("");
      if ((sel === "mic" || sel === "mix") && !micStreamRef.current) {
        try {
          await getSharedMic();
        } catch (err) {
          setLoopError(
            err instanceof Error
              ? `Microphone unavailable: ${err.message}`
              : "Microphone permission denied."
          );
        }
      }
      updateMeterInputs(sel);
    },
    [getSharedMic, updateMeterInputs]
  );

  // Keep the meter pointed at the right source as selection / mic availability
  // change (e.g. after the app starts or the mic is granted).
  useEffect(() => {
    if (phase !== "running") return;
    updateMeterInputs(loopSource);
  }, [phase, loopSource, micReady, updateMeterInputs]);

  // Toggle the harmonizer: request the mic on enable, build the graph, and feed
  // its output into the instrument bus so takes and loops capture the harmony.
  const toggleHarmonizer = useCallback(
    async (enable: boolean) => {
      setMicError("");
      const synth = synthRef.current;
      const audioCtx = synth.getContext();

      if (!enable) {
        setHarmonizerOn(false);
        const h = harmonizerRef.current;
        if (h) {
          h.stop();
          setTimeout(() => {
            h.dispose();
            harmonizerRef.current = null;
            // Leave the shared mic open; the looper may still be using it.
          }, 200);
        }
        return;
      }

      if (!audioCtx) {
        setMicError("Start the app (Enable camera & sound) first.");
        return;
      }

      try {
        await getSharedMic();
      } catch (err) {
        setHarmonizerOn(false);
        setMicError(
          err instanceof Error
            ? `Microphone unavailable: ${err.message}`
            : "Microphone permission denied."
        );
        return;
      }
      const micNode = synth.getMicNode();
      if (!micNode) {
        setHarmonizerOn(false);
        setMicError("Microphone unavailable.");
        return;
      }

      // Route the harmonizer into the instrument bus so it is part of the played
      // signal (captured by the master recorder and by "Instrument" loop takes).
      const out =
        synth.getInstrumentBus() ?? synth.getOutputBus() ?? audioCtx.destination;
      const harm = new Harmonizer(audioCtx, out, {
        maxVoices: harmonizerVoices,
        dryWet: harmonizerDryWet,
        outputLevel: harmonizerLevel,
      });
      harm.setSpan(harmonizerSpan);
      // Read the SHARED mic hub, not a fresh source node, so the looper and the
      // level meter keep receiving the voice while the harmonizer is on.
      harm.connect(micNode);
      harm.start();
      harmonizerRef.current = harm;
      setHarmonizerOn(true);
    },
    [getSharedMic, harmonizerVoices, harmonizerDryWet, harmonizerLevel, harmonizerSpan]
  );

  // Record a video of the performer plus the full audio mix (synths + drums +
  // effects + harmonizer + loops + the live voice) via MediaRecorder. The mic is
  // folded into the audio inside Synth.getRecordingStream(); here we add the
  // webcam video track so Record saves a shareable video of you over the backing
  // track. Falls back to audio-only if the camera is unavailable.
  const pickMime = (list: string[]): string => {
    for (const m of list) {
      if (
        typeof MediaRecorder !== "undefined" &&
        MediaRecorder.isTypeSupported(m)
      )
        return m;
    }
    return "";
  };

  const startRecording = useCallback(async () => {
    setRecordError("");
    const synth = synthRef.current;
    const audioStream = synth.getRecordingStream();
    if (!audioStream) {
      setRecordError("Start the app (Enable camera & sound) first.");
      return;
    }
    // Make sure the mic is live so the recording captures the voice, not just
    // the synths. Recording still proceeds (without voice) if it is denied.
    try {
      await getSharedMic();
    } catch {
      /* keep recording; the file just will not contain the voice */
    }

    const cam = cameraStreamRef.current;
    const videoTracks = cam ? cam.getVideoTracks() : [];
    const audioTracks = audioStream.getAudioTracks();
    const hasVideo = videoTracks.length > 0;
    const mixed = new MediaStream([...videoTracks, ...audioTracks]);

    const mimeType = hasVideo
      ? pickMime([
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm",
        ])
      : pickMime(["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]);

    try {
      const rec = mimeType
        ? new MediaRecorder(mixed, { mimeType })
        : new MediaRecorder(mixed);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: rec.mimeType || (hasVideo ? "video/webm" : "audio/webm"),
        });
        // The take goes to the wall rather than straight to disk. Downloading
        // every take immediately made stacking impossible: to put two takes
        // side by side you would have had to re-import files the app had just
        // thrown away. Each take keeps its own save button.
        const elapsed = performance.now() - recordStartRef.current;
        setTakes((prev) => {
          const id = nextTakeId.current++;
          return [
            ...prev,
            {
              id,
              url: URL.createObjectURL(blob),
              blob,
              label: takeLabel(prev.length, elapsed),
              durationMs: Math.round(elapsed),
            },
          ];
        });
      };
      rec.start();
      recorderRef.current = rec;
      recordStartRef.current = performance.now();
      setRecordElapsed(0);
      setRecording(true);
      recordTimerRef.current = setInterval(() => {
        setRecordElapsed(performance.now() - recordStartRef.current);
      }, 200);
    } catch (err) {
      setRecordError(
        err instanceof Error ? err.message : "Recording failed to start."
      );
    }
  }, [getSharedMic]);

  /**
   * Click a bar in before a take rolls.
   *
   * Stacking a second part means starting where the first one started, and
   * "press record, then find the downbeat" is how takes end up a beat apart.
   * The clicks are scheduled on the audio clock rather than by timer, so they
   * land where a metronome would; the wait is only there to hold the recorder
   * back until the bar is over.
   */
  const countInBar = useCallback(
    async (beats: number) => {
      const synth = synthRef.current;
      const ctx = synth.getContext();
      const beatSec = 60 / Math.max(1, arpBpm);
      const bar = Math.max(1, Math.round(beats));
      if (!ctx) {
        await new Promise((r) => setTimeout(r, bar * beatSec * 1000));
        return;
      }
      const start = ctx.currentTime + 0.08;
      for (let i = 0; i < bar; i += 1) synth.triggerClick(start + i * beatSec, i === 0);
      const waitMs = (start + bar * beatSec - ctx.currentTime) * 1000;
      await new Promise((r) => setTimeout(r, Math.max(0, waitMs)));
    },
    [arpBpm]
  );

  /**
   * Bring clips in from files.
   *
   * They become takes like any other, which is the whole point: everything the
   * wall already does - play them together, record a new take while they run,
   * caption them, bounce the grid to one video - then works on a video you shot
   * somewhere else. The file is not copied or uploaded; the take points at it
   * through an object URL, so importing an hour of footage costs nothing until
   * it plays.
   */
  const importVideos = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setTakes((prev) => {
      const room = Math.max(0, MAX_TAKES - prev.length);
      return [
        ...prev,
        ...files.slice(0, room).map((file) => ({
          id: nextTakeId.current++,
          url: URL.createObjectURL(file),
          blob: file,
          // The name is what the person knows the clip by; the length arrives
          // when the browser has read the file's metadata.
          label: importedLabel(file.name),
          durationMs: 0,
          imported: true,
        })),
      ];
    });
  }, []);

  const stopRecording = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    recorderRef.current = null;
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    setRecording(false);
  }, []);

  /**
   * Listen back to a take and work out what would go under it.
   *
   * The harmonizer can only sing harmonies onto the chord your hand is holding,
   * which is no use at all once you have sung something and do not know what
   * you sang. This reads the take back and answers that: the key it is in, and
   * a chord under each stretch of it. Both answers can be applied to the
   * controls that already exist rather than being another readout to look at.
   */
  const suggestHarmonies = useCallback((id: number) => {
    const audio = looperRef.current?.getTrackAudio(id);
    if (!audio) return;
    setLoopError("");
    const analysis = analyzeMelody(audio.data, audio.sampleRate, { segments: 4 });
    setMelody({ id, analysis });
  }, []);

  /** Put the suggestion to work: the key it heard, and the chords under it. */
  const useSuggestedKey = useCallback(() => {
    const key = melody?.analysis.key;
    if (!key) return;
    setTonic(key.tonic);
    setScale(key.scale);
  }, [melody]);

  const useSuggestedChords = useCallback(() => {
    const chords = melody?.analysis.chords ?? [];
    if (chords.length === 0) return;
    setProgressionText(chords.join(" "));
    setMode("progression");
  }, [melody]);

  /**
   * This song, as the thing a link carries.
   *
   * The song and not the session: tempo, key, chords, the beat, the basslines,
   * the words and the voice they were written for. Never the recordings -
   * they are megabytes, and they are also someone's actual voice, which is not
   * something to put in a URL that gets pasted around.
   */
  const currentSong = useCallback(
    (): SongLink => ({
      name: songName,
      bpm: arpBpm,
      tonic,
      scale,
      mode,
      progression: progressionText,
      preset: presetName,
      drums: resolvePattern(drumPattern, customBeat),
      bass: bassLanes,
      lyrics,
    }),
    [songName, arpBpm, tonic, scale, mode, progressionText, presetName, drumPattern, customBeat, bassLanes, lyrics]
  );

  const shareSong = useCallback(async () => {
    const url = songLinkUrl(window.location.href, currentSong());
    setShareLink(url);
    let note =
      url.length > SONG_LINK_COMFORTABLE_CHARS
        ? "Long link - fine in a document, some chat apps may wrap it."
        : "Link copied. It holds the song, not the recordings.";
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard access can be refused, and a link you can see and select is
      // still a link. Say which happened rather than claiming a copy.
      note = "Copy this link - the clipboard was not available.";
    }
    setShareNote(note);
  }, [currentSong]);

  /** Put an opened song into the studio. */
  const openSong = useCallback((song: SongLink) => {
    setArpBpm(clampBpm(song.bpm));
    setTonic(song.tonic);
    setScale(song.scale);
    setMode(song.mode);
    if (song.progression) setProgressionText(song.progression);
    if (song.preset) {
      setPresetName(song.preset);
      setSound(getPreset(song.preset));
    }
    setCustomBeat(song.drums);
    setDrumPattern(CUSTOM_PATTERN);
    if (song.bass.length > 0) setBassLanes(song.bass);
    setLyrics(song.lyrics);
    setSongName(song.name);
  }, []);

  // A song arriving in the address bar. Read once, on the way in: the link is
  // an invitation to open something, not a lock on what the studio holds, so
  // it is not re-applied when the user then changes the key.
  useEffect(() => {
    const song = songFromUrl(window.location.href, PRESET_NAMES);
    if (!song) return;
    openSong(song);
    setShareNote(
      song.name ? `Opened "${song.name}" from a link.` : "Opened a song from a link."
    );
  }, [openSong]);

  // --- Vocal looper handlers ---
  const downloadBytes = (bytes: ArrayBuffer, name: string) => {
    const blob = new Blob([bytes], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const stamp = () =>
    new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  const toggleLoopRecord = useCallback(async () => {
    setLoopError("");
    const lp = looperRef.current;
    if (!lp) {
      setLoopError("Start the app (Enable camera & sound) first.");
      return;
    }
    if (lp.isRecording) {
      lp.stopRecording();
      return;
    }
    // Ensure the mic for any source that needs it, then hand the looper the
    // SHARED mic hub node (not a fresh source node).
    if (loopSource === "mic" || loopSource === "mix") {
      try {
        await getSharedMic();
      } catch (err) {
        setLoopError(
          err instanceof Error
            ? `Microphone unavailable: ${err.message}`
            : "Microphone permission denied."
        );
        return;
      }
      const micNode = synthRef.current.getMicNode();
      if (micNode) lp.setMicNode(micNode);
    }
    lp.setConfig({ bpm: arpBpm, bars: loopBars, free: loopFree });
    lp.setRecordSource(loopSource);
    if (!lp.canRecord()) {
      setLoopError("Selected source is not available.");
      return;
    }
    updateMeterInputs(loopSource);
    if (loopCycleOn && !loopFree) {
      lp.armCycle(loopCountIn ? 1 : 0, loopStackTakes);
    } else {
      lp.arm(loopCountIn ? 1 : 0);
    }
  }, [
    loopSource,
    arpBpm,
    loopBars,
    loopFree,
    loopCountIn,
    loopCycleOn,
    loopStackTakes,
    getSharedMic,
    updateMeterInputs,
  ]);

  const downloadTake = useCallback((id: number) => {
    const lp = looperRef.current;
    const bytes = lp?.getTrackWav(id);
    if (bytes) downloadBytes(bytes, `dice-take-${id}-${stamp()}.wav`);
  }, []);

  const exportMix = useCallback(async () => {
    const lp = looperRef.current;
    if (!lp) return;
    setLoopError("");
    try {
      const bytes = await lp.exportMix(exportCycles);
      if (bytes) downloadBytes(bytes, `dice-loop-mix-${stamp()}.wav`);
      else setLoopError("Nothing to export yet.");
    } catch (err) {
      setLoopError(
        err instanceof Error ? err.message : "Export failed."
      );
    }
  }, [exportCycles]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      arpRef.current?.stop();
      drumsRef.current?.stop();
      looperRef.current?.dispose();
      inputMeterRef.current?.dispose();
      inputMeterRef.current = null;
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        try {
          recorderRef.current.stop();
        } catch {
          /* ignore */
        }
      }
      harmonizerRef.current?.dispose();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      const v = videoRef.current;
      if (v && v.srcObject) {
        (v.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
      }
      synthRef.current.close();
    };
  }, []);

  const running = phase === "running";
  const started = running || phase === "camera-denied";

  return (
    <div className="min-h-full">
      {/* Three columns once there is room for them.
          The controls used to be one tall sidebar, which left sound design and
          the harmonizer stranded below the fold while the right-hand side of a
          wide screen sat empty. The second column holds what you are playing.
          The third holds what it sounds like. Below 2xl they fall back to one
          sidebar in that order, and below lg to a single column.

          The split waits for 2xl because a third column at 1280 can only take
          its width from the camera, and the camera is the one thing on this
          page that should not get smaller. */}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px] 2xl:grid-cols-[minmax(0,1fr)_340px_340px]">
        {/* Stage */}
        <div className="relative min-w-0">
          {/* The picture doubles as the strum surface. It is the biggest
              target on the page and the place you are already looking, and
              putting the strings anywhere else would mean watching one thing
              while strumming another. */}
          <div
            ref={strumSurfaceRef}
            role={strumOn ? "application" : undefined}
            aria-label={strumOn ? "strum the chord your hand is holding" : undefined}
            onPointerDown={
              strumOn
                ? (e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    beginStroke(strumPosFromEvent(e.currentTarget, e.clientY));
                  }
                : undefined
            }
            onPointerMove={
              strumOn
                ? (e) => {
                    if (!strumGestureRef.current.down) return;
                    strumSweep(strumPosFromEvent(e.currentTarget, e.clientY));
                  }
                : undefined
            }
            onPointerUp={strumOn ? () => { strumGestureRef.current.down = false; } : undefined}
            onPointerLeave={strumOn ? () => { strumGestureRef.current.down = false; } : undefined}
            className={`relative aspect-video w-full overflow-hidden rounded-2xl border-2 border-salmonDim/45 bg-ink ${
              strumOn ? "cursor-ns-resize touch-none select-none" : ""
            }`}
            style={{ boxShadow: "0 0 24px rgba(208,0,255,0.35)" }}
          >
            <video
              ref={videoRef}
              playsInline
              muted
              className="absolute inset-0 h-full w-full -scale-x-100 object-cover"
            />
            <canvas
              ref={canvasRef}
              className="absolute inset-0 h-full w-full -scale-x-100 object-cover"
            />

            {strumOn && phase === "running" && (
              <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-lg bg-ink/70 px-2.5 py-1 text-xs text-chalk/85">
                {selection?.chord
                  ? `${selection.chord.label} - drag or two-finger scroll to strum`
                  : "hold a chord with your fingers, then drag here to strum"}
              </span>
            )}

            {phase !== "running" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-ink/80 p-6 text-center">
                {phase === "idle" && (
                  <>
                    <p className="max-w-sm text-white/90">
                      Grant camera access and enable sound to start. The camera
                      feed never leaves your device.
                    </p>
                    <button
                      onClick={start}
                      className="rounded-xl bg-yellow px-6 py-3 text-lg font-semibold text-ink transition hover:bg-orange"
                    >
                      Enable camera &amp; sound
                    </button>
                  </>
                )}
                {(phase === "loading-model" ||
                  phase === "requesting-camera") && (
                  <div className="flex flex-col items-center gap-3">
                    <div className="h-8 w-8 animate-spin rounded-full border-2 border-purple/40 border-t-yellow" />
                    <p className="text-white/90">{status}</p>
                  </div>
                )}
                {phase === "camera-denied" && (
                  <div className="flex max-w-sm flex-col items-center gap-3">
                    <p className="font-semibold text-orange">
                      Camera unavailable
                    </p>
                    <p className="text-sm text-white/70">{errorMsg}</p>
                    <p className="text-xs text-white/55">
                      Check the browser camera permission (and that a webcam is
                      connected), then try again.
                    </p>
                    <button
                      onClick={start}
                      className="rounded-lg bg-purple/45 px-4 py-2 text-sm hover:bg-magenta/50"
                    >
                      Retry
                    </button>
                  </div>
                )}
                {phase === "error" && (
                  <div className="flex max-w-sm flex-col items-center gap-3">
                    <p className="font-semibold text-orange">
                      Something went wrong
                    </p>
                    <p className="text-sm text-white/70">{errorMsg}</p>
                    <button
                      onClick={start}
                      className="rounded-lg bg-purple/45 px-4 py-2 text-sm hover:bg-magenta/50"
                    >
                      Retry
                    </button>
                  </div>
                )}
              </div>
            )}

            {running && handCount === 0 && (
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-ink/80 px-4 py-1.5 text-sm text-white/90">
                No hand detected. Hold your hand up to the camera.
              </div>
            )}
          </div>

          {/* The words, beside the thing making them. */}
          <LyricPad
            value={lyrics}
            onChange={setLyrics}
            chordLabel={selection?.chord?.label ?? null}
            timedLineCount={takes.length > 0 ? lyrics.split(/\r?\n/).filter((l) => l.trim() !== "").length : 0}
          />

          {/* Now playing */}
          <div className="mt-4 rounded-2xl border border-magenta/30 bg-purple/15 p-4">
            <div className="flex items-baseline justify-between">
              <div>
                <div className="text-xs uppercase tracking-wide text-white/55">
                  Now playing{" "}
                  {arpOn && <span className="text-orange">· arp</span>}
                  {strumOn && <span className="text-orange">· strum</span>}
                  {latchOn && <span className="text-yellow"> · latch</span>}
                  {drumsOn && <span className="text-orange"> · drums</span>}
                  {harmonizerOn && (
                    <span className="text-magenta"> · harmonizer</span>
                  )}
                </div>
                <div className="text-2xl font-semibold">
                  {selection?.chord ? (
                    <>
                      {selection.chord.name}{" "}
                      <span className="text-yellow">
                        ({selection.chord.label})
                      </span>
                    </>
                  ) : (
                    <span className="text-white/55">(rest)</span>
                  )}
                </div>
              </div>
              <div className="text-right text-sm text-white/70">
                {mode === "diatonic" ? (
                  <div>Key: {keyName({ tonic, scale, octave })}</div>
                ) : (
                  <div>Progression mode</div>
                )}
                {selection && !selection.rest && (
                  <div>
                    {mode === "progression"
                      ? `slot ${selection.degree + 1}`
                      : `inv ${selection.inversion}`}
                  </div>
                )}
              </div>
            </div>
            <div className="mt-2 font-mono text-sm text-white/90">
              {selection?.chord
                ? selection.chord.notes.map(midiToName).join("  ·  ")
                : " "}
            </div>

            {/* The song, as something that can leave this machine. */}
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-magenta/20 pt-3 text-xs">
              <input
                value={songName}
                onChange={(e) => setSongName(e.target.value)}
                placeholder="name this song"
                maxLength={40}
                aria-label="song name"
                className="w-40 rounded-lg border border-purple/50 bg-purple/25 px-2 py-1"
              />
              <button
                type="button"
                onClick={shareSong}
                title="Copy a link that opens this song in anyone's browser"
                className="rounded-lg bg-purple/30 px-2.5 py-1 font-semibold text-white/85 hover:bg-magenta/40"
              >
                share song
              </button>
              {shareNote && <span className="text-white/55">{shareNote}</span>}
              {shareLink && (
                <input
                  readOnly
                  value={shareLink}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="link to this song"
                  className="mt-1 w-full rounded-lg border border-purple/40 bg-ink/40 px-2 py-1 font-mono text-[11px] text-white/70"
                />
              )}
              <p className="w-full text-[11px] leading-relaxed text-white/45">
                The link holds the whole song - tempo, key, chords, beat,
                basslines, words - and nothing else: no recordings, no account,
                no upload. It rides in the part of the URL that never leaves the
                browser, so sharing a song does not send it anywhere.
              </p>
            </div>
          </div>

        {/* The beat, right under the chord readout, where there is room to
            work on it while you play over the top. */}
        <BeatTransport
          state={beatState}
          onPlay={playBeat}
          onPause={pauseBeat}
          onStop={stopBeat}
          pattern={drumPattern}
          onPattern={setDrumPattern}
          bpm={arpBpm}
          onBpm={setArpBpm}
          bassOn={bassOn}
          onBass={setBassOn}
          metronome={metronomeOn}
          onMetronome={setMetronomeOn}
          customBeat={customBeat}
          onCustomBeat={setCustomBeat}
          getPlayhead={getDrumPlayhead}
          bassLanes={bassLanes}
          onBassLanes={setBassLanes}
          tonic={tonic}
          scale={scale}
          enables={{
            kick: kickOn,
            snare: snareOn,
            clap: clapOn,
            hat: hatOn,
            tom: tomOn,
            shaker: shakerOn,
          }}
        />

        {/* The takes, as clips. Play mode records loops but never showed them
            on a timeline, so where a take actually sat in the bar was
            something you could only hear, never see or move. */}
        <div className="mt-4">
          <Timeline
            tracks={timelineTracks}
            bpm={arpBpm}
            beatsPerBar={BEATS_PER_BAR}
            loopBars={timelineBars}
            loopDurSec={loopDurSec}
            playheadSec={loopPos}
            playing={loopPlaying}
            getPeaks={getTakePeaks}
            onSetBars={setLoopBars}
            onMove={(id, off) => looperRef.current?.setTrackOffset(id, off)}
            onTrim={(id, from, to) => looperRef.current?.trimTrack(id, from, to)}
            onDuplicate={(id) => looperRef.current?.duplicateTrack(id)}
            onDelete={(id) => looperRef.current?.deleteTrack(id)}
            lockLoop={loopTracks.length > 0}
            emptyMessage="No takes yet. Record a loop and it lands here as a clip you can move and trim."
          />
        </div>

        {/* Beatbox straight into the grid above. */}
        <BeatboxChat
          getTracks={beatboxTracks}
          readAudio={beatboxAudio}
          bpm={arpBpm}
          onPattern={(next) => {
            setCustomBeat(next);
            setDrumPattern(CUSTOM_PATTERN);
            if (!drumsOn) playBeat();
          }}
          onTempo={(next) => setArpBpm(clampBpm(next))}
          getContext={beatboxContext}
        />
        </div>

        {/* What you are playing: the mode, the key, the wall, the gesture map. */}
        <aside className="flex min-w-0 flex-col gap-4 lg:col-start-2 lg:row-start-1">


          {/* Mode switch */}
          <section className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/70">
              Mode
            </h2>
            <div className="grid grid-cols-2 gap-2 text-sm">
              {(
                [
                  ["diatonic", "Key (diatonic)"],
                  ["progression", "Progression (custom)"],
                ] as [PlayMode, string][]
              ).map(([m, label]) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`rounded-lg px-3 py-2 font-medium transition ${
                    mode === m
                      ? "bg-yellow text-ink"
                      : "bg-purple/25 text-white/90 hover:bg-magenta/40"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {mode === "progression" && (
              <div className="mt-3">
                {/* The search, before the field it fills.
                    What people want here is the chords to a song, which would
                    be a licensed database and a request carrying what they are
                    working on. The shape under the song is common property and
                    is what goes in the box anyway, so that is what this
                    searches, offline. */}
                <label className="mb-1 block text-sm text-white/70">
                  Find a progression
                </label>
                <input
                  type="text"
                  value={chordQuery}
                  onChange={(e) => setChordQuery(e.target.value)}
                  placeholder="blues, jazz, sad, doo-wop, I V vi IV"
                  aria-label="search progressions"
                  className="w-full rounded-lg border border-purple/50 bg-purple/25 px-2 py-1.5 text-sm"
                />
                <div className="mt-1.5 flex flex-col gap-1">
                  {chordMatches.map(({ progression, text }) => (
                    <button
                      key={progression.id}
                      type="button"
                      onClick={() => setProgressionText(text)}
                      title={progression.note}
                      className="rounded-lg border border-purple/30 bg-purple/10 px-2 py-1.5 text-left transition hover:bg-magenta/25"
                    >
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-xs font-semibold text-white/85">
                          {progression.name}
                        </span>
                        <span className="font-mono text-xs text-yellow">{text}</span>
                        <span className="text-[11px] text-white/40">
                          {progression.roman}
                        </span>
                      </span>
                    </button>
                  ))}
                  {chordQuery.trim() !== "" && chordMatches.length === 0 && (
                    <p className="text-xs text-white/55">
                      Nothing by that name. dice searches progressions it holds
                      offline, not the chords to a particular recording, which
                      would mean sending your search somewhere.
                    </p>
                  )}
                </div>

                {/* Hear it played, not just held.
                    A progression you have to perform before you know whether
                    you like it is a progression you will not audition. */}
                <div className="mt-3 rounded-lg border border-purple/30 bg-purple/10 p-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={autoStrum}
                      onChange={(e) => {
                        setAutoStrum(e.target.checked);
                        if (e.target.checked) {
                          // A strummed guitar wants a guitar. Synth voices
                          // swell where a strum needs to land, so a plain
                          // synth is swapped for the acoustic the first time.
                          if (!PRESET_GROUPS[0].names.includes(presetName)) {
                            setPresetName("Acoustic guitar");
                            setSound(getPreset("Acoustic guitar"));
                          }
                          if (beatState === "stopped") playBeat();
                        }
                      }}
                    />
                    Strum the progression
                    <span className="text-xs text-white/55">(with the beat)</span>
                  </label>

                  {autoStrum && (
                    <label className="mt-2 flex items-center gap-2 text-xs text-white/70">
                      pattern
                      <select
                        value={strumPatternId}
                        onChange={(e) => setStrumPatternId(e.target.value)}
                        className="flex-1 rounded-md border border-purple/50 bg-purple/25 px-1.5 py-1"
                      >
                        {STRUM_PATTERNS.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  <p className="mt-1 text-[11px] leading-relaxed text-white/45">
                    {autoStrum
                      ? STRUM_PATTERNS.find((p) => p.id === strumPatternId)?.note
                      : "Plays the chords above as a strummed guitar, one to the bar, on the beat. Your hands stay free for the melody."}
                  </p>
                </div>

                <label className="mb-1 mt-3 block text-sm text-white/70">
                  Chord sequence (space/comma separated)
                </label>
                <input
                  type="text"
                  value={progressionText}
                  onChange={(e) => setProgressionText(e.target.value)}
                  placeholder="Am E F C"
                  className="w-full rounded-lg border border-purple/50 bg-purple/25 px-2 py-1.5 font-mono"
                />
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-white/60">Transpose</span>
                  <button
                    type="button"
                    aria-label="Transpose the progression down a semitone"
                    disabled={progressionRootPc === null}
                    onClick={() => transpose(-1)}
                    className="rounded-md border border-purple/50 bg-purple/25 px-2 py-1 font-mono hover:bg-magenta/40 disabled:opacity-40 disabled:hover:bg-purple/25"
                  >
                    −1
                  </button>
                  <button
                    type="button"
                    aria-label="Transpose the progression up a semitone"
                    disabled={progressionRootPc === null}
                    onClick={() => transpose(1)}
                    className="rounded-md border border-purple/50 bg-purple/25 px-2 py-1 font-mono hover:bg-magenta/40 disabled:opacity-40 disabled:hover:bg-purple/25"
                  >
                    +1
                  </button>
                  <label className="flex items-center gap-1">
                    <span className="text-white/60">starting on</span>
                    <select
                      aria-label="Transpose the progression to start on this root"
                      value={progressionRootPc ?? ""}
                      disabled={progressionRootPc === null}
                      onChange={(e) => {
                        const move = semitonesToRoot(progressionText, Number(e.target.value));
                        if (move !== null) transpose(move);
                      }}
                      className="rounded-md border border-purple/50 bg-purple/25 px-1.5 py-1 font-mono disabled:opacity-40"
                    >
                      {progressionRootPc === null && <option value="">-</option>}
                      {NOTE_NAMES.map((_, pc) => (
                        <option key={pc} value={pc}>
                          {spellPitchClass(pc, progressionSpelling)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span className="text-white/45">
                    Rewrites the chords above; qualities and typos are left as typed.
                  </span>
                </div>

                <div className="mt-2 flex flex-wrap gap-1.5">
                  {progressionSlots.map((s, i) => (
                    <span
                      key={`${s.symbol}-${i}`}
                      title={
                        s.chord
                          ? s.chord.name
                          : `"${s.symbol}" is not a recognized chord`
                      }
                      className={`rounded-md px-2 py-1 text-xs font-mono ${
                        s.chord
                          ? "bg-purple/25 text-white"
                          : "bg-magenta/25 text-orange line-through"
                      }`}
                    >
                      {i + 1}. {s.symbol}
                    </span>
                  ))}
                  {progressionSlots.length === 0 && (
                    <span className="text-xs text-white/55">
                      Type chords like <code>Am E F C</code>.
                    </span>
                  )}
                </div>
                <p className="mt-2 text-xs text-white/55">
                  Fingers 1-5 pick slots 1-5. Enable two-hand mode and hold your
                  left hand open to reach slots 6-10. Quality comes from the
                  typed symbol, so the Triad/6th/7th control is disabled here.
                </p>
              </div>
            )}
          </section>

          {/* Musical controls */}
          <section className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/70">
              Performance
            </h2>

            {mode === "diatonic" && (
              <>
                <label className="mb-3 block text-sm">
                  <span className="mb-1 block text-white/70">Key</span>
                  <select
                    value={tonic}
                    onChange={(e) => setTonic(Number(e.target.value))}
                    className="w-full rounded-lg border border-purple/50 bg-purple/25 px-2 py-1.5"
                  >
                    {NOTE_NAMES.map((n, i) => (
                      <option key={n} value={i}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="mb-3 block text-sm">
                  <span className="mb-1 block text-white/70">Scale</span>
                  <select
                    value={scale}
                    onChange={(e) => setScale(e.target.value as ScaleName)}
                    className="w-full rounded-lg border border-purple/50 bg-purple/25 px-2 py-1.5"
                  >
                    {SCALES.map((s) => (
                      <option key={s} value={s}>
                        {SCALE_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}

            <label className="mb-3 block text-sm">
              <span className="mb-1 block text-white/70">
                Base octave: {octave}
              </span>
              <input
                type="range"
                min={2}
                max={5}
                step={1}
                value={octave}
                onChange={(e) => setOctave(Number(e.target.value))}
                className="w-full"
              />
            </label>

            {/* Chord extension (diatonic only) */}
            <div className="mb-3 text-sm">
              <span className="mb-1 block text-white/70">
                Chord extension
                {mode === "progression" && (
                  <span className="ml-1 text-xs text-white/40">
                    (from symbols)
                  </span>
                )}
              </span>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ["triad", "Triad"],
                    ["6th", "6th"],
                    ["7th", "7th"],
                  ] as [ChordExtension, string][]
                ).map(([ext, label]) => (
                  <button
                    key={ext}
                    disabled={mode === "progression"}
                    onClick={() => setExtension(ext)}
                    className={`rounded-lg px-2 py-1.5 font-medium transition ${
                      mode === "progression"
                        ? "cursor-not-allowed bg-purple/10 text-white/40"
                        : extension === ext
                          ? "bg-yellow text-ink"
                          : "bg-purple/25 text-white/90 hover:bg-magenta/40"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <label className="mb-3 block text-sm">
              <span className="mb-1 block text-white/70">
                Master volume: {(volume * 100).toFixed(0)}%
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                className="w-full"
              />
            </label>

            {/* The voice the chord speaks in.
                This has always been in Sound design, under a control labelled
                "Mode", which is a reasonable place for it and a poor place to
                find it. Someone holding up three fingers and hearing a synth
                wants a piano here, next to the chord, not two panels away. */}
            <label className="mb-3 block text-sm">
              <span className="mb-1 block text-white/70">Chord voice</span>
              <select
                value={presetName}
                onChange={(e) => {
                  setPresetName(e.target.value);
                  setSound(getPreset(e.target.value));
                }}
                className="w-full rounded-lg border border-purple/50 bg-purple/25 px-2 py-1.5"
              >
                {!PRESET_NAMES.includes(presetName) && (
                  <option value={presetName}>custom</option>
                )}
                {PRESET_GROUPS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.names.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <span className="mt-1 block text-xs text-white/55">
                What a held chord sounds like. Sound design edits whichever
                voice is chosen here.
              </span>
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={twoHand}
                onChange={(e) => setTwoHand(e.target.checked)}
              />
              Two-hand mode{" "}
              <span className="text-xs text-white/55">
                {mode === "diatonic"
                  ? "(left open = vi/vii)"
                  : "(left = slots 6 to 10)"}
              </span>
            </label>

            {/* Strum belongs out here with the other play-style switches, not
                behind a disclosure: a way of playing you cannot find is a way of
                playing you do not have. */}
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={strumOn}
                onChange={(e) => setStrumOn(e.target.checked)}
              />
              Strum{" "}
              <span className="text-xs text-white/55">(drag the trackpad)</span>
            </label>

            {/* A slow attack does not strum: each string swells instead of being
                hit, which reads as a broken strum rather than as a pad. Said
                rather than fixed, because the sound is the user's choice. */}
            {strumOn && sound.env.attack > 0.12 && (
              <p className="mt-1 text-xs text-orange">
                {presetName} has a slow attack, so strummed strings swell instead
                of snapping. Guitar, Piano or Marimba strum better.
              </p>
            )}

            {strumOn && (
              <label className="mt-2 block text-sm">
                <span className="mb-1 block text-white/70">
                  Strum level: {(strumLevel * 100).toFixed(0)}%
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={strumLevel}
                  onChange={(e) => setStrumLevel(Number(e.target.value))}
                  className="w-full"
                />
              </label>
            )}
            <p className="mt-1 text-xs text-white/55">
              Your fingers fret the chord in the air and the held chord goes
              silent - the sustained synth is off while you strum. Drag, or
              two-finger scroll, down the camera picture with your other hand and
              the strings sound one at a time; sweep back up for an upstroke.
              Flick for a hard strum, drag slowly for an arpeggio, stop halfway
              and only the strings you crossed sound. Six strings are drawn over
              the picture and light up as you cross them. Pick the voice under
              Sound design: guitars, keys and mallets are there now, not just
              synths. Turns the arpeggiator off, since both play the held chord.
            </p>
          </section>

          <VideoWall
            takes={takes}
            onChange={setTakes}
            getContext={() => synthRef.current.getContext()}
            recording={recording}
            canRecord={started}
            elapsedMs={recordElapsed}
            onRecord={startRecording}
            onStop={stopRecording}
            recordError={recordError}
            getCameraStream={() => cameraStreamRef.current}
            onCountIn={countInBar}
            lyrics={lyrics}
            onLyrics={setLyrics}
            onImport={importVideos}
          />

          {/* Playability */}
          <section className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
            <details>
              <summary className="cursor-pointer list-none text-sm font-semibold uppercase tracking-wide text-white/70">
                Playability
              </summary>
              <div className="mt-3">
                <Range
                  label="Smoothing / sensitivity"
                  value={smoothing}
                  min={0}
                  max={1}
                  step={0.01}
                  fmt={(v) =>
                    v <= 0 ? "off" : `${(v * 100).toFixed(0)}%`
                  }
                  onChange={setSmoothing}
                />
                <p className="mb-3 text-xs text-white/55">
                  One-Euro filter on the hand landmarks. Higher smooths jitter;
                  lower is more responsive.
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={latchOn}
                    onChange={(e) => setLatchOn(e.target.checked)}
                  />
                  Chord latch
                </label>
                <p className="mt-1 text-xs text-white/55">
                  Hold the last chord hands-free until a new chord is played or
                  latch is turned off. The arpeggiator keeps running on it.
                </p>

              </div>
            </details>
          </section>

          <Legend mode={mode} twoHand={twoHand} />
        </aside>

        {/* What it sounds like: the voice, the parts that play it, the looper. */}
        <aside className="flex min-w-0 flex-col gap-4 lg:col-start-2 2xl:col-start-3 2xl:row-start-1">
          {/* Sound design */}
          <section className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
            <details open>
              <summary className="cursor-pointer list-none text-sm font-semibold uppercase tracking-wide text-white/70">
                Sound design
              </summary>

              <div className="mt-3">
                <label className="mb-3 block text-sm">
                  <span className="mb-1 block text-white/70">Mode</span>
                  <select
                    value={presetName}
                    onChange={(e) => selectPreset(e.target.value)}
                    className="w-full rounded-lg border border-purple/50 bg-purple/25 px-2 py-1.5"
                  >
                    {!PRESET_NAMES.includes(presetName) && (
                      <option value={presetName}>custom</option>
                    )}
                    {PRESET_GROUPS.map((group) => (
                      <optgroup key={group.label} label={group.label}>
                        {group.names.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>

                {/* Oscillator */}
                <div className="mb-3 rounded-lg border border-magenta/30 p-2">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/55">
                    Oscillator
                  </div>
                  <label className="mb-2 block text-sm">
                    <span className="mb-1 block text-white/70">Waveform</span>
                    <select
                      value={sound.waveform}
                      onChange={(e) =>
                        updateSound((s) => {
                          s.waveform = e.target.value as Waveform;
                        })
                      }
                      className="w-full rounded-lg border border-purple/50 bg-purple/25 px-2 py-1.5"
                    >
                      <option value="sine">sine</option>
                      <option value="sawtooth">sawtooth</option>
                      <option value="square">square</option>
                      <option value="triangle">triangle</option>
                    </select>
                  </label>
                  <Range
                    label="Unison voices"
                    value={sound.unison}
                    min={1}
                    max={7}
                    step={1}
                    onChange={(v) => updateSound((s) => (s.unison = v))}
                  />
                  <Range
                    label="Detune"
                    value={sound.detune}
                    min={0}
                    max={50}
                    step={1}
                    fmt={(v) => `${v} cents`}
                    onChange={(v) => updateSound((s) => (s.detune = v))}
                  />
                  <Range
                    label="Sub oscillator"
                    value={sound.subLevel}
                    min={0}
                    max={1}
                    step={0.01}
                    fmt={(v) => `${(v * 100).toFixed(0)}%`}
                    onChange={(v) => updateSound((s) => (s.subLevel = v))}
                  />
                </div>

                {/* Amp envelope */}
                <div className="mb-3 rounded-lg border border-magenta/30 p-2">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/55">
                    Amp envelope
                  </div>
                  <Range
                    label="Attack"
                    value={sound.env.attack}
                    min={0.001}
                    max={2}
                    step={0.001}
                    fmt={(v) => `${v.toFixed(3)} s`}
                    onChange={(v) => updateSound((s) => (s.env.attack = v))}
                  />
                  <Range
                    label="Decay"
                    value={sound.env.decay}
                    min={0}
                    max={2}
                    step={0.01}
                    fmt={(v) => `${v.toFixed(2)} s`}
                    onChange={(v) => updateSound((s) => (s.env.decay = v))}
                  />
                  <Range
                    label="Sustain"
                    value={sound.env.sustain}
                    min={0}
                    max={1}
                    step={0.01}
                    fmt={(v) => `${(v * 100).toFixed(0)}%`}
                    onChange={(v) => updateSound((s) => (s.env.sustain = v))}
                  />
                  <Range
                    label="Release"
                    value={sound.env.release}
                    min={0.01}
                    max={3}
                    step={0.01}
                    fmt={(v) => `${v.toFixed(2)} s`}
                    onChange={(v) => updateSound((s) => (s.env.release = v))}
                  />
                </div>

                {/* Filter */}
                <div className="mb-3 rounded-lg border border-magenta/30 p-2">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/55">
                    Filter{" "}
                    <span className="normal-case text-white/40">
                      (cutoff = hand height)
                    </span>
                  </div>
                  <Range
                    label="Resonance"
                    value={sound.resonance}
                    min={0.1}
                    max={20}
                    step={0.1}
                    fmt={(v) => v.toFixed(1)}
                    onChange={(v) => updateSound((s) => (s.resonance = v))}
                  />
                  <Range
                    label="Envelope amount"
                    value={sound.filterEnvAmount}
                    min={0}
                    max={1}
                    step={0.01}
                    fmt={(v) => `${(v * 100).toFixed(0)}%`}
                    onChange={(v) =>
                      updateSound((s) => (s.filterEnvAmount = v))
                    }
                  />
                </div>

                {/* LFO */}
                <div className="mb-3 rounded-lg border border-magenta/30 p-2">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/55">
                    LFO
                  </div>
                  <label className="mb-2 block text-sm">
                    <span className="mb-1 block text-white/70">Target</span>
                    <select
                      value={sound.lfo.target}
                      onChange={(e) =>
                        updateSound(
                          (s) => (s.lfo.target = e.target.value as LfoTarget)
                        )
                      }
                      className="w-full rounded-lg border border-purple/50 bg-purple/25 px-2 py-1.5"
                    >
                      <option value="off">off</option>
                      <option value="pitch">pitch (vibrato)</option>
                      <option value="filter">filter (wobble)</option>
                      <option value="amp">amp (tremolo)</option>
                    </select>
                  </label>
                  <Range
                    label="Rate"
                    value={sound.lfo.rate}
                    min={0.1}
                    max={12}
                    step={0.1}
                    fmt={(v) => `${v.toFixed(1)} Hz`}
                    disabled={sound.lfo.target === "off"}
                    onChange={(v) => updateSound((s) => (s.lfo.rate = v))}
                  />
                  <Range
                    label="Depth"
                    value={sound.lfo.depth}
                    min={0}
                    max={1}
                    step={0.01}
                    fmt={(v) => `${(v * 100).toFixed(0)}%`}
                    disabled={sound.lfo.target === "off"}
                    onChange={(v) => updateSound((s) => (s.lfo.depth = v))}
                  />
                </div>

                {/* Effects */}
                <div className="rounded-lg border border-magenta/30 p-2">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/55">
                    Effects
                  </div>

                  {/* Reverb */}
                  <label className="mb-1 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={sound.fx.reverb.on}
                      onChange={(e) =>
                        updateSound((s) => (s.fx.reverb.on = e.target.checked))
                      }
                    />
                    Reverb
                  </label>
                  <Range
                    label="Amount"
                    value={sound.fx.reverb.amount}
                    min={0}
                    max={1}
                    step={0.01}
                    fmt={(v) => `${(v * 100).toFixed(0)}%`}
                    disabled={!sound.fx.reverb.on}
                    onChange={(v) =>
                      updateSound((s) => (s.fx.reverb.amount = v))
                    }
                  />

                  {/* Delay */}
                  <label className="mb-1 mt-3 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={sound.fx.delay.on}
                      onChange={(e) =>
                        updateSound((s) => (s.fx.delay.on = e.target.checked))
                      }
                    />
                    Delay / echo
                  </label>
                  <Range
                    label="Time"
                    value={sound.fx.delay.time}
                    min={0.02}
                    max={1}
                    step={0.01}
                    fmt={(v) => `${(v * 1000).toFixed(0)} ms`}
                    disabled={!sound.fx.delay.on}
                    onChange={(v) => updateSound((s) => (s.fx.delay.time = v))}
                  />
                  <Range
                    label="Feedback"
                    value={sound.fx.delay.feedback}
                    min={0}
                    max={0.9}
                    step={0.01}
                    fmt={(v) => `${(v * 100).toFixed(0)}%`}
                    disabled={!sound.fx.delay.on}
                    onChange={(v) =>
                      updateSound((s) => (s.fx.delay.feedback = v))
                    }
                  />
                  <Range
                    label="Mix"
                    value={sound.fx.delay.mix}
                    min={0}
                    max={1}
                    step={0.01}
                    fmt={(v) => `${(v * 100).toFixed(0)}%`}
                    disabled={!sound.fx.delay.on}
                    onChange={(v) => updateSound((s) => (s.fx.delay.mix = v))}
                  />

                  {/* Distortion */}
                  <label className="mb-1 mt-3 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={sound.fx.distortion.on}
                      onChange={(e) =>
                        updateSound(
                          (s) => (s.fx.distortion.on = e.target.checked)
                        )
                      }
                    />
                    Distortion / drive
                  </label>
                  <Range
                    label="Amount"
                    value={sound.fx.distortion.amount}
                    min={0}
                    max={1}
                    step={0.01}
                    fmt={(v) => `${(v * 100).toFixed(0)}%`}
                    disabled={!sound.fx.distortion.on}
                    onChange={(v) =>
                      updateSound((s) => (s.fx.distortion.amount = v))
                    }
                  />

                  {/* Chorus */}
                  <label className="mb-1 mt-3 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={sound.fx.chorus.on}
                      onChange={(e) =>
                        updateSound((s) => (s.fx.chorus.on = e.target.checked))
                      }
                    />
                    Chorus
                  </label>
                  <Range
                    label="Amount"
                    value={sound.fx.chorus.amount}
                    min={0}
                    max={1}
                    step={0.01}
                    fmt={(v) => `${(v * 100).toFixed(0)}%`}
                    disabled={!sound.fx.chorus.on}
                    onChange={(v) =>
                      updateSound((s) => (s.fx.chorus.amount = v))
                    }
                  />
                </div>
              </div>
            </details>
          </section>

          {/* Arpeggiator */}
          <section className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-white/70">
                Arpeggiator
              </h2>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={arpOn}
                  onChange={(e) => setArpOn(e.target.checked)}
                />
                On
              </label>
            </div>

            {/* Shared transport tempo (drives arp + drums + metronome). */}
            <label className="mb-3 block text-sm">
              <span className="mb-1 block text-white/70">
                Tempo (shared): {arpBpm} BPM
              </span>
              <input
                type="range"
                min={BPM_MIN}
                max={BPM_MAX}
                step={1}
                value={arpBpm}
                onChange={(e) => setArpBpm(clampBpm(Number(e.target.value)))}
                className="w-full"
              />
            </label>

            <div className={arpOn ? "" : "opacity-50"}>
              <div className="mb-3 text-sm">
                <span className="mb-1 block text-white/70">Pattern</span>
                <div className="grid grid-cols-4 gap-1.5">
                  {(
                    [
                      ["up", "Up"],
                      ["down", "Down"],
                      ["updown", "Up-Dn"],
                      ["random", "Rand"],
                    ] as [ArpPattern, string][]
                  ).map(([p, label]) => (
                    <button
                      key={p}
                      disabled={!arpOn}
                      onClick={() => setArpPattern(p)}
                      className={`rounded-md px-1.5 py-1 text-xs font-medium transition ${
                        arpPattern === p
                          ? "bg-orange text-ink"
                          : "bg-purple/25 text-white/90 hover:bg-magenta/40"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <label className="mb-3 block text-sm">
                <span className="mb-1 block text-white/70">Rate</span>
                <select
                  disabled={!arpOn}
                  value={arpDivision}
                  onChange={(e) =>
                    setArpDivision(e.target.value as ArpDivision)
                  }
                  className="w-full rounded-lg border border-purple/50 bg-purple/25 px-2 py-1.5"
                >
                  <option value="1/4">1/4</option>
                  <option value="1/8">1/8</option>
                  <option value="1/16">1/16</option>
                  <option value="1/8T">1/8 triplet</option>
                  <option value="1/16T">1/16 triplet</option>
                </select>
              </label>

              <label className="mb-3 block text-sm">
                <span className="mb-1 block text-white/70">
                  Octave range: {arpOctaves}
                </span>
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={1}
                  disabled={!arpOn}
                  value={arpOctaves}
                  onChange={(e) => setArpOctaves(Number(e.target.value))}
                  className="w-full"
                />
              </label>

              <label className="block text-sm">
                <span className="mb-1 block text-white/70">
                  Gate (note length): {(arpGate * 100).toFixed(0)}%
                </span>
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  disabled={!arpOn}
                  value={arpGate}
                  onChange={(e) => setArpGate(Number(e.target.value))}
                  className="w-full"
                />
              </label>
            </div>
          </section>

          {/* Drums + metronome */}
          <section className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
            <details>
              <summary className="cursor-pointer list-none text-sm font-semibold uppercase tracking-wide text-white/70">
                Drums &amp; metronome
              </summary>
              <div className="mt-3">
                <div className="mb-3 flex items-center gap-4 text-sm">
                </div>

                <p className="mb-3 text-xs text-white/45">
                  Drums, bass, the metronome and the beat grid live under the
                  chord readout now, where there is room to work on them.
                </p>


                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/55">
                  Instruments
                </div>
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={kickOn}
                      onChange={(e) => setKickOn(e.target.checked)}
                    />
                    Kick
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={snareOn}
                      onChange={(e) => setSnareOn(e.target.checked)}
                    />
                    Snare
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={clapOn}
                      onChange={(e) => setClapOn(e.target.checked)}
                    />
                    Clap
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={hatOn}
                      onChange={(e) => setHatOn(e.target.checked)}
                    />
                    Hi-hat
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={tomOn}
                      onChange={(e) => setTomOn(e.target.checked)}
                    />
                    Tom
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={shakerOn}
                      onChange={(e) => setShakerOn(e.target.checked)}
                    />
                    Shaker
                  </label>
                </div>

                <p className="mt-3 text-xs text-white/55">
                  These mute a whole lane. Tempo, pattern, the grid and the
                  bassline are in the beat panel under the chord readout.
                </p>
              </div>
            </details>
          </section>

          {/* Vocal harmonizer */}
          <section className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-white/70">
                Harmonizer
              </h2>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={harmonizerOn}
                  disabled={!started}
                  onChange={(e) => toggleHarmonizer(e.target.checked)}
                />
                On
              </label>
            </div>
            <p className="text-xs text-white/55">
              Sing into your mic and hold a chord with a gesture: your voice is
              copied onto every tone of that chord. Sing a note and hold C major
              to hear yourself at C, E and G.
            </p>
            {!started && (
              <p className="mt-2 text-xs text-white/40">
                Enable camera &amp; sound first.
              </p>
            )}
            {micError && (
              <p className="mt-2 text-xs text-orange">{micError}</p>
            )}

            {/* Live detected-pitch readout so you can see your voice arriving. */}
            <div className="mt-3 flex items-center justify-between rounded-md bg-purple/25 px-2 py-1.5 text-sm">
              <span className="text-white/70">Detected pitch</span>
              <span className="font-mono text-yellow">
                {harmonizerOn && sungPitch
                  ? `${freqToNoteLabel(sungPitch)} · ${sungPitch.toFixed(0)} Hz`
                  : harmonizerOn
                    ? "listening…"
                    : "off"}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-white/45">
              The input level meter in the Looper panel shows your mic level.
              Pick the Instrument or Mix loop source to record the harmony.
            </p>

            <label className={`mt-3 block text-sm ${harmonizerOn ? "" : "opacity-50"}`}>
              <span className="mb-1 block text-white/70">
                Dry / wet: {(harmonizerDryWet * 100).toFixed(0)}%
                <span className="ml-1 text-xs text-white/40">
                  (voice → harmonies)
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                disabled={!harmonizerOn}
                value={harmonizerDryWet}
                onChange={(e) => setHarmonizerDryWet(Number(e.target.value))}
                className="w-full"
              />
            </label>

            <label className={`mt-2 block text-sm ${harmonizerOn ? "" : "opacity-50"}`}>
              <span className="mb-1 block text-white/70">
                Output level: {(harmonizerLevel * 100).toFixed(0)}%
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                disabled={!harmonizerOn}
                value={harmonizerLevel}
                onChange={(e) => setHarmonizerLevel(Number(e.target.value))}
                className="w-full"
              />
            </label>

            <label className="mt-2 block text-sm">
              <span className="mb-1 block text-white/70">
                Voices: {harmonizerVoices}
                <span className="ml-1 text-xs text-white/40">
                  (max chord tones)
                </span>
              </span>
              <input
                type="range"
                min={1}
                max={4}
                step={1}
                value={harmonizerVoices}
                onChange={(e) => setHarmonizerVoices(Number(e.target.value))}
                className="w-full"
              />
            </label>

            <label className="mt-2 block text-sm">
              <span className="mb-1 block text-white/70">
                Span: {harmonizerSpan <= 0 ? "tight" : `${Math.round(harmonizerSpan * 100)}%`}
                <span className="ml-1 text-xs text-white/40">
                  (how wide the stack sits)
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={harmonizerSpan}
                onChange={(e) => setHarmonizerSpan(Number(e.target.value))}
                className="w-full"
              />
            </label>
            <p className="mt-1 text-[11px] text-white/45">
              At nothing, every harmony sits in the octave nearest your voice -
              the tightest, most vocal stack. Opening it drops the lowest voice
              and lifts the highest, by whole octaves so they stay chord tones,
              widening from the outside in.
            </p>

            <p className="mt-3 text-[11px] text-white/45">
              Real-time pitch shifting in the browser has some latency and
              artifacts; aim for a recognizable harmony, not a studio effect.
            </p>
          </section>

          {/* Vocal looper */}
          <section className="rounded-2xl border border-magenta/30 bg-purple/15 p-4">
            <details>
              <summary className="cursor-pointer list-none text-sm font-semibold uppercase tracking-wide text-white/70">
                Looper{" "}
                <span className="text-white/40">({loopTracks.length})</span>
                {loopRecording && (
                  <span className="text-orange"> recording</span>
                )}
              </summary>

              <div className="mt-3">
                {/* Source */}
                <div className="mb-3 text-sm">
                  <span className="mb-1 block text-white/70">Source</span>
                  <div className="grid grid-cols-3 gap-1.5">
                    {(
                      [
                        ["mic", "Mic"],
                        ["instrument", "Instrument"],
                        ["mix", "Mix"],
                      ] as [RecordSource, string][]
                    ).map(([s, label]) => (
                      <button
                        key={s}
                        onClick={() => selectLoopSource(s)}
                        className={`rounded-md px-2 py-1 text-xs font-medium transition ${
                          loopSource === s
                            ? "bg-yellow text-ink"
                            : "bg-purple/25 text-white/90 hover:bg-magenta/40"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Live input level meter for the selected source */}
                <InputLevelMeter
                  meter={inputMeterRef}
                  active={started}
                  label={
                    loopSource === "mic"
                      ? "Mic"
                      : loopSource === "mix"
                        ? "Mix"
                        : "Instrument"
                  }
                  unavailable={
                    (loopSource === "mic" || loopSource === "mix") && !micReady
                      ? "Microphone not available yet. Pick Mic or Mix to allow it, or check your browser permission."
                      : null
                  }
                />

                {/* Loop length */}
                <div className="mb-3 text-sm">
                  <span className="mb-1 block text-white/70">Loop length</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {[1, 2, 4, 8].map((b) => (
                      <button
                        key={b}
                        disabled={loopFree}
                        onClick={() => setLoopBars(b)}
                        className={`rounded-md px-2 py-1 text-xs font-medium transition ${
                          loopFree
                            ? "cursor-not-allowed bg-purple/10 text-white/30"
                            : loopBars === b
                              ? "bg-magenta text-ink"
                              : "bg-purple/25 text-white/90 hover:bg-magenta/40"
                        }`}
                      >
                        {b} {b === 1 ? "bar" : "bars"}
                      </button>
                    ))}
                    <label className="ml-1 flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={loopFree}
                        onChange={(e) => setLoopFree(e.target.checked)}
                      />
                      Free
                    </label>
                  </div>
                  <label className="mt-2 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={loopCountIn}
                      onChange={(e) => setLoopCountIn(e.target.checked)}
                    />
                    Count-in (1 bar)
                  </label>
                </div>

                {/* Continuous vocal-stack capture */}
                <fieldset className="mb-3 rounded-xl border border-magenta/25 bg-ink/20 p-3">
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={loopCycleOn}
                      disabled={loopFree || loopRecording}
                      onChange={(e) => setLoopCycleOn(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="block text-sm font-medium text-white/90">
                        Continuous vocal stack
                      </span>
                      <span className="block text-[11px] leading-4 text-white/50">
                        Record one take per loop pass and stop automatically.
                      </span>
                    </span>
                  </label>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <label htmlFor="loop-stack-takes" className="text-white/65">
                      Stack size
                    </label>
                    <select
                      id="loop-stack-takes"
                      aria-label="Vocal stack size"
                      value={loopStackTakes}
                      disabled={!loopCycleOn || loopFree || loopRecording}
                      onChange={(e) => setLoopStackTakes(Number(e.target.value))}
                      className="rounded-md border border-purple/50 bg-purple/30 px-2 py-1 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {[2, 3, 4, 6].map((takes) => (
                        <option key={takes} value={takes}>
                          {takes} takes
                        </option>
                      ))}
                    </select>
                    {loopFree && (
                      <span className="text-orange/80">
                        Choose a fixed loop length to stack passes.
                      </span>
                    )}
                  </div>

                  {loopCycleProgress && loopCycleProgress.target > 0 && (
                    <div
                      className="mt-3"
                      role="status"
                      aria-label={`${loopCycleProgress.recorded} of ${loopCycleProgress.target} vocal takes recorded`}
                    >
                      <div className="mb-1 flex items-center justify-between text-[11px]">
                        <span className="text-white/60">
                          {loopCycleProgress.active
                            ? loopCycleProgress.recorded === 0
                              ? "Count-in / waiting for loop boundary"
                              : "Capturing next pass"
                            : "Stack complete"}
                        </span>
                        <span className="font-semibold text-yellow">
                          {loopCycleProgress.recorded}/{loopCycleProgress.target}
                        </span>
                      </div>
                      <div className="grid grid-flow-col gap-1" aria-hidden="true">
                        {Array.from({ length: loopCycleProgress.target }, (_, i) => (
                          <span
                            key={i}
                            className={`h-1.5 rounded-full ${
                              i < loopCycleProgress.recorded
                                ? "bg-yellow"
                                : loopCycleProgress.active &&
                                    i === loopCycleProgress.recorded
                                  ? "animate-pulse bg-orange"
                                  : "bg-purple/45"
                            }`}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </fieldset>

                {/* Transport */}
                <div className="mb-3 flex flex-wrap gap-2">
                  <button
                    onClick={toggleLoopRecord}
                    disabled={!started}
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                      !started
                        ? "cursor-not-allowed bg-purple/25 text-white/40"
                        : loopRecording
                          ? "bg-orange text-ink hover:bg-yellow"
                          : "bg-magenta text-ink hover:bg-magenta/80"
                    }`}
                  >
                    {loopRecording
                      ? loopCycleOn && !loopFree
                        ? "Stop stack"
                        : "Stop take"
                      : loopCycleOn && !loopFree
                        ? `Record ${loopStackTakes}-pass stack`
                        : "Record take"}
                  </button>
                  <button
                    onClick={() =>
                      loopPlaying
                        ? looperRef.current?.stopAll()
                        : looperRef.current?.playAll()
                    }
                    disabled={loopTracks.length === 0}
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                      loopTracks.length === 0
                        ? "cursor-not-allowed bg-purple/25 text-white/40"
                        : "bg-purple/45 text-white hover:bg-magenta/40"
                    }`}
                  >
                    {loopPlaying ? "Stop all" : "Play all"}
                  </button>
                  <button
                    onClick={() => looperRef.current?.clearAll()}
                    disabled={loopTracks.length === 0}
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                      loopTracks.length === 0
                        ? "cursor-not-allowed bg-purple/25 text-white/40"
                        : "bg-purple/45 text-white hover:bg-magenta/40"
                    }`}
                  >
                    Clear all
                  </button>
                </div>

                {/* Track list */}
                {loopTracks.length === 0 ? (
                  <p className="text-xs text-white/55">
                    No loops yet. Record a continuous stack to capture several
                    phase-locked vocal passes without touching the controls.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {loopTracks.map((t) => (
                      <li
                        key={t.id}
                        className="rounded-lg border border-magenta/20 bg-purple/10 p-2"
                      >
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-white/90">
                            {t.name}{" "}
                            <span className="text-xs text-white/40">
                              ({t.source})
                            </span>
                          </span>
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() =>
                                looperRef.current?.setMute(t.id, !t.muted)
                              }
                              className={`rounded px-2 py-0.5 text-xs font-medium ${
                                t.muted
                                  ? "bg-orange text-ink"
                                  : "bg-purple/25 text-white/80 hover:bg-magenta/40"
                              }`}
                            >
                              M
                            </button>
                            <button
                              onClick={() =>
                                looperRef.current?.setSolo(t.id, !t.solo)
                              }
                              className={`rounded px-2 py-0.5 text-xs font-medium ${
                                t.solo
                                  ? "bg-yellow text-ink"
                                  : "bg-purple/25 text-white/80 hover:bg-magenta/40"
                              }`}
                            >
                              S
                            </button>
                            <button
                              onClick={() => suggestHarmonies(t.id)}
                              className="rounded bg-purple/25 px-2 py-0.5 text-xs text-white/80 hover:bg-magenta/40"
                              title="Listen back and suggest a key and chords for this take"
                            >
                              Harmonies
                            </button>
                            <button
                              onClick={() => downloadTake(t.id)}
                              className="rounded bg-purple/25 px-2 py-0.5 text-xs text-white/80 hover:bg-magenta/40"
                              title="Download this take"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => looperRef.current?.deleteTrack(t.id)}
                              className="rounded bg-purple/25 px-2 py-0.5 text-xs text-white/80 hover:bg-magenta/40"
                              title="Delete this take"
                            >
                              Del
                            </button>
                          </div>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={t.volume}
                          onChange={(e) =>
                            looperRef.current?.setVolume(
                              t.id,
                              Number(e.target.value)
                            )
                          }
                          className="mt-1 w-full"
                        />
                      </li>
                    ))}
                  </ul>
                )}

                {/* What dice heard in the take it was pointed at. */}
                {melody && (
                  <div className="mt-3 rounded-lg border border-magenta/30 bg-purple/10 p-2 text-xs">
                    <div className="mb-1 flex items-baseline justify-between gap-2">
                      <span className="font-semibold uppercase tracking-wide text-white/70">
                        Harmonies for{" "}
                        {loopTracks.find((t) => t.id === melody.id)?.name ?? "the take"}
                      </span>
                      <button
                        onClick={() => setMelody(null)}
                        className="text-white/45 hover:text-white/80"
                      >
                        close
                      </button>
                    </div>

                    {melody.analysis.key ? (
                      <>
                        <p className="text-white/80">
                          Sounds like{" "}
                          <span className="font-semibold">
                            {NOTE_NAMES[melody.analysis.key.tonic]}{" "}
                            {melody.analysis.key.scale}
                          </span>
                          <span className="text-white/45">
                            {" "}
                            · {melody.analysis.notes.length} notes
                            {melody.analysis.range &&
                              ` · ${midiToName(melody.analysis.range.low)} to ${midiToName(
                                melody.analysis.range.high
                              )}`}
                            {melody.analysis.key.confidence < 0.25 && " · not certain"}
                          </span>
                        </p>
                        {melody.analysis.chords.length > 0 && (
                          <p className="mt-1 font-mono text-white/90">
                            {melody.analysis.chords.join("  ")}
                          </p>
                        )}
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <button
                            onClick={useSuggestedKey}
                            className="rounded bg-purple/30 px-2 py-1 text-white/85 hover:bg-magenta/40"
                          >
                            use this key
                          </button>
                          {melody.analysis.chords.length > 0 && (
                            <button
                              onClick={useSuggestedChords}
                              className="rounded bg-purple/30 px-2 py-1 text-white/85 hover:bg-magenta/40"
                            >
                              play these chords
                            </button>
                          )}
                        </div>
                        <p className="mt-2 text-[11px] leading-relaxed text-white/45">
                          Hold these with your hand and the harmonizer sings onto
                          them: it harmonises to the chord you are holding, so
                          this is how it learns what your melody was.
                        </p>
                      </>
                    ) : (
                      <p className="text-white/60">
                        Not enough pitch in that take to call it - it needs a few
                        sung notes rather than beatboxing or a held sound.
                      </p>
                    )}
                  </div>
                )}

                {/* Export */}
                <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-white/70">Export</span>
                  <select
                    value={exportCycles}
                    onChange={(e) => setExportCycles(Number(e.target.value))}
                    className="rounded-lg border border-purple/50 bg-purple/25 px-2 py-1"
                  >
                    {[1, 2, 4, 8].map((c) => (
                      <option key={c} value={c}>
                        {c} {c === 1 ? "cycle" : "cycles"}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={exportMix}
                    disabled={loopTracks.length === 0}
                    className={`rounded-lg px-3 py-1 text-sm font-medium transition ${
                      loopTracks.length === 0
                        ? "cursor-not-allowed bg-purple/25 text-white/40"
                        : "bg-yellow text-ink hover:bg-orange"
                    }`}
                  >
                    Export mix
                  </button>
                </div>

                {!started && (
                  <p className="mt-2 text-xs text-white/40">
                    Enable camera &amp; sound first.
                  </p>
                )}
                <p className="mt-2 text-xs text-white/55">
                  Mic and Mix takes need a real microphone. Loops lock to the
                  shared transport BPM and route through the master recorder.
                </p>
                {loopError && (
                  <p className="mt-1 text-xs text-orange">{loopError}</p>
                )}
              </div>
            </details>
          </section>

        </aside>
      </div>

      <footer className="mt-8 text-xs text-white/40">
        Best in Chrome/Edge. Camera requires HTTPS or localhost. Hand tracking:
        MediaPipe Tasks Vision · Audio: Web Audio API.
      </footer>
    </div>
  );
}
