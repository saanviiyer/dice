import { describe, expect, it } from "vitest";
import {
  analyzeMelody,
  downsampleTo,
  keyFromNotes,
  notesFromTrack,
  pitchClassWeights,
  pitchTrack,
  suggestChords,
  type MelodyNote,
} from "./melody";

const SR = 44100;
const freqOf = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** A take: each note held for `secs`, as a plain sine. */
function sing(midis: number[], secs = 0.5, sampleRate = SR): Float32Array {
  const per = Math.round(secs * sampleRate);
  const out = new Float32Array(per * midis.length);
  midis.forEach((midi, n) => {
    const f = freqOf(midi);
    for (let i = 0; i < per; i += 1) {
      out[n * per + i] = 0.6 * Math.sin((2 * Math.PI * f * i) / sampleRate);
    }
  });
  return out;
}

const note = (midi: number, startSec: number, durSec: number): MelodyNote => ({
  midi,
  startSec,
  durSec,
});

describe("hearing a sung take", () => {
  it("tracks the pitch of what was sung", () => {
    const { hz } = pitchTrack(sing([60], 0.5), SR);
    const voiced = hz.filter((f): f is number => f !== null);
    expect(voiced.length).toBeGreaterThan(10);
    for (const f of voiced) expect(f).toBeCloseTo(freqOf(60), 0);
  });

  it("hears silence as silence rather than as a note", () => {
    const { hz } = pitchTrack(new Float32Array(SR), SR);
    expect(hz.every((f) => f === null)).toBe(true);
  });

  it("turns a tracked pitch into notes", () => {
    const take = sing([60, 64, 67], 0.4);
    const { hz, hopSec } = pitchTrack(take, SR);
    const notes = notesFromTrack(hz, hopSec);
    expect(notes.map((n) => n.midi)).toEqual([60, 64, 67]);
    expect(notes[0].durSec).toBeGreaterThan(0.25);
  });

  it("drops the slide between notes rather than calling it a note", () => {
    // Two held notes with a one-frame smear between them.
    const hz = [
      ...new Array(20).fill(freqOf(60)),
      freqOf(62),
      ...new Array(20).fill(freqOf(64)),
    ];
    const notes = notesFromTrack(hz, 0.02, { minDurSec: 0.08 });
    expect(notes.map((n) => n.midi)).toEqual([60, 64]);
  });

  it("takes the median of a wobbling note, not the scoop into it", () => {
    // A singer arrives from underneath; the mean would sit flat of the note.
    const hz = [freqOf(58.6), freqOf(59.4), ...new Array(20).fill(freqOf(60))];
    const notes = notesFromTrack(hz, 0.02);
    expect(notes[0].midi).toBe(60);
  });

  it("downsamples without moving the pitch", () => {
    // Averaging happens by a whole factor, so the rate lands near the target
    // rather than on it: 44.1k over five is 8.82k.
    const low = downsampleTo(sing([60], 0.3), SR, 8000);
    expect(low.sampleRate).toBeLessThan(SR / 4);
    expect(low.data.length).toBeLessThan(SR * 0.3);
    const { hz } = pitchTrack(low.data, low.sampleRate);
    const voiced = hz.filter((f): f is number => f !== null);
    expect(voiced[0]).toBeCloseTo(freqOf(60), 0);
  });
});

