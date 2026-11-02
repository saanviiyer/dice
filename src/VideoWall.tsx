// VideoWall.tsx - the photobooth: record yourself, stack the takes, bounce one video.
//
// Recording used to live in a panel of its own, above the wall, with a button
// labelled "Stop & download" that had not downloaded anything since takes
// started landing here. So the one thing this surface is for - sing a part,
// sing another over the top, watch them play together - was split across two
// boxes that never mentioned each other, and the second take had nothing to
// sing along to.
//
// It is one place now, and it does the three things stacking actually needs:
//
//   - a count-in, so you know where the downbeat is;
//   - the takes already on the wall play while you record the next one, so the
//     new part lands on top of the old ones instead of near them;
//   - your live camera sits in the next empty cell, so the grid you are about
//     to make is the grid you are looking at.
//
// The guide takes play to the speakers, not through the studio's record bus, so
// they are never baked into the new take: the wall mixes every take on export
// and hearing one twice is not stacking, it is a mistake you cannot undo.
// Headphones keep them out of the microphone too.
//
// The layout maths is in lib/videowall.ts, the lyric timing in lib/lyrics.ts;
// this file is the surface, the transport and the bounce.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_TAKES,
  cellRects,
  coverSource,
  visibleTakes,
  wallDurationMs,
  wallGrid,
  type VideoTake,
} from "./lib/videowall";
import { lyricAt, parseLyrics, wrapLyric } from "./lib/lyrics";
import {
  driftCorrection,
  looksPlayable,
  measureLeadInMs,
  takeLevel,
} from "./lib/videowall";

export interface VideoWallProps {
  takes: VideoTake[];
  onChange(next: VideoTake[]): void;
  /** The AudioContext the studio is already using, for mixing on export. */
  getContext(): AudioContext | null;

  /** Recording lives here now: the wall is where the takes are going. */
  recording: boolean;
  /** False until camera and sound are on. */
  canRecord: boolean;
  elapsedMs: number;
  /** Start the recorder. Resolves with when it started, or null if it did not. */
  onRecord(opts: {
    voiceOnly: boolean;
  }): Promise<{ startedAt: number; inputLatencySec: number } | null>;
  /** How much of the head of the take being recorded to skip on playback. */
  onLeadIn(ms: number): void;
  onStop(): void;
  recordError?: string;
  /** The live camera, drawn in the next cell so the wall previews itself. */
  getCameraStream(): MediaStream | null;
  /** Clicks a bar in before recording starts. Resolves when the bar is over. */
  onCountIn(beats: number): Promise<void>;

  /** The words, shown as a prompt while you sing and burnt into the bounce. */
  lyrics: string;
  onLyrics(next: string): void;

  /**
   * Bring clips in from files, so the wall can be produced over rather than
   * only recorded into. Ids are minted by the studio, which owns them.
   */
  onImport(files: File[]): void;
}

const EXPORT_WIDTH = 1280;
const EXPORT_HEIGHT = 720;
const EXPORT_FPS = 30;
const COUNT_IN_BEATS = 4;
/** The most a take's start can be moved by hand, in milliseconds. */
const MAX_NUDGE_MS = 3000;

/**
 * Get a paused video to a position and hold until it can play from there.
 *
 * A take that has never played has nothing loaded, so its first seek and first
 * play are slow. Measured in the studio, a new take started 412ms after the take
 * beside it and stayed that far behind. Waiting here, before anything starts,
 * lets every take start from the same instant. The timeout means one bad file
 * cannot hold the wall up.
 */
function primeVideo(v: HTMLVideoElement, seconds: number, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      v.removeEventListener("seeked", check);
      v.removeEventListener("canplay", check);
      v.removeEventListener("error", finish);
      resolve();
    };
    const check = () => {
      if (!v.seeking && v.readyState >= 3) finish();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    v.addEventListener("seeked", check);
    v.addEventListener("canplay", check);
    v.addEventListener("error", finish);
    v.pause();
    if (Math.abs(v.currentTime - seconds) > 0.001) v.currentTime = seconds;
    check();
  });
}

/** Roughly how many characters of caption fit across the picture. */
const CAPTION_CHARS = 40;

/**
 * How loud the wall runs while you are recording over it.
 *
 * The guide only has to be loud enough to sing with. Running it at full level
 * puts it in the room loudly enough for the microphone to hear, and a take with
 * the earlier takes bleeding into it plays back against the originals a few
 * milliseconds out - which is not a stack, it is a flanger.
 */
const GUIDE_LEVEL = 0.55;

