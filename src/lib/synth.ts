// synth.ts - polyphonic Web Audio synth with a sound-design system.
//
// Per-note signal path:
//   oscillators (unison + optional sub) -> per-note filter (env) ->
//   per-note ADSR gain -> shared low-pass filter (hand-Y cutoff + resonance)
//
// Master chain (shared):
//   shared filter -> distortion -> chorus -> delay -> reverb -> tremolo ->
//   master gain -> dry gain -> destination
//
// `master` -> `dry` -> instrument bus keeps the played signal always audible
// (effects are pre-master). The hand-Y cutoff and resonance live on the shared
// filter, unchanged in placement.
//
// One voice per chord tone. Chord changes retrigger; a rest releases all
// voices. All gain changes are ramped to avoid clicks. The AudioContext must be
// created/resumed from a user gesture (see ensureStarted()).

import {
  unisonDetunes,
  type EffectsConfig,
  type LfoConfig,
  type SoundConfig,
  type Waveform,
} from "./presets";

export type { Waveform };

export interface Envelope {
  attack: number;
  decay: number;
  sustain: number; // 0..1 level
  release: number;
}

const DEFAULT_ENV: Envelope = {
  attack: 0.02,
  decay: 0.12,
  sustain: 0.7,
  release: 0.25,
};

interface Voice {
  oscs: OscillatorNode[];
  gain: GainNode;
  freq: number;
}

interface FxStage {
  input: GainNode;
  output: GainNode;
  dry: GainNode;
  wet: GainNode;
}

function nearlyEqualFreqs(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 0.5) return false;
  }
  return true;
}

/** A soft-clip distortion curve. `amount` 0..1 sets drive. */
function makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const k = amount * 100;
  const n = 1024;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const deg = Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

/** How long a pick/hammer transient lasts. Past this it is a hiss. */
const ATTACK_NOISE_SEC = 0.055;

/**
 * How long a damped note takes to go quiet.
 *
 * The length of a finger landing on a ringing string: fast enough that the new
 * note owns the string, slow enough not to click.
 */
const DAMP_SEC = 0.035;

/**
 * A note that is already sounding, so whoever started it can stop it.
 *
 * Strumming needs this and nothing else does: picking a string that is still
 * ringing damps it first, and without that every stroke piles six more voices
 * onto the ones still decaying until the chord turns to mush.
 */
export interface NoteHandle {
  /** Damp the note from `at` (audio-clock seconds). Idempotent. */
  stop(at: number): void;
}

/** What a note is when there is no audio to play it. */
const SILENT_NOTE: NoteHandle = { stop: () => {} };

/** A decaying-noise impulse response for the reverb convolver. */
function makeImpulse(
  ctx: BaseAudioContext,
  seconds = 2.5,
  decay = 2.5
): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

