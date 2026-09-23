import { describe, it, expect } from "vitest";
import {
  loopLengthSamples,
  loopLengthSeconds,
  effectiveGain,
  nextLoopBoundary,
  exportDurationSeconds,
  exportLengthSamples,
  sourcesForSelection,
  encodeWavBytes,
  peakAmplitude,
  normalizeGain,
  isClipEdited,
  renderLoopClip,
  VocalLooper,
} from "./vocalLooper";

function fakeLooperContext(): AudioContext {
  const param = (value = 0) => ({
    value,
    setTargetAtTime(next: number) {
      this.value = next;
    },
  });
  const node = () => ({ connect() {}, disconnect() {} });
  return {
    currentTime: 0,
    sampleRate: 8,
    destination: node(),
    createGain: () => ({ ...node(), gain: param(1) }),
    createDynamicsCompressor: () => ({
      ...node(),
      threshold: param(),
      knee: param(),
      ratio: param(),
      attack: param(),
      release: param(),
    }),
    createScriptProcessor: () => ({ ...node(), onaudioprocess: null }),
    createBuffer: (_channels: number, length: number, sampleRate: number) => {
      const data = new Float32Array(length);
      return {
        duration: length / sampleRate,
        length,
        sampleRate,
        numberOfChannels: 1,
        getChannelData: () => data,
      };
    },
    createBufferSource: () => ({
      ...node(),
      buffer: null,
      loop: false,
      start() {},
      stop() {},
    }),
  } as unknown as AudioContext;
}

describe("continuous vocal-stack capture", () => {
  it("splits consecutive loop passes into takes and stops at the target", () => {
    const ctx = fakeLooperContext();
    let processor: ScriptProcessorNode | null = null;
    ctx.createScriptProcessor = () => {
      processor = {
        connect() {},
        disconnect() {},
        onaudioprocess: null,
      } as unknown as ScriptProcessorNode;
      return processor;
    };
    const looper = new VocalLooper(ctx, ctx.destination, () => {});
    looper.setInstrumentNode({ connect() {}, disconnect() {} } as unknown as AudioNode);
    // 1 bar at 240 BPM and 8 Hz = exactly 8 samples per pass.
    looper.setConfig({ bpm: 240, bars: 1, free: false });
    looper.setRecordSource("instrument");
    looper.armCycle(0, 3);

    const input = new Float32Array(24).fill(0.25);
    const event = {
      inputBuffer: { getChannelData: () => input },
    } as unknown as AudioProcessingEvent;
    (processor as ScriptProcessorNode | null)?.onaudioprocess?.(event);

    expect(looper.getStates().map((track) => track.name)).toEqual([
      "Stack 1",
      "Stack 2",
      "Stack 3",
    ]);
    expect(looper.getCycleProgress()).toEqual({ recorded: 3, target: 3, active: false });
    expect(looper.isRecording).toBe(false);
  });
});

describe("loop length from BPM + bars", () => {
  it("2 bars at 120 BPM (4/4) is 4 seconds", () => {
    expect(loopLengthSeconds(120, 2)).toBeCloseTo(4, 6);
  });
  it("1 bar at 120 BPM is 2 seconds", () => {
    expect(loopLengthSeconds(120, 1)).toBeCloseTo(2, 6);
  });
  it("samples = seconds * sampleRate (rounded)", () => {
    expect(loopLengthSamples(120, 2, 48000)).toBe(4 * 48000);
    expect(loopLengthSamples(120, 1, 44100)).toBe(2 * 44100);
  });
  it("slower tempo yields a longer loop", () => {
    expect(loopLengthSeconds(60, 1)).toBeCloseTo(4, 6);
    expect(loopLengthSamples(60, 1, 48000)).toBe(4 * 48000);
  });
  it("never returns fewer than 1 sample", () => {
    expect(loopLengthSamples(100000, 1, 1)).toBeGreaterThanOrEqual(1);
  });
});

