// BeatboxChat.tsx - beatbox at dice and it writes the beat down.
//
// A conversation with one subject. You give it a sound, it tells you what it
// heard in words a musician would use, and offers to put that in the step
// sequencer where you can edit it like anything else you drew by hand.
//
// Two ways to give it a sound, because they fail differently. Recording is the
// obvious one but needs the microphone. Picking a track you already have needs
// no permission at all and works on a loop you recorded ten minutes ago, so the
// panel is useful even when the mic is unavailable or denied.

import { useCallback, useMemo, useRef, useState } from "react";
import {
  describeTranscription,
  explainTempo,
  readTempo,
  transcribeBeatbox,
  type TempoReading,
  type Transcription,
  type TranscribedVoice,
} from "./lib/transcribe";
import { MAX_PATTERN_BARS, type DrumPattern } from "./lib/drums";
import type { TrackMeta } from "./lib/ears";

export interface BeatboxChatProps {
  /** Tracks that could be transcribed instead of a fresh recording. */
  getTracks(): TrackMeta[];
  readAudio(id: number): { data: Float32Array; sampleRate: number } | null;
  /** The project tempo, so a transcription lines up with everything else. */
  bpm: number;
  /** Hand the finished pattern to the step sequencer. */
  onPattern(pattern: DrumPattern, transcription: Transcription): void;
  /** Take the project tempo from a performance, the Smart Tempo way. */
  onTempo(bpm: number): void;
  /** Needed to decode a microphone recording. Null before sound is enabled. */
  getContext(): BaseAudioContext | null;
}

let nextMessageId = 1;

interface Message {
  id: number;
  from: "you" | "dice";
  text: string;
  /** Attached to a dice message that produced a pattern. */
  transcription?: Transcription;
  /** Attached to a dice message offering to move the project tempo. */
  tempo?: TempoReading;
}

const VOICE_ROW: Array<{ voice: TranscribedVoice; label: string }> = [
  { voice: "kick", label: "kick" },
  { voice: "snare", label: "snare" },
  { voice: "hat", label: "hat" },
  { voice: "tom", label: "tom" },
];