describe("naming the key", () => {
  it("hears a major melody as its own key", () => {
    // C D E G A C, all diatonic to C major, resting on C.
    const notes = [60, 62, 64, 67, 69, 72].map((m, i) => note(m, i * 0.5, 0.5));
    const key = keyFromNotes([...notes, note(60, 3, 1)]);
    expect(key?.tonic).toBe(0);
    expect(key?.scale).toBe("major");
  });

  it("hears a minor melody as minor", () => {
    // A B C E, leaning on A: A minor, not C major.
    const notes = [
      note(69, 0, 1.2),
      note(71, 1.2, 0.4),
      note(72, 1.6, 0.6),
      note(76, 2.2, 0.6),
      note(69, 2.8, 1.2),
    ];
    const key = keyFromNotes(notes);
    expect(key?.tonic).toBe(9);
    expect(key?.scale).toBe("minor");
  });

  it("says nothing when there is not enough to go on", () => {
    expect(keyFromNotes([])).toBeNull();
    expect(keyFromNotes([note(60, 0, 1), note(64, 1, 1)])).toBeNull();
  });

  it("is more confident about a melody that leans on a key than one that wanders", () => {
    // Confidence is how far the winning key stood above the rest, so a melody
    // that hammers a tonic and its triad is a stronger claim than a chromatic
    // line that fits a dozen keys equally badly.
    const tonal = keyFromNotes([
      note(60, 0, 1),
      note(64, 1, 0.5),
      note(67, 1.5, 0.5),
      note(60, 2, 1.5),
    ]);
    const wandering = keyFromNotes(
      [60, 61, 62, 63, 64, 65].map((m, i) => note(m, i * 0.4, 0.4))
    );
    expect(tonal!.confidence).toBeGreaterThan(wandering!.confidence);
  });

  it("reads a bogus sample rate as nothing to hear, not as NaN", () => {
    const bad = downsampleTo(sing([60], 0.2), Number.NaN, 8000);
    expect(bad.data).toHaveLength(0);
  });

  it("weighs a pitch by how long it was held", () => {
    const w = pitchClassWeights([note(60, 0, 2), note(64, 2, 0.5), note(72, 3, 1)]);
    expect(w[0]).toBeCloseTo(3); // C, twice over, is the pitch class held longest
    expect(w[4]).toBeCloseTo(0.5);
    expect(w[1]).toBe(0);
  });
});

describe("suggesting chords under a melody", () => {
  const cMajor = { tonic: 0, scale: "major" as const, confidence: 0.5 };

  it("puts a chord under each stretch of the melody", () => {
    const notes = [
      note(64, 0, 1), // E
      note(65, 1, 1), // F
      note(67, 2, 1), // G
      note(71, 3, 1), // B
    ];
    const chords = suggestChords(notes, cMajor, 4, { segments: 4 });
    expect(chords).toHaveLength(4);
    // Every suggestion has to contain the note sung over it.
    expect(chords[0]).toMatch(/^(C|Em|Am)/);
    expect(chords[2]).toMatch(/^(C|G|Em)/);
  });

  it("names the diminished chord in the key rather than calling it minor", () => {
    const notes = [note(71, 0, 1), note(74, 1, 1), note(77, 2, 1)];
    const chords = suggestChords(notes, cMajor, 3, { segments: 1 });
    expect(chords[0]).toBe("Bdim");
  });

  it("holds the previous chord through a gap instead of inventing one", () => {
    const notes = [note(67, 0, 1)];
    const chords = suggestChords(notes, cMajor, 4, { segments: 4 });
    expect(chords).toHaveLength(4);
    expect(new Set(chords).size).toBe(1);
  });

  it("says nothing when nothing was sung", () => {
    expect(suggestChords([], cMajor, 4)).toEqual([]);
    expect(suggestChords([note(60, 0, 1)], cMajor, 0)).toEqual([]);
  });
});

describe("analysing a whole take", () => {
  it("hears the notes, the key and the chords of a sung phrase", () => {
    // G A B D, sitting in G major.
    const take = sing([67, 69, 71, 74], 0.5);
    const analysis = analyzeMelody(take, SR, { segments: 4 });
    expect(analysis.notes.map((n) => n.midi)).toEqual([67, 69, 71, 74]);
    expect(analysis.key?.tonic).toBe(7);
    expect(analysis.chords).toHaveLength(4);
    expect(analysis.range).toEqual({ low: 67, high: 74 });
    expect(analysis.durationSec).toBeCloseTo(2, 1);
  });

  it("comes back empty-handed on silence rather than guessing", () => {
    const analysis = analyzeMelody(new Float32Array(SR * 2), SR);
    expect(analysis.notes).toEqual([]);
    expect(analysis.key).toBeNull();
    expect(analysis.chords).toEqual([]);
    expect(analysis.range).toBeNull();
  });
});
