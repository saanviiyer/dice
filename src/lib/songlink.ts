// songlink.ts - a whole song, in a link.
//
// Everything dice makes currently dies on the machine that made it. Projects
// live in one browser's IndexedDB, videos land in a downloads folder, and there
// is no way to hand someone the thing you wrote - which is the one thing people
// want to do with a song. That is not a missing feature so much as a missing
// verb: without it, every user is a leaf.
//
// So a song packs into the URL fragment. Not a server, on purpose:
//
//   - A fragment never leaves the browser. It is not sent with the request, so
//     sharing a song does not send it to us, which is the same promise the
//     camera and the microphone already make in this app.
//   - No account, no upload, no storage bill, no moderation queue, and no
//     outage: a link works as long as the static build does. A million people
//     opening songs costs exactly what a million people opening the page costs.
//   - It cannot be taken down or lost. The song is the link.
//
// What travels is the *song* - tempo, key, chords, beat, basslines, lyrics, the
// voice it was written for - and never the audio. Recordings are megabytes and
// they are also someone's voice; neither belongs in a URL people paste around.
//
// The format is a compact binary one rather than JSON, because a beat is 384
// steps and JSON spends five characters on each of them. Two bits per step
// makes a whole song about the length of a tweet.

import {
  ACCENT,
  GHOST,
  MAX_PATTERN_BARS,
  NORMAL,
  STEPS_PER_BAR,
  emptyPattern,
  type DrumInstrument,
  type DrumPattern,
} from "./drums";
import {
  BASS_MAX_MIDI,
  BASS_MIN_MIDI,
  MAX_BASS_LANES,
  MAX_BASS_LAYERS,
  emptyBassPattern,
  type BassLane,
} from "./bass";
import { SCALES, type ScaleName } from "./music";
import type { PlayMode } from "./mapping";

export const SONG_LINK_VERSION = 1;

/** Lanes in a fixed order: the order is the format. */
const DRUM_LANES: DrumInstrument[] = ["kick", "snare", "clap", "hat", "tom", "shaker"];

/** Velocity levels, as the two bits that encode them. */
const LEVELS = [0, GHOST, NORMAL, ACCENT];

/** Caps, so one long lyric cannot make a link nobody can paste. */
export const MAX_NAME_BYTES = 40;
export const MAX_PROGRESSION_BYTES = 120;
export const MAX_LYRICS_BYTES = 600;

/**
 * Links longer than this still work, but stop surviving the round trip through
 * chat apps and mail clients that wrap or truncate. The UI warns rather than
 * refusing: a long link that the author pastes into a document is fine.
 */
export const SONG_LINK_COMFORTABLE_CHARS = 1800;

export interface SongLink {
  name: string;
  bpm: number;
  tonic: number;
  scale: ScaleName;
  mode: PlayMode;
  progression: string;
  preset: string;
  drums: DrumPattern;
  bass: BassLane[];
  lyrics: string;
}

// ---------------------------------------------------------------------------
// base64url, by hand
// ---------------------------------------------------------------------------
//
// btoa/atob exist in a browser but want a latin1 string, and Buffer exists in
// node but not in a browser. Twenty lines here is less trouble than either.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function bytesToBase64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