/** The transcribed pattern, drawn in the brand's sequencer-tile language. */
function PatternPreview({ pattern }: { pattern: DrumPattern }) {
  const steps = pattern.kick.length;
  return (
    <div className="mt-2 flex flex-col gap-1 overflow-x-auto">
      {VOICE_ROW.map(({ voice, label }) => (
        <div key={voice} className="flex items-center gap-1.5">
          <span className="w-10 shrink-0 text-[10px] uppercase tracking-wide text-bone/45">
            {label}
          </span>
          <div className="flex gap-[2px]">
            {Array.from({ length: steps }, (_, i) => (
              <span
                key={i}
                className={`h-3 w-3 shrink-0 rounded-[3px] ${
                  pattern[voice][i]
                    ? "bg-brick"
                    : i % 4 === 0
                      ? "bg-salmon/35"
                      : "bg-salmon/15"
                }`}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function BeatboxChat({
  getTracks,
  readAudio,
  bpm,
  onPattern,
  onTempo,
  getContext,
}: BeatboxChatProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 0,
      from: "dice",
      text: "Beatbox a bar or two and I will write it into the step sequencer. Or point me at a track you already recorded.",
    },
  ]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sourceId, setSourceId] = useState<number | "mic">("mic");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const tracks = useMemo(() => getTracks(), [getTracks, messages.length]);

  const say = useCallback(
    (m: Omit<Message, "id">) =>
      setMessages((prev) => [...prev, { ...m, id: nextMessageId++ }]),
    []
  );

  /**
   * Throw a take away.
   *
   * A bad beatbox take is the normal case, not the exception: you cough, the
   * timing slips, the mic clips. Removing what dice heard also removes your own
   * message above it, so a discarded attempt leaves no trace to scroll past.
   */
  const discard = useCallback((id: number) => {
    setMessages((prev) => {
      const i = prev.findIndex((m) => m.id === id);
      if (i < 0) return prev;
      const drop = new Set([id]);
      if (i > 0 && prev[i - 1].from === "you") drop.add(prev[i - 1].id);
      return prev.filter((m) => !drop.has(m.id));
    });
  }, []);

  const clearAll = useCallback(() => {
    setMessages([
      {
        id: nextMessageId++,
        from: "dice",
        text: "Cleared. Beatbox a bar or two and I will write it into the step sequencer.",
      },
    ]);
  }, []);

  const run = useCallback(
    (data: Float32Array, sampleRate: number, label: string) => {
      const t = transcribeBeatbox(data, sampleRate, { bpm });
      say({ from: "you", text: label });
      const lines = [describeTranscription(t), ...t.notes];
      say({ from: "dice", text: lines.join(" "), transcription: t });

      // Smart tempo: if the performance clearly disagrees with the project,
      // offer to move the project rather than silently quantising to a grid the
      // player was not following.
      const reading = readTempo(data, sampleRate);
      if (reading.usable && Math.abs(reading.bpm - bpm) > 2) {
        say({
          from: "dice",
          text: `You played that at ${Math.round(reading.bpm)} BPM, not ${Math.round(bpm)}.`,
          tempo: reading,
        });
      }
    },
    [bpm, say]
  );

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const startRecording = useCallback(async () => {
    const ctx = getContext();
    if (!ctx) {
      say({ from: "dice", text: "Turn on camera and sound first, then I can listen." });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // A beatbox take is percussive and close-miked. Every one of these
          // would fight the transcription: gain riding flattens the dynamics
          // that separate a ghost note from a backbeat, noise suppression eats
          // the noise burst that *is* the snare, and echo cancellation ducks
          // whatever else is playing back.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        stopStream();
        setBusy(true);
        try {
          const blob = new Blob(chunksRef.current, { type: rec.mimeType });
          const bytes = await blob.arrayBuffer();
          const buffer = await ctx.decodeAudioData(bytes);
          run(
            buffer.getChannelData(0),
            buffer.sampleRate,
            `beatboxed ${buffer.duration.toFixed(1)}s`
          );
        } catch {
          say({ from: "dice", text: "I could not read that recording back." });
        } finally {
          setBusy(false);
        }
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
    } catch {
      say({
        from: "dice",
        text: "I could not open the microphone. You can point me at a track instead.",
      });
    }
  }, [getContext, run, say, stopStream]);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }, []);

  const transcribeTrack = useCallback(
    (id: number) => {
      const audio = readAudio(id);
      const name = tracks.find((t) => t.id === id)?.name ?? "that track";
      if (!audio) {
        say({ from: "dice", text: `${name} has no audio in it yet.` });
        return;
      }
      setBusy(true);
      try {
        run(audio.data, audio.sampleRate, `use ${name}`);
      } finally {
        setBusy(false);
      }
    },
    [readAudio, run, say, tracks]
  );

  const go = useCallback(() => {
    if (sourceId === "mic") {
      if (recording) stopRecording();
      else void startRecording();
      return;
    }
    transcribeTrack(sourceId);
  }, [sourceId, recording, startRecording, stopRecording, transcribeTrack]);

  const latest = messages[messages.length - 1];

  return (
    <section className="rounded-2xl border border-salmonDim/30 bg-maroon/40 p-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-bone/80">
          beatbox it
        </h2>
        <span className="ml-auto text-xs text-bone/40">
          {bpm ? `${Math.round(bpm)} BPM` : "no tempo"}
        </span>
        {messages.length > 1 && (
          <button
            type="button"
            onClick={clearAll}
            className="rounded px-2 py-0.5 text-xs text-salmon transition hover:bg-salmon/15"
          >
            clear
          </button>
        )}
      </div>

      <ol className="flex max-h-72 flex-col gap-2 overflow-y-auto">
        {messages.map((m) => (
          <li
            key={m.id}
            className={
              m.from === "you"
                ? "self-end rounded-2xl rounded-br-md bg-brick px-3 py-1.5 text-xs text-chalk"
                : "rounded-2xl rounded-bl-md bg-maroonInk/60 px-3 py-2 text-xs text-chalk"
            }
          >
            <span>{m.text}</span>
            {m.tempo && (
              <button
                type="button"
                onClick={() => onTempo(Math.round(m.tempo!.bpm))}
                title={explainTempo(m.tempo)}
                className="mt-2 rounded-full bg-salmon px-3 py-1 text-[11px] font-semibold text-maroonInk transition hover:bg-chalk"
              >
                set the project to {Math.round(m.tempo.bpm)} BPM
              </button>
            )}
            {m.transcription && m.transcription.hits.length > 0 && (
              <>
                <PatternPreview pattern={m.transcription.pattern} />
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => onPattern(m.transcription!.pattern, m.transcription!)}
                    className="rounded-full bg-salmon px-3 py-1 text-[11px] font-semibold text-maroonInk transition hover:bg-chalk"
                  >
                    put it in the sequencer
                  </button>
                  <button
                    type="button"
                    onClick={() => discard(m.id)}
                    className="rounded-full px-2.5 py-1 text-[11px] font-semibold text-bone/60 transition hover:bg-live/20 hover:text-chalk"
                  >
                    discard take
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ol>

      <div className="mt-3 flex gap-2">
        <select
          value={String(sourceId)}
          onChange={(e) =>
            setSourceId(e.target.value === "mic" ? "mic" : Number(e.target.value))
          }
          disabled={recording}
          className="min-w-0 flex-1 truncate rounded-lg border border-salmonDim/40 bg-maroonDeep/60 px-2 py-1.5 text-sm"
        >
          <option value="mic">record now</option>
          {tracks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={go}
          disabled={busy}
          className={`shrink-0 rounded-lg px-4 py-1.5 text-sm font-semibold transition ${
            recording
              ? "bg-live text-chalk"
              : busy
                ? "bg-maroonDeep/70 text-bone/60"
                : "bg-bone text-maroonInk hover:bg-chalk"
          }`}
        >
          {recording ? "stop" : busy ? "listening" : sourceId === "mic" ? "record" : "transcribe"}
        </button>
      </div>

      <p className="mt-2 text-xs text-bone/45">
        {latest?.transcription
          ? `Quantised to sixteenths across ${latest.transcription.bars} bar${
              latest.transcription.bars === 1 ? "" : "s"
            }. Clap and shaker are left for you: a beatboxed clap and snare are the same noise burst, so guessing between them would just put hits in the wrong lane.`
          : `It transcribes kick, snare, hat and tom, up to ${MAX_PATTERN_BARS} bars of sixteenths.`}
      </p>
    </section>
  );
}