describe("overdub / track gain mix", () => {
  const T = (o: Partial<{ muted: boolean; solo: boolean; volume: number }>) => ({
    muted: false,
    solo: false,
    volume: 0.9,
    ...o,
  });
  it("plays at its own volume when nothing is soloed", () => {
    expect(effectiveGain(T({ volume: 0.7 }), false)).toBeCloseTo(0.7, 6);
  });
  it("muted is silent", () => {
    expect(effectiveGain(T({ muted: true, volume: 1 }), false)).toBe(0);
  });
  it("solo silences non-soloed tracks", () => {
    expect(effectiveGain(T({ solo: false }), true)).toBe(0);
    expect(effectiveGain(T({ solo: true, volume: 0.8 }), true)).toBeCloseTo(0.8, 6);
  });
  it("clamps volume to 0..1", () => {
    expect(effectiveGain(T({ volume: 5 }), false)).toBe(1);
    expect(effectiveGain(T({ volume: -1 }), false)).toBe(0);
  });
  it("summed mix of a stack respects mute/solo", () => {
    const tracks = [
      T({ volume: 0.5 }),
      T({ volume: 0.5, muted: true }),
      T({ volume: 0.5, solo: true }),
    ];
    const anySolo = tracks.some((t) => t.solo);
    const sum = tracks.reduce((a, t) => a + effectiveGain(t, anySolo), 0);
    // Only the soloed track contributes.
    expect(sum).toBeCloseTo(0.5, 6);
  });
});

describe("harmony-take normalization (presence in the stack)", () => {
  it("peakAmplitude finds the largest absolute sample", () => {
    expect(peakAmplitude(new Float32Array([0, 0.3, -0.8, 0.5]))).toBeCloseTo(0.8, 6);
    expect(peakAmplitude(new Float32Array([]))).toBe(0);
    expect(peakAmplitude(new Float32Array([0, 0, 0]))).toBe(0);
  });

  it("boosts a quiet take up toward the target level", () => {
    // A quiet take peaking at 0.1 gets brought up (target 0.7 -> gain 7, capped).
    const g = normalizeGain(0.1);
    expect(g).toBeGreaterThan(1);
    expect(0.1 * g).toBeLessThanOrEqual(0.7 + 1e-6);
  });

  it("does not amplify near-silence into hiss", () => {
    expect(normalizeGain(0)).toBe(1);
    expect(normalizeGain(0.01)).toBe(1); // below the noise floor
  });

  it("clamps the makeup so no take is boosted or ducked too hard", () => {
    expect(normalizeGain(0.0001, 0.7, 4, 0)).toBe(4); // huge boost capped at maxGain
    expect(normalizeGain(1.0)).toBeGreaterThanOrEqual(0.5); // hot take not over-ducked
    expect(normalizeGain(1.0)).toBeLessThanOrEqual(1);
  });

  it("a take already near the target is left roughly as-is", () => {
    expect(normalizeGain(0.7)).toBeCloseTo(1, 6);
  });
});

describe("boundary alignment so tracks stay phase-locked", () => {
  it("with no established loop, start immediately", () => {
    expect(nextLoopBoundary(3.2, null, 4)).toBe(3.2);
  });
  it("returns the loop start when now is before it", () => {
    expect(nextLoopBoundary(9, 10, 4)).toBe(10);
  });
  it("rounds up to the next cycle boundary", () => {
    // loopStart 0, dur 4: now 5 -> next boundary 8
    expect(nextLoopBoundary(5, 0, 4)).toBe(8);
    // now 4.0 exactly is already a boundary
    expect(nextLoopBoundary(4, 0, 4)).toBe(4);
    // now 8.5 -> 12
    expect(nextLoopBoundary(8.5, 0, 4)).toBe(12);
  });
  it("multiple overdubs land on the same grid", () => {
    const start = 2;
    const dur = 3;
    const b1 = nextLoopBoundary(4.1, start, dur); // -> 5
    const b2 = nextLoopBoundary(6.7, start, dur); // -> 8
    expect((b1 - start) % dur).toBeCloseTo(0, 6);
    expect((b2 - start) % dur).toBeCloseTo(0, 6);
  });
});