export function base64urlToBytes(text: string): Uint8Array | null {
  const clean = text.trim();
  if (!/^[A-Za-z0-9\-_]*$/.test(clean)) return null;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const chunk = clean.slice(i, i + 4);
    let n = 0;
    for (let j = 0; j < 4; j += 1) {
      const v = j < chunk.length ? B64.indexOf(chunk[j]) : 0;
      if (v < 0) return null;
      n = (n << 6) | v;
    }
    out.push((n >> 16) & 255);
    if (chunk.length > 2) out.push((n >> 8) & 255);
    if (chunk.length > 3) out.push(n & 255);
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// Writing and reading
// ---------------------------------------------------------------------------

class Writer {
  private bytes: number[] = [];
  u8(v: number): void {
    this.bytes.push(Math.max(0, Math.min(255, Math.round(v))) & 255);
  }
  u16(v: number): void {
    const n = Math.max(0, Math.min(65535, Math.round(v)));
    this.bytes.push((n >> 8) & 255, n & 255);
  }
  text(value: string, maxBytes: number, lengthBytes: 1 | 2 = 1): void {
    let data = new TextEncoder().encode(value ?? "");
    if (data.length > maxBytes) {
      // Cut on a byte boundary and let the decoder drop a broken tail rather
      // than refusing the whole song over a long lyric.
      data = data.subarray(0, maxBytes);
    }
    if (lengthBytes === 1) this.u8(data.length);
    else this.u16(data.length);
    for (const b of data) this.bytes.push(b);
  }
  done(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

class Reader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get exhausted(): boolean {
    return this.at >= this.bytes.length;
  }
  u8(): number | null {
    if (this.at >= this.bytes.length) return null;
    return this.bytes[this.at++];
  }
  u16(): number | null {
    const hi = this.u8();
    const lo = this.u8();
    if (hi === null || lo === null) return null;
    return (hi << 8) | lo;
  }
  text(lengthBytes: 1 | 2 = 1): string | null {
    const len = lengthBytes === 1 ? this.u8() : this.u16();
    if (len === null || this.at + len > this.bytes.length) return null;
    const slice = this.bytes.subarray(this.at, this.at + len);
    this.at += len;
    // A lyric cut mid-character decodes with a replacement char rather than
    // throwing the song away.
    return new TextDecoder().decode(slice);
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The two-bit code for a velocity: the nearest level dice actually plays. */
function levelCode(velocity: number): number {
  if (!Number.isFinite(velocity) || velocity <= 0) return 0;
  let best = 0;
  for (let i = 1; i < LEVELS.length; i += 1) {
    if (Math.abs(velocity - LEVELS[i]) < Math.abs(velocity - LEVELS[best])) best = i;
  }
  return best;
}

/** Pack a song into bytes. Always succeeds; oversized text is trimmed. */
export function encodeSongBytes(song: SongLink): Uint8Array {
  const w = new Writer();
  const bars = clamp(
    Math.round((song.drums.kick?.length ?? STEPS_PER_BAR) / STEPS_PER_BAR) || 1,
    1,
    MAX_PATTERN_BARS
  );
  const steps = bars * STEPS_PER_BAR;

  w.u8(SONG_LINK_VERSION);
  w.u8(song.mode === "progression" ? 1 : 0);
  w.u8(clamp(Math.round(song.bpm) - 40, 0, 255));
  w.u8(clamp(Math.round(song.tonic), 0, 11));
  w.u8(bars);

  // Drums: four steps to a byte, lanes in the order above.
  for (const lane of DRUM_LANES) {
    const values = song.drums[lane] ?? [];
    for (let s = 0; s < steps; s += 4) {
      let byte = 0;
      for (let k = 0; k < 4; k += 1) {
        byte = (byte << 2) | levelCode(values[s + k] ?? 0);
      }
      w.u8(byte);
    }
  }

  // Bass: sparse, because a bassline is mostly rests.
  const lanes = (song.bass ?? []).slice(0, MAX_BASS_LANES);
  w.u8(lanes.length);
  for (const lane of lanes) {
    const laneBars = clamp(
      Math.round((lane.pattern.notes.length || STEPS_PER_BAR) / STEPS_PER_BAR) || 1,
      1,
      MAX_PATTERN_BARS
    );
    w.u8(laneBars);
    w.u8(lane.muted ? 1 : 0);
    w.u8(Math.round(clamp(lane.gain, 0, 1) * 255));
    const pairs: [number, number][] = [];
    lane.pattern.notes.slice(0, laneBars * STEPS_PER_BAR).forEach((stack, step) => {
      for (const midi of stack.slice(0, MAX_BASS_LAYERS)) {
        if (Number.isFinite(midi)) pairs.push([step, clamp(Math.round(midi), BASS_MIN_MIDI, BASS_MAX_MIDI)]);
      }
    });
    w.u16(pairs.length);
    for (const [step, midi] of pairs) {
      w.u8(step);
      w.u8(midi);
    }
  }

  w.text(song.name ?? "", MAX_NAME_BYTES);
  w.text(song.scale, 16);
  w.text(song.preset ?? "", 32);
  w.text(song.progression ?? "", MAX_PROGRESSION_BYTES);
  w.text(song.lyrics ?? "", MAX_LYRICS_BYTES, 2);
  return w.done();
}

/** A song as the text that goes in a link. */
export function encodeSong(song: SongLink): string {
  return bytesToBase64url(encodeSongBytes(song));
}

/**
 * Read a song back, or null.
 *
 * Null for anything structurally wrong - a truncated payload, a version this
 * build does not know, a scale it cannot play - because half a song opened
 * silently is worse than a link that says it did not work. An unknown *sound*
 * is the exception: a voice is cosmetic where the notes are not, so a song
 * written with an instrument this build lacks still opens, on the default.
 */
export function decodeSong(text: string, knownPresets: string[] = []): SongLink | null {
  const bytes = base64urlToBytes(text);
  if (!bytes || bytes.length < 6) return null;
  const r = new Reader(bytes);

  const version = r.u8();
  if (version !== SONG_LINK_VERSION) return null;
  const flags = r.u8();
  const bpmRaw = r.u8();
  const tonic = r.u8();
  const bars = r.u8();
  if (flags === null || bpmRaw === null || tonic === null || bars === null) return null;
  if (tonic > 11 || bars < 1 || bars > MAX_PATTERN_BARS) return null;

  const steps = bars * STEPS_PER_BAR;
  const drums = emptyPattern(bars);
  for (const lane of DRUM_LANES) {
    const values: number[] = [];
    for (let s = 0; s < steps; s += 4) {
      const byte = r.u8();
      if (byte === null) return null;
      for (let k = 3; k >= 0; k -= 1) values.push(LEVELS[(byte >> (k * 2)) & 3]);
    }
    drums[lane] = values.slice(0, steps);
  }

  const laneCount = r.u8();
  if (laneCount === null || laneCount > MAX_BASS_LANES) return null;
  const bass: BassLane[] = [];
  for (let i = 0; i < laneCount; i += 1) {
    const laneBars = r.u8();
    const muted = r.u8();
    const gain = r.u8();
    const pairCount = r.u16();
    if (laneBars === null || muted === null || gain === null || pairCount === null) return null;
    if (laneBars < 1 || laneBars > MAX_PATTERN_BARS) return null;
    const pattern = emptyBassPattern(laneBars);
    for (let p = 0; p < pairCount; p += 1) {
      const step = r.u8();
      const midi = r.u8();
      if (step === null || midi === null) return null;
      if (step >= pattern.notes.length) return null;
      if (midi < BASS_MIN_MIDI || midi > BASS_MAX_MIDI) return null;
      const stack = pattern.notes[step];
      if (stack.length < MAX_BASS_LAYERS && !stack.includes(midi)) stack.push(midi);
    }
    for (const stack of pattern.notes) stack.sort((a, b) => a - b);
    bass.push({
      id: `bass-${i + 1}`,
      name: `Bass ${i + 1}`,
      pattern,
      muted: muted === 1,
      gain: gain / 255,
    });
  }

  const name = r.text();
  const scale = r.text();
  const preset = r.text();
  const progression = r.text();
  const lyrics = r.text(2);
  if (name === null || scale === null || preset === null || progression === null || lyrics === null) {
    return null;
  }
  if (!SCALES.includes(scale as ScaleName)) return null;

  return {
    name,
    bpm: clamp(bpmRaw + 40, 40, 220),
    tonic,
    scale: scale as ScaleName,
    mode: (flags & 1) === 1 ? "progression" : "diatonic",
    progression,
    preset: knownPresets.length === 0 || knownPresets.includes(preset) ? preset : "",
    drums,
    bass,
    lyrics,
  };
}

/** The shareable URL for a song, from wherever the studio is being served. */
export function songLinkUrl(baseUrl: string, song: SongLink): string {
  const payload = encodeSong(song);
  // The song rides in the fragment, after the route, so it never leaves the
  // browser and the existing hash router still finds the studio.
  const base = baseUrl.split("#")[0];
  return `${base}#/studio?s=${payload}`;
}

/** The song in a URL, if it carries one. */
export function songFromUrl(url: string, knownPresets: string[] = []): SongLink | null {
  const hash = url.includes("#") ? url.slice(url.indexOf("#") + 1) : "";
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  if (!query) return null;
  for (const part of query.split("&")) {
    const [key, value] = part.split("=");
    if (key === "s" && value) return decodeSong(value, knownPresets);
  }
  return null;
}