function pickMime(list: string[]): string {
  for (const m of list) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Draw the caption onto an export frame.
 *
 * The type shrinks until it fits rather than running off the sides, because a
 * caption that leaves the frame is worse than a smaller one that does not, and
 * an outline goes under it because lyrics land on whatever the singer happened
 * to be wearing.
 */
function drawCaption(
  g: CanvasRenderingContext2D,
  text: string,
  width: number,
  height: number
): void {
  if (!text) return;
  const rows = wrapLyric(text, CAPTION_CHARS, 2);
  if (rows.length === 0) return;
  let size = Math.round(height * 0.062);
  const font = (px: number) =>
    `600 ${px}px "Helvetica Neue", Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  g.font = font(size);
  while (size > 12 && rows.some((row) => g.measureText(row).width > width * 0.9)) {
    size -= 2;
    g.font = font(size);
  }
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  g.lineJoin = "round";
  g.lineWidth = Math.max(2, size * 0.16);
  g.strokeStyle = "rgba(38,12,6,0.85)";
  g.fillStyle = "#f5f2ed";
  const lineHeight = size * 1.25;
  const bottom = height - Math.round(height * 0.055);
  rows.forEach((row, i) => {
    const y = bottom - (rows.length - 1 - i) * lineHeight;
    g.strokeText(row, width / 2, y);
    g.fillText(row, width / 2, y);
  });
}

export default function VideoWall({
  takes,
  onChange,
  getContext,
  recording,
  canRecord,
  elapsedMs,
  onRecord,
  onLeadIn,
  onStop,
  recordError,
  getCameraStream,
  onCountIn,
  lyrics,
  onLyrics,
  onImport,
}: VideoWallProps) {
  const [playing, setPlaying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [countingIn, setCountingIn] = useState(false);
  const [error, setError] = useState("");
  const [countIn, setCountIn] = useState(true);
  const [singAlong, setSingAlong] = useState(true);
  /** Null until chosen. Then a stacked take defaults to the microphone alone. */
  const [voiceOnlyChoice, setVoiceOnlyChoice] = useState<boolean | null>(null);
  const [positionMs, setPositionMs] = useState(0);
  /** Whether what is playing is the guide for a take being recorded. */
  const [guiding, setGuiding] = useState(false);
  // The take waiting on a second click before it goes. A take cannot be got
  // back - the blob is dropped and its object URL revoked - so deleting one is
  // two clicks rather than a modal nobody reads.
  const [confirming, setConfirming] = useState<number | null>(null);
  /** The wall over the whole window, for looking at rather than working beside. */
  const [expanded, setExpanded] = useState(false);

  const videoRefs = useRef(new Map<number, HTMLVideoElement>());
  const liveRef = useRef<HTMLVideoElement | null>(null);
  // createMediaElementSource may only be called once per element, so the node
  // is cached and reused for every subsequent export.
  const sourceRefs = useRef(new Map<number, MediaElementAudioSourceNode>());
  /** One fader per take, so the stack can be gain-staged as it grows. */
  const takeGains = useRef(new Map<number, GainNode>());
  const busRef = useRef<{
    ctx: AudioContext;
    input: GainNode;
    output: GainNode;
  } | null>(null);

  /** Clock time at which the wall was at its start, read from a playing take. */
  const anchorRef = useRef<number | null>(null);
  /** Bumped by every stop, so a start still getting ready knows to give up. */
  const playTicket = useRef(0);
  const lastSeekRef = useRef(new Map<number, number>());

  const shown = useMemo(() => visibleTakes(takes), [takes]);
  const hiddenTakes = useMemo(() => takes.filter((t) => t.hidden), [takes]);
  const durationMs = wallDurationMs(takes);
  const full = shown.length >= MAX_TAKES;
  const voiceOnly = voiceOnlyChoice ?? shown.length > 0;

  // The live cell is the slot the next take will fill, so the grid is laid out
  // with room for it while there is room to be had. No camera, no cell: a
  // denied camera would otherwise leave a black square promising a picture.
  const liveCell = canRecord && !!getCameraStream() && !full && !exporting;
  const grid = wallGrid(shown.length + (liveCell ? 1 : 0));

  /**
   * Cues need a length to spread across, and the wall's length is set by the
   * takes on it. Before the first take there is nothing to time against, so the
   * words are shown as a plain sheet to read from instead of being guessed at.
   */
  const cues = useMemo(() => parseLyrics(lyrics, durationMs), [lyrics, durationMs]);
  const timedPrompt = cues.length > 0;
  // While the guide runs, its position is the song's position. The recorder's
  // own clock is slightly ahead of it.
  const promptLine = recording
    ? lyricAt(cues, playing ? positionMs : elapsedMs)
    : playing
      ? lyricAt(cues, positionMs)
      : "";
  const lyricLines = useMemo(
    () => lyrics.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
    [lyrics]
  );

  const each = useCallback(
    (fn: (v: HTMLVideoElement, take: VideoTake) => void) => {
      for (const t of shown) {
        const v = videoRefs.current.get(t.id);
        if (v) fn(v, t);
      }
    },
    [shown]
  );

  /**
   * The wall's own bus: every take's audio, gain-staged, through a limiter.
   *
   * Takes used to play straight out of their video elements, which means four
   * vocal takes were four full-scale signals summed at the output with nothing
   * in between. That clips, and clipping is what "the harmonies sound
   * distorted" actually is. The looper has had a limiter on its loop bus since
   * loops could stack, for exactly this reason; the wall never got one.
   */
  const ensureBus = useCallback(() => {
    const ctx = getContext();
    if (!ctx) return null;
    if (busRef.current && busRef.current.ctx === ctx) return busRef.current;
    const input = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.25;
    // The compressor adds makeup gain of its own, which this takes back out.
    const output = ctx.createGain();
    output.gain.value = 0.75;
    input.connect(limiter);
    limiter.connect(output);
    output.connect(ctx.destination);
    const made = { ctx, input, output };
    busRef.current = made;
    return made;
  }, [getContext]);

  /** Put one take on the bus, once, and hand back its fader. */
  const routeTake = useCallback(
    (bus: { ctx: AudioContext; input: GainNode }, id: number, el: HTMLVideoElement) => {
      const existing = takeGains.current.get(id);
      if (existing) return existing;
      let src = sourceRefs.current.get(id);
      if (!src) {
        src = bus.ctx.createMediaElementSource(el);
        sourceRefs.current.set(id, src);
      }
      const gain = bus.ctx.createGain();
      src.connect(gain);
      gain.connect(bus.input);
      takeGains.current.set(id, gain);
      return gain;
    },
    []
  );

  /**
   * How loud each take should be, given how many are playing.
   *
   * Equal power rather than one-over-n: separate takes of a voice are not the
   * same signal, so they sum closer to the square root of their number than to
   * their number. One take plays at unity, four at half, and the limiter is
   * left with only the correlated peaks to catch.
   */
  const stageLevels = useCallback(
    (guide: boolean) => {
      const audible = shown.filter((t) => !t.muted).length || 1;
      const bus = busRef.current;
      for (const t of shown) {
        const v = videoRefs.current.get(t.id);
        if (!v) continue;
        const want = takeLevel(t, audible, guide ? GUIDE_LEVEL : 1);
        const gain = takeGains.current.get(t.id);
        if (bus && gain) {
          gain.gain.setTargetAtTime(want, bus.ctx.currentTime, 0.02);
          v.volume = 1; // the level lives on the bus now
        } else {
          // No audio graph available: stage on the element instead, which is
          // worse than a limiter and far better than nothing.
          v.volume = want;
        }
      }
    },
    [shown]
  );

  const stopAll = useCallback(() => {
    playTicket.current += 1;
    anchorRef.current = null;
    each((v, take) => {
      v.pause();
      v.playbackRate = 1;
      v.currentTime = (take.leadInMs ?? 0) / 1000;
    });
    setPlaying(false);
    setGuiding(false);
    setPositionMs(0);
  }, [each]);

  /** Get every take on the wall ready to start from its own first note. */
  const prepareTakes = useCallback(async () => {
    await Promise.all(
      shown.map((t) => {
        const v = videoRefs.current.get(t.id);
        return v && !t.broken ? primeVideo(v, (t.leadInMs ?? 0) / 1000) : undefined;
      })
    );
  }, [shown]);

  /**
   * Start the prepared takes together.
   *
   * Resolves with the clock time the wall was at its start, read from where a
   * playing take really is, or null if nothing played.
   */
  const playNow = useCallback(
    (opts: { guide?: boolean } = {}): Promise<number | null> => {
      setError("");
      const bus = ensureBus();
      // The click that started this is a user gesture, so a suspended context
      // will resume. If it does not, the takes are left playing themselves:
      // routing them into a context that never starts would be silence.
      if (bus && bus.ctx.state === "suspended") void bus.ctx.resume();
      const live = bus && bus.ctx.state === "running" ? bus : null;

      const starts: Promise<unknown>[] = [];
      anchorRef.current = null;
      lastSeekRef.current.clear();
      each((v, take) => {
        // A muted take keeps its picture and loses its sound, which is how you
        // produce over an imported clip: the video stays, the audio is yours.
        v.muted = !!take.muted;
        v.playbackRate = 1;
        if (live) routeTake(live, take.id, v);
        starts.push(
          v.play().catch(() => {
            /* a take that will not play is reported by the wall, not thrown */
          })
        );
      });
      setGuiding(opts.guide === true);
      stageLevels(opts.guide === true);
      setPlaying(true);

      const ticket = playTicket.current;
      return Promise.race([
        Promise.all(starts),
        new Promise((resolve) => window.setTimeout(resolve, 1500)),
      ]).then(() => {
        if (ticket !== playTicket.current) return null;
        const master = shown.find((t) => {
          const v = videoRefs.current.get(t.id);
          return v && !t.broken && !v.paused;
        });
        const v = master && videoRefs.current.get(master.id);
        if (!master || !v) return null;
        const anchor = performance.now() - (v.currentTime - (master.leadInMs ?? 0) / 1000) * 1000;
        anchorRef.current = anchor;
        return anchor;
      });
    },
    [each, ensureBus, routeTake, shown, stageLevels]
  );

  const playAll = useCallback(async () => {
    const ticket = ++playTicket.current;
    await prepareTakes();
    if (ticket !== playTicket.current) return;
    await playNow();
  }, [prepareTakes, playNow]);

  // Show the live camera in the empty cell. Attached in an effect rather than
  // during render because the stream arrives when the camera does, which is
  // long after this component first draws.
  useEffect(() => {
    const el = liveRef.current;
    if (!el) return;
    const stream = getCameraStream();
    if (stream && el.srcObject !== stream) {
      el.srcObject = stream;
      void el.play().catch(() => {
        /* autoplay refusals are not worth an error on a muted preview */
      });
    }
  }, [liveCell, getCameraStream]);

  // A fader moved mid-play has to be heard while it is being moved, which is
  // the only way to balance a mix.
  useEffect(() => {
    if (playing) stageLevels(guiding);
  }, [playing, guiding, stageLevels]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    const wasOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = wasOverflow;
    };
  }, [expanded]);

  // Playhead, for the caption during playback.
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const anchor = anchorRef.current;
      if (anchor !== null) setPositionMs(performance.now() - anchor);
    }, 100);
    return () => window.clearInterval(timer);
  }, [playing]);

  // Hold the takes together while they play. Each is its own media element on
  // its own clock, so a good start is not enough on its own.
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const anchor = anchorRef.current;
      if (anchor === null) return;
      const now = performance.now();
      for (const t of shown) {
        const v = videoRefs.current.get(t.id);
        if (!v || t.broken || v.paused || v.ended || v.seeking) continue;
        const target = (now - anchor) / 1000 + (t.leadInMs ?? 0) / 1000;
        if (Number.isFinite(v.duration) && target >= v.duration) continue;
        const fix = driftCorrection(v.currentTime - target);
        if (fix.seekBy !== null) {
          // A seek takes time to land, so give it a moment before judging it.
          if (now - (lastSeekRef.current.get(t.id) ?? -Infinity) < 1000) continue;
          lastSeekRef.current.set(t.id, now);
          v.playbackRate = 1;
          v.currentTime = target;
        } else {
          v.playbackRate = fix.rate;
        }
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, [playing, shown]);

  // When the longest take ends, the wall has finished.
  useEffect(() => {
    if (!playing) return;
    if (durationMs <= 0) return;
    const timer = window.setTimeout(() => setPlaying(false), durationMs + 250);
    return () => window.clearTimeout(timer);
  }, [playing, durationMs]);

  const setDuration = useCallback(
    (id: number, seconds: number) => {
      if (!Number.isFinite(seconds) || seconds <= 0) return;
      const ms = Math.round(seconds * 1000);
      onChange(takes.map((t) => (t.id === id ? { ...t, durationMs: ms } : t)));
    },
    [takes, onChange]
  );

  const remove = useCallback(
    (id: number) => {
      const gone = takes.find((t) => t.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      videoRefs.current.delete(id);
      sourceRefs.current.delete(id);
      takeGains.current.get(id)?.disconnect();
      takeGains.current.delete(id);
      setConfirming(null);
      onChange(takes.filter((t) => t.id !== id));
    },
    [takes, onChange]
  );

  /** First click arms the delete, second one does it. */
  const askDelete = useCallback(
    (id: number) => setConfirming((current) => (current === id ? null : id)),
    []
  );

  // An armed delete goes cold on its own, so a stray click cannot sit there
  // waiting to catch the next one.
  useEffect(() => {
    if (confirming === null) return;
    const timer = window.setTimeout(() => setConfirming(null), 4000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const setLevel = useCallback(
    (id: number, level: number) =>
      onChange(takes.map((t) => (t.id === id ? { ...t, level } : t))),
    [takes, onChange]
  );

  const setLeadIn = useCallback(
    (id: number, leadInMs: number) =>
      onChange(takes.map((t) => (t.id === id ? { ...t, leadInMs } : t))),
    [takes, onChange]
  );

  const toggleMuted = useCallback(
    (id: number) => onChange(takes.map((t) => (t.id === id ? { ...t, muted: !t.muted } : t))),
    [takes, onChange]
  );

  /** Mark a clip this browser turned out not to be able to decode. */
  const markBroken = useCallback(
    (id: number) =>
      onChange(takes.map((t) => (t.id === id ? { ...t, broken: true } : t))),
    [takes, onChange]
  );

  const pickFiles = useCallback(
    (list: FileList | null) => {
      const files = Array.from(list ?? []);
      if (files.length === 0) return;
      const usable = files.filter(looksPlayable);
      if (usable.length === 0) {
        setError("That file is not a video this browser can open.");
        return;
      }
      const room = Math.max(0, MAX_TAKES - takes.length);
      const notes: string[] = [];
      if (usable.length < files.length) notes.push("some of those were not videos");
      if (usable.length > room) {
        notes.push(`the wall holds ${MAX_TAKES}, so ${usable.length - room} did not fit`);
      }
      setError(notes.length > 0 ? `${notes.join("; ")}.` : "");
      onImport(usable);
    },
    [onImport, takes.length]
  );

  const toggleHidden = useCallback(
    (id: number) => onChange(takes.map((t) => (t.id === id ? { ...t, hidden: !t.hidden } : t))),
    [takes, onChange]
  );

  /**
   * Start a take: get the guide ready, count in, roll, then start the guide.
   *
   * The guide is readied before the count-in so it can start the moment the
   * count ends. The recorder goes first because a take can skip its own first
   * moments on playback and cannot get back a moment it never recorded. How far
   * the guide really started behind the recorder is measured, along with the
   * audio latency the browser reports, and stored as the take's lead-in.
   */
  const startTake = useCallback(async () => {
    setError("");
    const guide = singAlong && shown.length > 0;
    try {
      setCountingIn(true);
      if (guide) {
        playTicket.current += 1;
        await prepareTakes();
      }
      if (countIn) await onCountIn(COUNT_IN_BEATS);
      setCountingIn(false);
      const roll = await onRecord({ voiceOnly });
      if (!roll || !guide) return;
      // Played as a guide: quieter, so the microphone hears you and not it.
      const zero = await playNow({ guide: true });
      if (zero === null) return;
      const ctx = getContext();
      const outputSec = (ctx?.baseLatency ?? 0) + (ctx?.outputLatency ?? 0);
      onLeadIn(measureLeadInMs(zero, roll.startedAt, (outputSec + roll.inputLatencySec) * 1000));
    } catch (err) {
      setCountingIn(false);
      setError(err instanceof Error ? err.message : "The take could not be started.");
    }
  }, [
    countIn,
    getContext,
    onCountIn,
    onLeadIn,
    onRecord,
    playNow,
    prepareTakes,
    shown.length,
    singAlong,
    voiceOnly,
  ]);

  const stopTake = useCallback(() => {
    onStop();
    stopAll();
  }, [onStop, stopAll]);

  /**
   * Bounce the wall to one video.
   *
   * The picture is a canvas redrawn every frame from the playing elements, with
   * the lyric line of the moment drawn over it; the sound is every take's audio
   * summed through the studio's own AudioContext. Both streams go into one
   * MediaRecorder, so the result is a single file with the grid, the words and
   * the full mix rather than a folder of clips to edit elsewhere.
   */
  const exportWall = useCallback(async () => {
    const ctx = getContext();
    if (!ctx) {
      setError("Turn on sound first so the takes can be mixed.");
      return;
    }
    if (shown.length === 0) return;
    setError("");
    setExporting(true);

    const canvas = document.createElement("canvas");
    canvas.width = EXPORT_WIDTH;
    canvas.height = EXPORT_HEIGHT;
    const g = canvas.getContext("2d");
    if (!g) {
      setError("This browser cannot render the wall.");
      setExporting(false);
      return;
    }

    const rects = cellRects(shown.length, EXPORT_WIDTH, EXPORT_HEIGHT, 8);
    const dest = ctx.createMediaStreamDestination();

    try {
      if (ctx.state === "suspended") await ctx.resume();

      const bus = ensureBus();
      if (!bus) {
        setError("Turn on sound first so the takes can be mixed.");
        setExporting(false);
        return;
      }
      for (const t of shown) {
        const v = videoRefs.current.get(t.id);
        if (v) routeTake(bus, t.id, v);
      }
      // The bounce is taken from the same bus the room hears, after the gain
      // staging and the limiter, so the file sounds like what you just played
      // rather than like four takes summed raw. A muted take sits at zero on
      // its own fader, so it is out of the mix as well as out of the room.
      bus.output.connect(dest);

      const videoStream = canvas.captureStream(EXPORT_FPS);
      const mixed = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...dest.stream.getAudioTracks(),
      ]);
      const mimeType = pickMime([
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
      ]);
      const rec = mimeType ? new MediaRecorder(mixed, { mimeType }) : new MediaRecorder(mixed);
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      const finished = new Promise<void>((resolve) => {
        rec.onstop = () => {
          download(new Blob(chunks, { type: rec.mimeType || "video/webm" }), `dice-wall-${stamp()}.webm`);
          resolve();
        };
      });

      let raf = 0;
      const startedAt = performance.now();
      const draw = () => {
        g.fillStyle = "#260c06";
        g.fillRect(0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);
        shown.forEach((t, i) => {
          const v = videoRefs.current.get(t.id);
          const r = rects[i];
          if (!v || !r || v.videoWidth === 0) return;
          const s = coverSource(v.videoWidth, v.videoHeight, r);
          g.drawImage(v, s.x, s.y, s.width, s.height, r.x, r.y, r.width, r.height);
        });
        drawCaption(
          g,
          lyricAt(cues, performance.now() - (anchorRef.current ?? startedAt)),
          EXPORT_WIDTH,
          EXPORT_HEIGHT
        );
        raf = requestAnimationFrame(draw);
      };

      await prepareTakes();
      rec.start();
      await playNow();
      draw();

      // Fall back to a bounded wait when no duration is known, rather than
      // recording forever.
      await new Promise((r) => setTimeout(r, (durationMs > 0 ? durationMs : 15000) + 300));

      cancelAnimationFrame(raf);
      rec.stop();
      await finished;
      stopAll();
      try {
        busRef.current?.output.disconnect(dest);
      } catch {
        /* already gone */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "The wall could not be exported.");
    } finally {
      setExporting(false);
    }
  }, [getContext, shown, durationMs, cues, playNow, prepareTakes, stopAll, ensureBus, routeTake]);

  const busy = exporting || countingIn;
  const message = error || recordError || "";

  return (
    <section
      className={
        expanded
          ? "fixed inset-0 z-50 overflow-y-auto border-0 bg-maroonDeep p-4 sm:p-8"
          : "rounded-2xl border border-salmonDim/30 bg-maroon/40 p-4"
      }
    >
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-bone/80">
          the wall
        </h2>
        <span className="text-xs text-bone/45">
          {takes.length === 0
            ? "no takes yet"
            : `${shown.length} of ${takes.length} on the wall`}
        </span>

        {/* The wall lives in a column a third of the page wide, which is the
            right size while you are working next to it and too small to watch
            four takes in. */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title={
            expanded ? "Put the wall back in its column" : "Fill the window with the wall"
          }
          className="ml-auto rounded-lg border border-salmonDim/45 px-2.5 py-1 text-xs font-semibold text-chalk transition hover:bg-salmon/10"
        >
          {expanded ? "close" : "expand"}
        </button>
      </div>

      {/* Record, and everything a stacked take needs to land on the beat. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={recording ? stopTake : startTake}
          disabled={!canRecord || busy || (full && !recording)}
          title={
            !canRecord
              ? "Enable camera & sound first"
              : full
                ? `The wall holds ${MAX_TAKES} takes`
                : shown.length > 0 && singAlong
                  ? "Records a new take while the wall plays"
                  : "Records a take of you with the full mix"
          }
          className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition disabled:opacity-45 ${
            recording
              ? "bg-live text-chalk hover:bg-live/85"
              : "bg-bone text-maroonInk hover:bg-chalk"
          }`}
        >
          {recording ? "stop the take" : countingIn ? "counting in" : "record a take"}
        </button>

        {recording && (
          <span className="flex items-center gap-1.5 text-sm text-live">
            <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-live" />
            {clock(elapsedMs)}
          </span>
        )}

        <label className="flex items-center gap-1.5 text-xs text-bone/70">
          <input
            type="checkbox"
            checked={countIn}
            disabled={recording}
            onChange={(e) => setCountIn(e.target.checked)}
          />
          count in
        </label>
        <label className="flex items-center gap-1.5 text-xs text-bone/70">
          <input
            type="checkbox"
            checked={singAlong}
            disabled={recording}
            onChange={(e) => setSingAlong(e.target.checked)}
          />
          sing with the wall
        </label>
        <label
          className="flex items-center gap-1.5 text-xs text-bone/70"
          title="Records your microphone alone. The beat, the synth and the harmonizer stay out of this take."
        >
          <input
            type="checkbox"
            checked={voiceOnly}
            disabled={recording}
            onChange={(e) => setVoiceOnlyChoice(e.target.checked)}
          />
          voice only
        </label>

        <label
          className={`cursor-pointer rounded-lg border border-salmonDim/45 px-3 py-1.5 text-sm font-semibold text-chalk transition hover:bg-salmon/10 ${
            full || recording || busy ? "pointer-events-none opacity-45" : ""
          }`}
          title={
            full
              ? `The wall holds ${MAX_TAKES} clips`
              : "Bring in a video and produce over it"
          }
        >
          import video
          <input
            type="file"
            accept="video/*"
            multiple
            className="sr-only"
            disabled={full || recording || busy}
            onChange={(e) => {
              pickFiles(e.target.files);
              // Cleared so the same file can be picked twice running.
              e.target.value = "";
            }}
          />
        </label>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => (playing ? stopAll() : void playAll())}
            disabled={shown.length === 0 || busy || recording}
            className="rounded-lg border border-salmonDim/45 px-3 py-1.5 text-sm font-semibold text-chalk transition hover:bg-salmon/10 disabled:opacity-45"
          >
            {playing ? "stop" : "play all"}
          </button>
          <button
            type="button"
            onClick={exportWall}
            disabled={shown.length === 0 || busy || recording}
            title={
              durationMs > 0
                ? `Bounces the grid and the mix to one video. It runs in real time, so this takes ${clock(durationMs)}.`
                : "Bounces the grid and the mix to one video"
            }
            className="rounded-lg border border-salmonDim/45 px-3 py-1.5 text-sm font-semibold text-chalk transition hover:bg-salmon/10 disabled:opacity-45"
          >
            {exporting
              ? "bouncing"
              : durationMs > 0
                ? `export the wall (${clock(durationMs)})`
                : "export the wall"}
          </button>
        </div>
      </div>

      {takes.length === 0 && !liveCell ? (
        <p className="text-xs leading-relaxed text-bone/50">
          Enable camera &amp; sound, then record a take and it lands here — or
          <strong className="font-semibold text-bone/70"> import a video</strong>{" "}
          and produce over it. Takes play side by side, so you can stack a
          harmony over yourself, sing onto a clip you already had, or put{" "}
          {MAX_TAKES} in a grid and bounce the lot to one video.
        </p>
      ) : (
        <div
          className={`relative grid gap-1.5 overflow-hidden rounded-xl bg-maroonInk/50 p-1.5 ${
            expanded ? "mx-auto w-full max-w-5xl" : ""
          }`}
          style={{ gridTemplateColumns: `repeat(${Math.max(1, grid.cols)}, minmax(0, 1fr))` }}
        >
          {shown.map((t) => (
            <div key={t.id} className="group relative overflow-hidden rounded-lg bg-black">
              <video
                ref={(el) => {
                  if (el) videoRefs.current.set(t.id, el);
                  else videoRefs.current.delete(t.id);
                }}
                src={t.url}
                playsInline
                preload="auto"
                onLoadedMetadata={(e) => setDuration(t.id, e.currentTarget.duration)}
                onError={() => markBroken(t.id)}
                // An imported clip is not a mirror image of anybody, so it is
                // shown the way round it was filmed. Takes recorded here are
                // flipped, because that is how you saw yourself while singing.
                className={`aspect-video w-full object-cover ${
                  t.imported ? "" : "-scale-x-100"
                }`}
              />
              {t.broken && (
                <div className="absolute inset-0 flex items-center justify-center bg-maroonInk/85 p-2 text-center text-[11px] leading-snug text-bone/80">
                  This browser cannot decode {t.label}. Try an MP4 or WebM.
                </div>
              )}
              <div className="bg-maroonInk/70 px-2 py-1.5 text-[10px] text-chalk/80">
                <div className="truncate">
                  {t.label}
                  {t.muted && <span className="ml-1 text-salmon">muted</span>}
                </div>
                <label className="mt-1 flex items-center gap-1.5">
                  <span className="w-9 shrink-0 text-bone/60">volume</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={t.level ?? 1}
                    disabled={t.muted}
                    aria-label={`Volume of ${t.label}`}
                    onChange={(e) => setLevel(t.id, Number(e.target.value))}
                    className="min-w-0 flex-1 accent-salmon disabled:opacity-40"
                  />
                  <span className="w-7 shrink-0 text-right tabular-nums text-bone/60">
                    {Math.round((t.level ?? 1) * 100)}%
                  </span>
                </label>
                <label
                  className="mt-0.5 flex items-center gap-1.5"
                  title="If this take sounds late, move this until it sits with the others."
                >
                  <span className="w-9 shrink-0 text-bone/60">sync</span>
                  <input
                    type="range"
                    min={0}
                    max={MAX_NUDGE_MS}
                    step={10}
                    value={Math.min(MAX_NUDGE_MS, t.leadInMs ?? 0)}
                    aria-label={`Skip the start of ${t.label}`}
                    onChange={(e) => setLeadIn(t.id, Number(e.target.value))}
                    className="min-w-0 flex-1 accent-salmon"
                  />
                  <span className="w-7 shrink-0 text-right tabular-nums text-bone/60">
                    {((t.leadInMs ?? 0) / 1000).toFixed(2)}
                  </span>
                </label>
              </div>
              {/* Per-take controls, on the take, and always on it: hiding them
                  until the pointer happens to cross the cell means a take you
                  want rid of has no visible way to go. */}
              <div className="absolute right-1 top-1 flex gap-1 opacity-80 transition group-hover:opacity-100 focus-within:opacity-100">
                <button
                  type="button"
                  onClick={() => toggleMuted(t.id)}
                  aria-pressed={!!t.muted}
                  title={
                    t.muted
                      ? "Let this take's own sound back in"
                      : "Keep the picture, drop the sound - then play your own over it"
                  }
                  className={`rounded px-1.5 py-0.5 text-[10px] hover:bg-maroonInk ${
                    t.muted ? "bg-salmon text-maroonInk" : "bg-maroonInk/80 text-chalk"
                  }`}
                >
                  {t.muted ? "muted" : "mute"}
                </button>
                <button
                  type="button"
                  onClick={() => toggleHidden(t.id)}
                  title="Leave this take off the wall without deleting it"
                  className="rounded bg-maroonInk/80 px-1.5 py-0.5 text-[10px] text-chalk hover:bg-maroonInk"
                >
                  hide
                </button>
                <button
                  type="button"
                  onClick={() => download(t.blob, `${t.label.replace(/\s+/g, "-")}.webm`)}
                  title="Save just this take"
                  className="rounded bg-maroonInk/80 px-1.5 py-0.5 text-[10px] text-chalk hover:bg-maroonInk"
                >
                  save
                </button>
                <button
                  type="button"
                  onClick={() => (confirming === t.id ? remove(t.id) : askDelete(t.id))}
                  onBlur={() => setConfirming((c) => (c === t.id ? null : c))}
                  aria-label={
                    confirming === t.id ? `Confirm deleting ${t.label}` : `Delete ${t.label}`
                  }
                  title={
                    confirming === t.id
                      ? "Click again to delete this take for good"
                      : "Delete this take"
                  }
                  className={`rounded px-1.5 py-0.5 text-[10px] transition ${
                    confirming === t.id
                      ? "bg-live font-semibold text-chalk"
                      : "bg-maroonInk/80 text-live hover:bg-maroonInk"
                  }`}
                >
                  {confirming === t.id ? "delete?" : "delete"}
                </button>
              </div>
            </div>
          ))}

          {liveCell && (
            <div
              className={`relative overflow-hidden rounded-lg bg-black ${
                recording ? "ring-2 ring-live" : "ring-1 ring-salmonDim/30"
              }`}
            >
              <video
                ref={liveRef}
                muted
                playsInline
                autoPlay
                className="aspect-video w-full -scale-x-100 object-cover"
              />
              <span className="pointer-events-none absolute bottom-1 left-1.5 text-[10px] text-chalk/80 drop-shadow">
                {recording ? "recording" : countingIn ? "counting in" : "you, next"}
              </span>
            </div>
          )}

          {/* The line of the moment, over the whole wall: what the singer reads
              while recording, and what the bounce will burn in. */}
          {promptLine && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3 text-center">
              <span className="inline-block rounded-lg bg-maroonInk/80 px-3 py-1.5 text-sm font-semibold text-chalk">
                {promptLine}
              </span>
            </div>
          )}
        </div>
      )}

      {hiddenTakes.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-bone/45">
          <span>off the wall:</span>
          {hiddenTakes.map((t) => (
            <span key={t.id} className="flex items-center gap-1 rounded bg-maroonInk/40 px-1.5 py-0.5">
              {t.label}
              <button
                type="button"
                onClick={() => toggleHidden(t.id)}
                className="text-salmon hover:text-chalk"
              >
                show
              </button>
              <button
                type="button"
                onClick={() => (confirming === t.id ? remove(t.id) : askDelete(t.id))}
                aria-label={
                  confirming === t.id ? `Confirm deleting ${t.label}` : `Delete ${t.label}`
                }
                className={confirming === t.id ? "font-semibold text-live" : "text-live/80 hover:text-live"}
              >
                {confirming === t.id ? "delete?" : "delete"}
              </button>
            </span>
          ))}
        </div>
      )}

      <details className="mt-3 border-t border-salmonDim/20 pt-2">
        <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-wide text-bone/60">
          lyrics
          <span className="ml-2 font-normal text-bone/40">
            {lyricLines.length === 0
              ? "none"
              : timedPrompt
                ? `${lyricLines.length} lines over ${clock(durationMs)}`
                : `${lyricLines.length} lines`}
          </span>
        </summary>
        <textarea
          value={lyrics}
          onChange={(e) => onLyrics(e.target.value)}
          rows={4}
          spellCheck={false}
          placeholder={"one line per line\nleave a line blank for a gap\n0:12 or a stamp to pin one"}
          className="mt-2 w-full resize-y rounded-lg border border-salmonDim/40 bg-maroonDeep/60 px-2 py-1.5 text-sm leading-relaxed"
        />
        <p className="mt-1 text-[11px] leading-relaxed text-bone/45">
          Read them off the wall while you sing; they are burnt into the video
          when you bounce it. Lines without a stamp share the time evenly, so a
          plain block of words needs no timing at all.
        </p>
        {lyricLines.length > 0 && !timedPrompt && (
          <p className="mt-1 text-[11px] text-bone/45">
            Timing starts once there is a take to time against - until then this
            is a sheet to read from.
          </p>
        )}
      </details>

      {/* Before the first take there is no length to spread the words over, so
          the sheet is shown whole rather than guessed at. */}
      {recording && !timedPrompt && lyricLines.length > 0 && (
        <div className="mt-2 max-h-24 overflow-y-auto rounded-lg bg-maroonInk/40 p-2 text-center text-sm leading-relaxed text-chalk/85">
          {lyricLines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      <p className="mt-2 text-[11px] leading-relaxed text-bone/45">
        {voiceOnly
          ? "This take records your microphone alone. "
          : "This take records the full mix with your voice. "}
        {shown.length > 0 &&
          "With “sing with the wall” on, the takes already up here play while you record. Wear headphones, or the microphone records them too."}
      </p>

      {message && <p className="mt-2 text-xs text-live">{message}</p>}
    </section>
  );
}