describe("export duration from cycles x loop length", () => {
  it("N cycles is N times the loop duration", () => {
    expect(exportDurationSeconds(1, 4)).toBe(4);
    expect(exportDurationSeconds(3, 4)).toBe(12);
    expect(exportDurationSeconds(0, 4)).toBe(0);
  });
  it("export length in samples", () => {
    expect(exportLengthSamples(2, 4, 48000)).toBe(2 * 4 * 48000);
    expect(exportLengthSamples(1, 2, 44100)).toBe(1 * 2 * 44100);
  });
  it("never returns fewer than 1 sample", () => {
    expect(exportLengthSamples(0, 0, 48000)).toBeGreaterThanOrEqual(1);
  });
});

describe("record-source selection (mic vs instrument vs mix)", () => {
  it("mic selects only the mic input", () => {
    expect(sourcesForSelection("mic")).toEqual(["mic"]);
  });
  it("instrument selects only the synth tap", () => {
    expect(sourcesForSelection("instrument")).toEqual(["instrument"]);
  });
  it("mix selects both inputs", () => {
    expect(sourcesForSelection("mix")).toEqual(["mic", "instrument"]);
  });
});

describe("WAV encoding", () => {
  it("produces a RIFF/WAVE header of the right size", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const bytes = encodeWavBytes(samples, 48000);
    expect(bytes.byteLength).toBe(44 + samples.length * 2);
    const dv = new DataView(bytes);
    const tag = (o: number) =>
      String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    expect(tag(0)).toBe("RIFF");
    expect(tag(8)).toBe("WAVE");
    expect(dv.getUint32(24, true)).toBe(48000); // sample rate
  });
});

describe("clips: where a take sits in the cycle", () => {
  // 8 Hz, so one second is eight samples and every index is a tenth of a second
  // times eight - the arithmetic stays readable.
  const take = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);

  it("drops the trimmed window at its offset and silences the rest", () => {
    const out = renderLoopClip(
      take,
      8,
      { offsetSec: 0.25, trimStartSec: 0.125, trimEndSec: 0.5 },
      1
    );
    expect([...out]).toEqual([0, 0, 2, 3, 4, 0, 0, 0]);
  });

  it("cuts at the end of the cycle rather than wrapping round to the top", () => {
    // A clip that reappeared at bar one would read as a bug, not as a move.
    const out = renderLoopClip(take, 8, { offsetSec: 0.75, trimStartSec: 0, trimEndSec: 1 }, 1);
    expect([...out]).toEqual([0, 0, 0, 0, 0, 0, 1, 2]);
  });

  it("keeps the take as recorded when nothing has been moved or trimmed", () => {
    expect(isClipEdited({ offsetSec: 0, trimStartSec: 0, trimEndSec: 1 }, 1)).toBe(false);
    expect(isClipEdited({ offsetSec: 0.1, trimStartSec: 0, trimEndSec: 1 }, 1)).toBe(true);
    expect(isClipEdited({ offsetSec: 0, trimStartSec: 0.1, trimEndSec: 1 }, 1)).toBe(true);
    expect(isClipEdited({ offsetSec: 0, trimStartSec: 0, trimEndSec: 0.5 }, 1)).toBe(true);
  });
});