export class Synth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private dry: GainNode | null = null;
  // instrumentBus carries the *played* signal (synth + effects + harmonizer +
  // drums) but NOT the loop-playback tracks, so the looper can tap it to record
  // an "Instrument" loop without feeding loops back into themselves.
  // recordBus = instrumentBus + loop tracks; the master recorder taps recordBus.
  private instrumentBus: GainNode | null = null;
  private recordBus: GainNode | null = null;
  private drumBus: GainNode | null = null;
  private recorderDest: MediaStreamAudioDestinationNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  /** Pick/hammer transient level, 0..1. See SoundConfig.attackNoise. */
  private attackNoise = 0;
  private voices: Voice[] = [];

  // Shared microphone hub. There must be exactly ONE MediaStreamAudioSourceNode
  // per mic MediaStream: Chromium feeds only one source node per stream, so a
  // second node (e.g. the harmonizer and the looper each making their own)
  // captures silence. Every mic consumer (harmonizer, looper, mixer, meter)
  // taps `micHub` instead of creating its own source node. micHub -> micSink
  // (gain 0) -> destination keeps the mic branch always rendered, so meters and
  // taps read live audio without leaking the mic to the speakers (no feedback).
  private micStream: MediaStream | null = null;
  private micSourceNode: MediaStreamAudioSourceNode | null = null;
  private micHub: GainNode | null = null;
  private micSink: GainNode | null = null;

  // Effects chain
  private fxInput: GainNode | null = null; // filter connects here
  private distortion: FxStage | null = null;
  private distShaper: WaveShaperNode | null = null;
  private chorus: FxStage | null = null;
  private chorusDelay: DelayNode | null = null;
  private delay: FxStage | null = null;
  private delayNode: DelayNode | null = null;
  private delayFeedback: GainNode | null = null;
  private reverb: FxStage | null = null;
  private tremolo: GainNode | null = null;

  // LFO
  private lfo: OscillatorNode | null = null;
  private lfoToPitch: GainNode | null = null;
  private lfoToFilter: GainNode | null = null;
  private lfoToAmp: GainNode | null = null;
  private chorusLfo: OscillatorNode | null = null;

  // Sound-design state
  waveform: Waveform = "sawtooth";
  env: Envelope = { ...DEFAULT_ENV };
  private unison = 2;
  private detune = 6;
  private subLevel = 0;
  private filterEnvAmount = 0;

  private masterVolume = 0.5;
  private expression = 1;

  private currentFreqs: number[] = [];

  get isStarted(): boolean {
    return this.ctx !== null;
  }

  get contextState(): AudioContextState | "closed" {
    return this.ctx ? this.ctx.state : "closed";
  }

  getContext(): AudioContext | null {
    return this.ctx;
  }

  private makeStage(): FxStage {
    const ctx = this.ctx!;
    const input = ctx.createGain();
    const output = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    dry.gain.value = 1;
    wet.gain.value = 0;
    input.connect(dry);
    dry.connect(output);
    wet.connect(output);
    return { input, output, dry, wet };
  }

  /** Create/resume the AudioContext. Must be called from a user gesture. */
  async ensureStarted(): Promise<void> {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.ctx = new Ctor();
      const ctx = this.ctx;

      this.filter = ctx.createBiquadFilter();
      this.filter.type = "lowpass";
      this.filter.frequency.value = 4000;
      this.filter.Q.value = 0.9;

      this.master = ctx.createGain();
      this.master.gain.value = this.masterVolume;

      this.dry = ctx.createGain();
      this.dry.gain.value = 1;

      // --- Effects chain ---
      // Distortion (insert)
      this.distortion = this.makeStage();
      this.distShaper = ctx.createWaveShaper();
      this.distShaper.curve = makeDistortionCurve(0.2);
      this.distShaper.oversample = "2x";
      this.distortion.input.connect(this.distShaper);
      this.distShaper.connect(this.distortion.wet);

      // Chorus (modulated short delay, send-style)
      this.chorus = this.makeStage();
      this.chorusDelay = ctx.createDelay(0.05);
      this.chorusDelay.delayTime.value = 0.025;
      this.chorusLfo = ctx.createOscillator();
      this.chorusLfo.type = "sine";
      this.chorusLfo.frequency.value = 0.6;
      const chorusDepth = ctx.createGain();
      chorusDepth.gain.value = 0.002;
      this.chorusLfo.connect(chorusDepth);
      chorusDepth.connect(this.chorusDelay.delayTime);
      this.chorusLfo.start();
      this.chorus.input.connect(this.chorusDelay);
      this.chorusDelay.connect(this.chorus.wet);

      // Delay / echo (feedback, send-style)
      this.delay = this.makeStage();
      this.delayNode = ctx.createDelay(2.0);
      this.delayNode.delayTime.value = 0.3;
      this.delayFeedback = ctx.createGain();
      this.delayFeedback.gain.value = 0.35;
      this.delay.input.connect(this.delayNode);
      this.delayNode.connect(this.delayFeedback);
      this.delayFeedback.connect(this.delayNode);
      this.delayNode.connect(this.delay.wet);

      // Reverb (convolution, send-style)
      this.reverb = this.makeStage();
      const convolver = ctx.createConvolver();
      convolver.buffer = makeImpulse(ctx, 2.5, 2.5);
      this.reverb.input.connect(convolver);
      convolver.connect(this.reverb.wet);

      // Tremolo (amp LFO destination)
      this.tremolo = ctx.createGain();
      this.tremolo.gain.value = 1;

      // --- LFO ---
      this.lfo = ctx.createOscillator();
      this.lfo.type = "sine";
      this.lfo.frequency.value = 5;
      this.lfoToPitch = ctx.createGain();
      this.lfoToFilter = ctx.createGain();
      this.lfoToAmp = ctx.createGain();
      this.lfoToPitch.gain.value = 0;
      this.lfoToFilter.gain.value = 0;
      this.lfoToAmp.gain.value = 0;
      this.lfo.connect(this.lfoToPitch);
      this.lfo.connect(this.lfoToFilter);
      this.lfo.connect(this.lfoToAmp);
      this.lfoToFilter.connect(this.filter.frequency);
      this.lfoToAmp.connect(this.tremolo.gain);
      this.lfo.start();

      // --- Wire the chain ---
      this.fxInput = this.distortion.input;
      this.filter.connect(this.fxInput);
      this.distortion.output.connect(this.chorus.input);
      this.chorus.output.connect(this.delay.input);
      this.delay.output.connect(this.reverb.input);
      this.reverb.output.connect(this.tremolo);
      this.tremolo.connect(this.master);

      // instrumentBus = master (synth+effects) + drums + harmonizer. recordBus
      // = instrumentBus + loop tracks -> destination. The master recorder taps
      // recordBus; the looper taps instrumentBus for "Instrument" loops (so a
      // loop never records itself -> no feedback).
      this.instrumentBus = ctx.createGain();
      this.recordBus = ctx.createGain();
      this.master.connect(this.dry);
      this.dry.connect(this.instrumentBus);
      this.instrumentBus.connect(this.recordBus);
      this.recordBus.connect(ctx.destination);

      this.drumBus = ctx.createGain();
      this.drumBus.gain.value = 0.9;
      this.drumBus.connect(this.instrumentBus);

      // Shared mic hub, always rendered through a muted sink so taps/meters read
      // live audio, but silent at the speakers so the mic never feeds back.
      this.micHub = ctx.createGain();
      this.micHub.gain.value = 1;
      this.micSink = ctx.createGain();
      this.micSink.gain.value = 0;
      this.micHub.connect(this.micSink);
      this.micSink.connect(ctx.destination);
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
  }

  /** Apply a full sound configuration (used on preset change). */
  applyConfig(cfg: SoundConfig): void {
    this.attackNoise = Math.max(0, Math.min(1, cfg.attackNoise ?? 0));
    this.setWaveform(cfg.waveform);
    this.unison = Math.max(1, Math.min(7, Math.round(cfg.unison)));
    this.detune = cfg.detune;
    this.subLevel = Math.max(0, Math.min(1, cfg.subLevel));
    this.setEnvelope(cfg.env);
    this.setResonance(cfg.resonance);
    this.filterEnvAmount = Math.max(0, Math.min(1, cfg.filterEnvAmount));
    this.setLfo(cfg.lfo);
    this.setEffects(cfg.fx);
  }

  setEnvelope(env: Envelope): void {
    this.env = { ...env };
  }
  setUnison(n: number): void {
    this.unison = Math.max(1, Math.min(7, Math.round(n)));
  }
  setDetune(cents: number): void {
    this.detune = cents;
  }
  setSubLevel(v: number): void {
    this.subLevel = Math.max(0, Math.min(1, v));
  }
  setFilterEnvAmount(v: number): void {
    this.filterEnvAmount = Math.max(0, Math.min(1, v));
  }

  setResonance(q: number): void {
    if (!this.ctx || !this.filter) return;
    const now = this.ctx.currentTime;
    this.filter.Q.setTargetAtTime(Math.max(0.0001, q), now, 0.02);
  }

  setLfo(cfg: LfoConfig): void {
    if (!this.ctx || !this.lfo || !this.lfoToPitch || !this.lfoToFilter || !this.lfoToAmp)
      return;
    const now = this.ctx.currentTime;
    this.lfo.frequency.setTargetAtTime(Math.max(0.01, cfg.rate), now, 0.02);
    const d = Math.max(0, Math.min(1, cfg.depth));
    const pitch = cfg.target === "pitch" ? d * 100 : 0; // cents
    const filt = cfg.target === "filter" ? d * 2500 : 0; // Hz
    const amp = cfg.target === "amp" ? d * 0.5 : 0; // gain
    this.lfoToPitch.gain.setTargetAtTime(pitch, now, 0.03);
    this.lfoToFilter.gain.setTargetAtTime(filt, now, 0.03);
    this.lfoToAmp.gain.setTargetAtTime(amp, now, 0.03);
  }

  setEffects(fx: EffectsConfig): void {
    this.setReverb(fx.reverb.on, fx.reverb.amount);
    this.setDelay(fx.delay.on, fx.delay.time, fx.delay.feedback, fx.delay.mix);
    this.setDistortion(fx.distortion.on, fx.distortion.amount);
    this.setChorus(fx.chorus.on, fx.chorus.amount);
  }

  setReverb(on: boolean, amount: number): void {
    if (!this.ctx || !this.reverb) return;
    const now = this.ctx.currentTime;
    this.reverb.wet.gain.setTargetAtTime(on ? amount : 0, now, 0.05);
  }

  setDelay(on: boolean, time: number, feedback: number, mix: number): void {
    if (!this.ctx || !this.delay || !this.delayNode || !this.delayFeedback)
      return;
    const now = this.ctx.currentTime;
    this.delayNode.delayTime.setTargetAtTime(
      Math.max(0.001, Math.min(2, time)),
      now,
      0.05
    );
    this.delayFeedback.gain.setTargetAtTime(
      Math.max(0, Math.min(0.95, feedback)),
      now,
      0.05
    );
    this.delay.wet.gain.setTargetAtTime(on ? mix : 0, now, 0.05);
  }

  setDistortion(on: boolean, amount: number): void {
    if (!this.ctx || !this.distortion || !this.distShaper) return;
    const now = this.ctx.currentTime;
    const amt = Math.max(0, Math.min(1, amount));
    this.distShaper.curve = makeDistortionCurve(amt);
    // Insert-style crossfade so drive replaces some of the clean signal.
    this.distortion.wet.gain.setTargetAtTime(on ? amt : 0, now, 0.05);
    this.distortion.dry.gain.setTargetAtTime(on ? 1 - amt * 0.6 : 1, now, 0.05);
  }

  setChorus(on: boolean, amount: number): void {
    if (!this.ctx || !this.chorus) return;
    const now = this.ctx.currentTime;
    this.chorus.wet.gain.setTargetAtTime(on ? amount : 0, now, 0.05);
  }

  setWaveform(w: Waveform): void {
    this.waveform = w;
    for (const v of this.voices) {
      for (const o of v.oscs) {
        // Leave the sub oscillator (last, sine) alone.
        if (o.type !== "sine" || w === "sine") o.type = w;
      }
    }
  }

  setMasterVolume(v: number): void {
    this.masterVolume = Math.max(0, Math.min(1, v));
    this.applyMasterGain();
  }

  setExpression(e: number): void {
    this.expression = Math.max(0, Math.min(1, e));
    this.applyMasterGain();
  }

  private applyMasterGain(): void {
    if (!this.ctx || !this.master) return;
    const target = this.masterVolume * this.expression;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(target, now, 0.03);
  }

  /** Ramp the shared low-pass cutoff (Hz) - hand-Y control. */
  setCutoff(hz: number): void {
    if (!this.ctx || !this.filter) return;
    const now = this.ctx.currentTime;
    const clamped = Math.max(60, Math.min(18000, hz));
    this.filter.frequency.cancelScheduledValues(now);
    this.filter.frequency.setTargetAtTime(clamped, now, 0.05);
  }

  /**
   * Build unison + sub oscillators for one note into `dest`, applying the pitch
   * LFO. Returns the created oscillators (already started at t0).
   */
  private buildOscillators(
    freq: number,
    dest: AudioNode,
    t0: number
  ): OscillatorNode[] {
    const ctx = this.ctx!;
    const oscs: OscillatorNode[] = [];
    const detunes = unisonDetunes(this.unison, this.detune);
    for (const d of detunes) {
      const osc = ctx.createOscillator();
      osc.type = this.waveform;
      osc.frequency.setValueAtTime(freq, t0);
      osc.detune.setValueAtTime(d, t0);
      osc.connect(dest);
      if (this.lfoToPitch) this.lfoToPitch.connect(osc.detune);
      osc.start(t0);
      oscs.push(osc);
    }
    if (this.subLevel > 0) {
      const sub = ctx.createOscillator();
      sub.type = "sine";
      sub.frequency.setValueAtTime(freq / 2, t0);
      const subGain = ctx.createGain();
      subGain.gain.value = this.subLevel;
      sub.connect(subGain);
      subGain.connect(dest);
      if (this.lfoToPitch) this.lfoToPitch.connect(sub.detune);
      sub.start(t0);
      oscs.push(sub);
    }
    return oscs;
  }

  /**
   * The pick, or the hammer: a few milliseconds of noise at the head of a note.
   *
   * It is band-passed around the note's third harmonic rather than left broad,
   * because contact noise sits above the note and a plain hiss reads as tape
   * rather than as a string being hit. It goes straight to the instrument
   * filter with its own envelope, so neither the amp envelope nor the per-note
   * filter sweep can swallow the one part of the sound an ear uses to name the
   * instrument. It still passes the main filter, so a dark hand position
   * muffles the pick the way it muffles everything else.
   */
  private attackTransient(freq: number, t0: number, level: number): void {
    if (!this.ctx || !this.filter || level <= 0) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise();
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(Math.max(200, Math.min(12000, freq * 3)), t0);
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    const peak = Math.max(0.0002, Math.min(1, level) * 0.5);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + ATTACK_NOISE_SEC);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.filter);
    src.start(t0);
    src.stop(t0 + ATTACK_NOISE_SEC + 0.02);
  }

  /** A per-note lowpass that opens with the filter envelope (or is transparent). */
  private makeNoteFilter(t0: number): BiquadFilterNode {
    const ctx = this.ctx!;
    const vf = ctx.createBiquadFilter();
    vf.type = "lowpass";
    vf.Q.value = 1;
    const amt = this.filterEnvAmount;
    if (amt <= 0) {
      vf.frequency.setValueAtTime(18000, t0); // transparent
    } else {
      const base = 500;
      const peak = base + amt * 6500;
      const { attack, decay } = this.env;
      vf.frequency.setValueAtTime(base, t0);
      vf.frequency.linearRampToValueAtTime(peak, t0 + Math.max(0.001, attack));
      vf.frequency.exponentialRampToValueAtTime(
        Math.max(100, base),
        t0 + Math.max(0.001, attack) + Math.max(0.02, decay)
      );
    }
    return vf;
  }

  private oscCount(): number {
    return this.unison + (this.subLevel > 0 ? 1 : 0);
  }

  playFreqs(freqs: number[]): void {
    if (!this.ctx || !this.filter) return;
    if (freqs.length === 0) {
      this.releaseAll();
      return;
    }
    if (nearlyEqualFreqs(freqs, this.currentFreqs)) return;

    this.releaseAll();
    this.currentFreqs = [...freqs];

    const now = this.ctx.currentTime;
    const { attack, decay, sustain } = this.env;
    const peak =
      (0.9 / Math.max(1, freqs.length)) / Math.sqrt(this.oscCount());

    for (const f of freqs) {
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(peak, now + Math.max(0.001, attack));
      gain.gain.exponentialRampToValueAtTime(
        Math.max(0.0001, peak * sustain),
        now + Math.max(0.001, attack) + Math.max(0.001, decay)
      );

      const vf = this.makeNoteFilter(now);
      vf.connect(gain);
      gain.connect(this.filter);

      const oscs = this.buildOscillators(f, vf, now);
      this.attackTransient(f, now, this.attackNoise);
      this.voices.push({ oscs, gain, freq: f });
    }
  }

  /**
   * Fire a single note at an absolute time, held for `gate` seconds (used by
   * the arpeggiator). Fire-and-forget: oscillators stop themselves.
   */
  /**
   * Play one note at a scheduled time. `velocity` scales its loudness, not its
   * length: a softly strummed string is quieter than a hard one, it does not
   * stop sooner.
   */
  triggerNote(freq: number, atTime: number, gate: number, velocity = 1): NoteHandle {
    if (!this.ctx || !this.filter) return SILENT_NOTE;
    const ctx = this.ctx;
    const t0 = Math.max(atTime, ctx.currentTime);
    const { attack, decay, sustain, release } = this.env;
    const v = Math.max(0, Math.min(1, Number.isFinite(velocity) ? velocity : 1));
    // Floored above zero: the envelope uses exponential ramps, and a ramp to or
    // from 0 is silent for its whole duration.
    const peak = Math.max(0.0002, (0.6 / Math.sqrt(this.oscCount())) * Math.pow(v, 1.4));
    const gain = this.ctx.createGain();
    const atk = Math.max(0.001, Math.min(attack, gate * 0.5));
    const dec = Math.max(0.001, Math.min(decay, gate * 0.5));
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + atk);
    gain.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, peak * sustain),
      t0 + atk + dec
    );
    const relStart = t0 + gate;
    gain.gain.setValueAtTime(Math.max(0.0001, peak * sustain), relStart);
    gain.gain.exponentialRampToValueAtTime(0.0001, relStart + release);

    const vf = this.makeNoteFilter(t0);
    vf.connect(gain);
    gain.connect(this.filter);

    const oscs = this.buildOscillators(freq, vf, t0);
    // A softly picked string is a softer pick, not the same pick played quieter
    // afterwards, so the transient rides the velocity too.
    this.attackTransient(freq, t0, this.attackNoise * v);
    for (const osc of oscs) osc.stop(relStart + release + 0.02);

    let stopped = false;
    return {
      stop: (at: number) => {
        if (stopped) return;
        stopped = true;
        const when = Math.max(at, ctx.currentTime);
        try {
          // Hold whatever the envelope had reached, then damp from there. A
          // plain cancel would jump the gain back to its last scheduled value
          // and click.
          gain.gain.cancelAndHoldAtTime(when);
        } catch {
          gain.gain.cancelScheduledValues(when);
          gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), when);
        }
        gain.gain.exponentialRampToValueAtTime(0.0001, when + DAMP_SEC);
        for (const osc of oscs) {
          try {
            osc.stop(when + DAMP_SEC + 0.01);
          } catch {
            /* already scheduled to stop earlier */
          }
        }
      },
    };
  }

  /** Release all active voices with an envelope release tail. */
  releaseAll(): void {
    if (!this.ctx) {
      this.voices = [];
      this.currentFreqs = [];
      return;
    }
    const now = this.ctx.currentTime;
    const rel = this.env.release;
    for (const v of this.voices) {
      v.gain.gain.cancelScheduledValues(now);
      const current = Math.max(0.0001, v.gain.gain.value);
      v.gain.gain.setValueAtTime(current, now);
      v.gain.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.01, rel));
      for (const o of v.oscs) {
        o.stop(now + Math.max(0.01, rel) + 0.02);
      }
    }
    this.voices = [];
    this.currentFreqs = [];
  }

  /**
   * The master mix bus (instrument mix + loop tracks). Loop-playback tracks
   * connect here so the master recorder captures them.
   */
  getOutputBus(): GainNode | null {
    return this.recordBus;
  }

  /**
   * The instrument bus: the played signal (synth + effects + harmonizer + drums)
   * WITHOUT the loop tracks. The harmonizer connects its output here, and the
   * looper taps it to record an "Instrument" loop with no feedback path.
   */
  getInstrumentBus(): GainNode | null {
    return this.instrumentBus;
  }

  /**
   * A MediaStream of the full output for recording. Created lazily and kept
   * connected; capturing it does not affect normal playback.
   */
  getRecordingStream(): MediaStream | null {
    if (!this.ctx || !this.recordBus) return null;
    if (!this.recorderDest) {
      this.recorderDest = this.ctx.createMediaStreamDestination();

      // A safety limiter in front of the file.
      //
      // Everything meets here: the synth, the drums, the loops, the harmonizer
      // - which can be four pitch-shifted copies of a voice at once - and then
      // the raw microphone on top of all of it, at unity. Summed straight into
      // a MediaStreamDestination that is exactly what a recording of someone
      // singing harmonies over a beat sounds like: clipped, and clipped in the
      // file, where no amount of turning it down afterwards helps.
      //
      // It sits just under zero and only works on peaks that would otherwise
      // have been flattened anyway, so a take still sounds like what was heard
      // while it was being made.
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -1.5;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      limiter.connect(this.recorderDest);
      this.recordBus.connect(limiter);
      // Also fold the raw microphone into the recording (but NOT the speakers):
      // micHub -> recorder only. This way a capture always contains the user's
      // voice even when the harmonizer is off, while live monitoring stays off
      // so there is no latency echo or feedback. The mic source swaps under
      // micHub over time; this hub-level edge persists.
      if (this.micHub) this.micHub.connect(limiter);
    }
    return this.recorderDest.stream;
  }

  /**
   * Attach the shared microphone stream. Creates the single
   * MediaStreamAudioSourceNode for this stream and routes it into the mic hub.
   * Idempotent for the same stream; swapping streams disconnects the old source.
   * Every mic consumer should read `getMicNode()` rather than making its own
   * source node.
   */
  setMicStream(stream: MediaStream): void {
    if (!this.ctx || !this.micHub) return;
    if (this.micStream === stream && this.micSourceNode) return;
    if (this.micSourceNode) {
      try {
        this.micSourceNode.disconnect();
      } catch {
        /* ignore */
      }
      this.micSourceNode = null;
    }
    this.micStream = stream;
    this.micSourceNode = this.ctx.createMediaStreamSource(stream);
    this.micSourceNode.connect(this.micHub);
  }

  /** The shared, always-live mic tap. Null until setMicStream() runs. */
  getMicNode(): AudioNode | null {
    return this.micSourceNode ? this.micHub : null;
  }

  /** True once a live mic stream is attached to the hub. */
  hasMic(): boolean {
    return this.micSourceNode !== null;
  }

  private noise(): AudioBuffer {
    const ctx = this.ctx!;
    if (!this.noiseBuf) {
      const len = Math.floor(ctx.sampleRate * 1.0);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
    }
    return this.noiseBuf;
  }

  // --- Synthesized drum voices (route to the drum bus, dry, so they are
  // recorded but not colored by the synth filter/effects). ---

  /**
   * One bass note. `gain` is the lane's level: stacked basslines all land on
   * the same bus in the same octave, so a layer needs a way to sit under the
   * one it is doubling instead of doubling its loudness too.
   */
  triggerBass(midi: number, t0: number, gate: number, gain = 1): void {
    if (!this.ctx || !this.drumBus) return;
    // Exponential ramps never reach zero, so a lane pulled to silence has to
    // drop out here rather than ramp to an inaudible-but-not-silent floor.
    const level = Math.max(0, Math.min(1, Number.isFinite(gain) ? gain : 1));
    if (level < 0.01) return;
    const ctx = this.ctx;
    const t = Math.max(t0, ctx.currentTime);
    const frequency = 440 * Math.pow(2, (midi - 69) / 12);
    const osc = ctx.createOscillator();
    const sub = ctx.createOscillator();
    osc.type = "sawtooth";
    sub.type = "sine";
    osc.frequency.setValueAtTime(frequency, t);
    sub.frequency.setValueAtTime(frequency / 2, t);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(720, t);
    filter.frequency.exponentialRampToValueAtTime(180, t + Math.max(0.04, gate));
    filter.Q.value = 1.8;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.38;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.46 * level, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.18 * level, t + Math.min(0.1, gate * 0.5));
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.04, gate));
    osc.connect(filter);
    sub.connect(subGain);
    subGain.connect(filter);
    filter.connect(g);
    g.connect(this.drumBus);
    osc.start(t);
    sub.start(t);
    osc.stop(t + Math.max(0.05, gate) + 0.02);
    sub.stop(t + Math.max(0.05, gate) + 0.02);
  }

  /**
   * Scale a drum voice's peak by velocity.
   *
   * Clamped away from zero because these envelopes use exponential ramps, and
   * an exponential ramp to or from 0 is silent for the whole ramp: a ghost note
   * at velocity 0.4 would simply vanish. The curve is velocity^1.4 rather than
   * linear, so a ghost note sits well under an accent the way it does on a real
   * kit instead of merely a little quieter.
   */
  private static vel(peak: number, velocity: number | undefined): number {
    const v = typeof velocity === "number" && Number.isFinite(velocity) ? velocity : 1;
    return Math.max(0.0002, peak * Math.pow(Math.max(0, Math.min(1, v)), 1.4));
  }

  triggerKick(t0: number, velocity?: number): void {
    if (!this.ctx || !this.drumBus) return;
    const ctx = this.ctx;
    const t = Math.max(t0, ctx.currentTime);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(130, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Synth.vel(0.9, velocity), t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    osc.connect(g);
    g.connect(this.drumBus);
    osc.start(t);
    osc.stop(t + 0.36);
  }

  triggerSnare(t0: number, velocity?: number): void {
    if (!this.ctx || !this.drumBus) return;
    const ctx = this.ctx;
    const t = Math.max(t0, ctx.currentTime);
    // Noise body.
    const src = ctx.createBufferSource();
    src.buffer = this.noise();
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1200;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(Synth.vel(0.7, velocity), t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    src.connect(hp);
    hp.connect(ng);
    ng.connect(this.drumBus);
    src.start(t);
    src.stop(t + 0.22);
    // Tonal snap.
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(180, t);
    const og = ctx.createGain();
    og.gain.setValueAtTime(Synth.vel(0.4, velocity), t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    osc.connect(og);
    og.connect(this.drumBus);
    osc.start(t);
    osc.stop(t + 0.12);
  }

  triggerClap(t0: number, velocity?: number): void {
    if (!this.ctx || !this.drumBus) return;
    const ctx = this.ctx;
    const t = Math.max(t0, ctx.currentTime);
    const src = ctx.createBufferSource();
    src.buffer = this.noise();
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1500;
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    for (const offset of [0, 0.018, 0.036]) {
      g.gain.setValueAtTime(Synth.vel(0.65, velocity), t + offset);
      g.gain.exponentialRampToValueAtTime(Synth.vel(0.08, velocity), t + offset + 0.012);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.drumBus);
    src.start(t);
    src.stop(t + 0.18);
  }

  triggerHat(t0: number, velocity?: number): void {
    if (!this.ctx || !this.drumBus) return;
    const ctx = this.ctx;
    const t = Math.max(t0, ctx.currentTime);
    const src = ctx.createBufferSource();
    src.buffer = this.noise();
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Synth.vel(0.3, velocity), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(hp);
    hp.connect(g);
    g.connect(this.drumBus);
    src.start(t);
    src.stop(t + 0.06);
  }

  triggerTom(t0: number, velocity?: number): void {
    if (!this.ctx || !this.drumBus) return;
    const ctx = this.ctx;
    const t = Math.max(t0, ctx.currentTime);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(190, t);
    osc.frequency.exponentialRampToValueAtTime(105, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Synth.vel(0.65, velocity), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    osc.connect(g);
    g.connect(this.drumBus);
    osc.start(t);
    osc.stop(t + 0.3);
  }

  triggerShaker(t0: number, velocity?: number): void {
    if (!this.ctx || !this.drumBus) return;
    const ctx = this.ctx;
    const t = Math.max(t0, ctx.currentTime);
    const src = ctx.createBufferSource();
    src.buffer = this.noise();
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 9000;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Synth.vel(0.2, velocity), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.drumBus);
    src.start(t);
    src.stop(t + 0.1);
  }

  triggerClick(t0: number, accent: boolean): void {
    if (!this.ctx || !this.drumBus) return;
    const ctx = this.ctx;
    const t = Math.max(t0, ctx.currentTime);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(accent ? 1600 : 1000, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(accent ? 0.4 : 0.25, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    osc.connect(g);
    g.connect(this.drumBus);
    osc.start(t);
    osc.stop(t + 0.04);
  }

  /** Fully tear down the audio graph. */
  async close(): Promise<void> {
    this.releaseAll();
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
      this.master = null;
      this.filter = null;
      this.dry = null;
      this.instrumentBus = null;
      this.recordBus = null;
      this.drumBus = null;
      this.recorderDest = null;
      this.noiseBuf = null;
      this.micStream = null;
      this.micSourceNode = null;
      this.micHub = null;
      this.micSink = null;
    }
  }
}