describe("moving, trimming and copying takes", () => {
  /** Record one 1-bar take of a ramp, so every sample can be told apart. */
  function looperWithTake(): { looper: VocalLooper; samples: number[] } {
    const ctx = fakeLooperContext();
    let processor: ScriptProcessorNode | null = null;
    ctx.createScriptProcessor = () => {
      processor = {
        connect() {},
        disconnect() {},
        onaudioprocess: null,
      } as unknown as ScriptProcessorNode;
      return processor;
    };
    const looper = new VocalLooper(ctx, ctx.destination, () => {});
    looper.setInstrumentNode({ connect() {}, disconnect() {} } as unknown as AudioNode);
    // 1 bar at 240 BPM and 8 Hz = exactly 8 samples.
    looper.setConfig({ bpm: 240, bars: 1, free: false });
    looper.setRecordSource("instrument");
    looper.armCycle(0, 1);
    const samples = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const input = new Float32Array(samples);
    (processor as ScriptProcessorNode | null)?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => input },
    } as unknown as AudioProcessingEvent);
    return { looper, samples };
  }

  const audio = (looper: VocalLooper, id: number) =>
    [...(looper.getTrackAudio(id)?.data ?? [])].map((v) => Math.round(v * 10) / 10);

  it("records a take that fills the cycle and sits at the top of it", () => {
    const { looper, samples } = looperWithTake();
    const [state] = looper.getStates();
    expect(state).toMatchObject({ offsetSec: 0, durationSec: 1, takeDurationSec: 1 });
    expect(audio(looper, state.id)).toEqual(samples);
  });

  it("trims to a window inside the cycle, silencing what was cut", () => {
    const { looper } = looperWithTake();
    const id = looper.getStates()[0].id;
    looper.trimTrack(id, 0.25, 0.75);
    expect(looper.getStates()[0]).toMatchObject({ offsetSec: 0.25, durationSec: 0.5 });
    expect(audio(looper, id)).toEqual([0, 0, 0.3, 0.4, 0.5, 0.6, 0, 0]);
  });

  it("can widen a trim again, because the take itself is never cut", () => {
    const { looper, samples } = looperWithTake();
    const id = looper.getStates()[0].id;
    looper.trimTrack(id, 0.25, 0.75);
    looper.trimTrack(id, 0, 1);
    expect(looper.getStates()[0]).toMatchObject({ offsetSec: 0, durationSec: 1 });
    expect(audio(looper, id)).toEqual(samples);
  });

  it("moves a trimmed clip, and refuses to move one that fills the cycle", () => {
    const { looper } = looperWithTake();
    const id = looper.getStates()[0].id;
    // A full-cycle take has nowhere to go: there is no room either side of it.
    looper.setTrackOffset(id, 0.5);
    expect(looper.getStates()[0].offsetSec).toBe(0);
    looper.trimTrack(id, 0, 0.5);
    looper.setTrackOffset(id, 0.5);
    expect(looper.getStates()[0].offsetSec).toBe(0.5);
    expect(audio(looper, id)).toEqual([0, 0, 0, 0, 0.1, 0.2, 0.3, 0.4]);
  });

  it("copies a take with its clip, so a phrase can be layered on itself", () => {
    const { looper } = looperWithTake();
    const id = looper.getStates()[0].id;
    looper.trimTrack(id, 0, 0.5);
    looper.duplicateTrack(id);
    const states = looper.getStates();
    expect(states.map((t) => t.name)).toEqual(["Stack 1", "Stack 1 copy"]);
    expect(states[1]).toMatchObject({ offsetSec: 0, durationSec: 0.5 });
    // Copies are independent: moving one leaves the other where it was.
    looper.setTrackOffset(states[1].id, 0.5);
    expect(looper.getStates().map((t) => t.offsetSec)).toEqual([0, 0.5]);
  });

  it("draws peaks from the trimmed window, not from the whole cycle", () => {
    const { looper } = looperWithTake();
    const id = looper.getStates()[0].id;
    looper.trimTrack(id, 0.5, 1);
    const peaks = looper.getPeaks(id, 4) ?? [];
    expect(peaks).toHaveLength(4);
    // The second half of the ramp, so every bucket is loud; leading silence
    // from the offset would have flattened the first two.
    expect(peaks.every((v) => v > 0.4)).toBe(true);
  });
});
