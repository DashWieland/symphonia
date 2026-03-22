import type { SurrealParams, DrumVoice, SynthMode } from "./types";

// Maps surreal emotional params to real synthesis params
function mapSurrealToSynth(surreal: SurrealParams) {
  return {
    // Oscillator
    detune: surreal.grotesqueness * 50,
    harmonicSpread: surreal.grotesqueness * 0.8,
    waveformMix: surreal.grotesqueness,

    // Filter
    filterCutoff: 200 + (1 - surreal.institutionalDecay) * 8000,
    filterDecay: 0.1 + surreal.institutionalDecay * 2,
    bitcrush: Math.floor(16 - surreal.institutionalDecay * 12),

    // Glitch
    glitchProb: surreal.digitalCorruption * 0.4,
    stutterRate: surreal.digitalCorruption * 0.3,
    pitchRandom: surreal.digitalCorruption * 200,

    // Envelope
    attack: 0.001 + (1 - surreal.visceralTension) * 0.3,
    resonance: 1 + surreal.visceralTension * 10, // cap at 11 (was 26) — prevents self-oscillation
    compression: surreal.visceralTension * 0.8,

    // Space
    reverbSize: 0.1 + surreal.cosmicDread * 0.9,
    delayFeedback: surreal.cosmicDread * 0.55, // cap at 0.55 (was 0.75) — prevents runaway
    pitchShift: -surreal.cosmicDread * 7,      // cap at -7 semitones (was -12)
    delayTime: 0.1 + surreal.cosmicDread * 0.4,
  };
}

type SynthMappedParams = ReturnType<typeof mapSurrealToSynth>;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private limiter: DynamicsCompressorNode | null = null; // hard limiter before output
  private reverbNode: ConvolverNode | null = null;
  private delayNode: DelayNode | null = null;
  private delayFeedback: GainNode | null = null;
  private delayFilter: BiquadFilterNode | null = null; // highpass in feedback to prevent low-freq buildup
  private reverbGain: GainNode | null = null;
  private delayGain: GainNode | null = null;
  private dryGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;

  private synthParams = mapSurrealToSynth({
    grotesqueness: 0.15,
    institutionalDecay: 0.1,
    digitalCorruption: 0.0,
    visceralTension: 0.3,
    cosmicDread: 0.2,
  });

  // ── Cached buffers to avoid per-hit allocation ──
  private noiseBufferShort: AudioBuffer | null = null;  // ~0.08s for hihats/rim
  private noiseBufferMed: AudioBuffer | null = null;    // ~0.2s for snare/clap
  private noiseBufferLong: AudioBuffer | null = null;   // ~0.4s for open hat/cymbal
  private distortionCurveCache = new Map<number, Float32Array<ArrayBuffer>>();
  private lastReverbSize = -1;
  // Reusable Uint8Array for analyser data — avoids allocation per frame
  private analyserFreqData: Uint8Array<ArrayBuffer> | null = null;
  private analyserWaveData: Uint8Array<ArrayBuffer> | null = null;
  // Track last param values to skip redundant setTargetAtTime calls
  private bitcrusherNode: WaveShaperNode | null = null;
  private lastBitcrush = -1;
  private lastParamSnapshot = { reverbGain: -1, delayTime: -1, delayFeedback: -1, compression: -1 };
  // Stereo panner per drum voice — persistent nodes created on init
  private drumPanners = new Map<DrumVoice, StereoPannerNode>();
  // Pan positions: kick/snare center, others spread across stereo field
  private static readonly DRUM_PAN: Record<DrumVoice, number> = {
    kick: 0,        // dead center
    snare: 0,       // dead center
    hihat: -0.3,    // slightly left
    clap: 0.15,     // slightly right
    tom: -0.4,      // left
    rim: 0.4,       // right
    cymbal: 0.35,   // right
    perc: -0.25,    // slightly left
  };

  async init() {
    if (this.ctx) {
      console.log("AudioEngine: already initialized, state:", this.ctx.state);
      return;
    }
    console.log("AudioEngine: initializing");
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AudioCtx();

    // ── Gain staging ──
    // Sources -> compressor (tame dynamics) -> dry/wet split -> masterGain -> limiter -> analyser -> output
    // Goal: never clip at output regardless of effect settings

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.8; // conservative — setMasterVolume scales this

    // Pre-effects compressor: tame source dynamics
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -12;
    this.compressor.knee.value = 10;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.1;

    // Drum stereo panners — one per voice, all route to compressor
    const voices: DrumVoice[] = ["kick", "snare", "hihat", "clap", "tom", "rim", "cymbal", "perc"];
    for (const voice of voices) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = AudioEngine.DRUM_PAN[voice];
      panner.connect(this.compressor);
      this.drumPanners.set(voice, panner);
    }

    // Hard limiter right before output — the safety net
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;   // catches anything above -3dB
    this.limiter.knee.value = 0;         // hard knee = brick wall
    this.limiter.ratio.value = 20;       // near-infinite ratio
    this.limiter.attack.value = 0.001;   // instant catch
    this.limiter.release.value = 0.05;   // quick release to avoid pumping

    // Analyser for visualizations
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyserFreqData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    this.analyserWaveData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;

    // Reverb (convolver with generated impulse)
    this.reverbNode = this.ctx.createConvolver();
    this.reverbNode.buffer = this.createReverbImpulse(2, 2);
    this.lastReverbSize = 0.5;

    // Delay with highpass in feedback loop to prevent low-frequency buildup
    this.delayNode = this.ctx.createDelay(2);
    this.delayNode.delayTime.value = 0.3;
    this.delayFeedback = this.ctx.createGain();
    this.delayFeedback.gain.value = 0.2;
    this.delayFilter = this.ctx.createBiquadFilter();
    this.delayFilter.type = "highpass";
    this.delayFilter.frequency.value = 200; // cut bass from feedback loop
    this.delayFilter.Q.value = 0.7;

    // Wet/dry mix — gains are conservative so sum doesn't exceed ~1.0
    this.reverbGain = this.ctx.createGain();
    this.reverbGain.gain.value = 0.2;
    this.delayGain = this.ctx.createGain();
    this.delayGain.gain.value = 0.15;
    this.dryGain = this.ctx.createGain();
    this.dryGain.gain.value = 0.75; // dry + reverb + delay ≈ 0.75 + 0.2 + 0.15 = 1.1

    // Bitcrusher: reduces amplitude resolution for lo-fi crunch
    this.bitcrusherNode = this.ctx.createWaveShaper();
    this.bitcrusherNode.curve = this.makeBitcrushCurve(16); // 16 = no crush
    this.bitcrusherNode.oversample = "none";
    this.lastBitcrush = 16;

    // Routing: compressor -> bitcrusher -> dry/wet split -> masterGain -> limiter -> analyser -> output
    this.compressor.connect(this.bitcrusherNode);
    this.bitcrusherNode.connect(this.dryGain);
    this.dryGain.connect(this.masterGain);
    this.bitcrusherNode.connect(this.reverbNode);
    this.reverbNode.connect(this.reverbGain);
    this.reverbGain.connect(this.masterGain);
    this.bitcrusherNode.connect(this.delayNode);
    this.delayNode.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delayFilter); // feedback goes through highpass
    this.delayFilter.connect(this.delayNode);     // then back into delay
    this.delayNode.connect(this.delayGain);
    this.delayGain.connect(this.masterGain);
    this.masterGain.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    // Pre-generate noise buffers at common durations
    this.noiseBufferShort = this.createNoiseBuffer(0.1);
    this.noiseBufferMed = this.createNoiseBuffer(0.25);
    this.noiseBufferLong = this.createNoiseBuffer(0.5);

    console.log("AudioEngine: initialized successfully");
  }

  // Create a reusable noise buffer (generated once, played many times)
  private createNoiseBuffer(duration: number): AudioBuffer | null {
    if (!this.ctx) return null;
    const length = Math.ceil(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  private createReverbImpulse(duration: number, decay: number): AudioBuffer {
    if (!this.ctx) throw new Error("AudioContext not initialized");
    const rate = this.ctx.sampleRate;
    const length = rate * duration;
    const buffer = this.ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return buffer;
  }

  updateSurrealParams(surreal: SurrealParams) {
    this.synthParams = mapSurrealToSynth(surreal);
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const snap = this.lastParamSnapshot;

    // Only call setTargetAtTime when values actually changed meaningfully
    const newRG = Math.round(this.synthParams.reverbSize * 100);
    if (this.reverbGain && newRG !== snap.reverbGain) {
      snap.reverbGain = newRG;
      // Cap reverb wet at 0.35 to prevent washout
      this.reverbGain.gain.setTargetAtTime(Math.min(this.synthParams.reverbSize * 0.35, 0.35), now, 0.1);
    }

    const newDT = Math.round(this.synthParams.delayTime * 100);
    if (this.delayNode && newDT !== snap.delayTime) {
      snap.delayTime = newDT;
      this.delayNode.delayTime.setTargetAtTime(this.synthParams.delayTime, now, 0.1);
    }

    const newDF = Math.round(this.synthParams.delayFeedback * 100);
    if (this.delayFeedback && newDF !== snap.delayFeedback) {
      snap.delayFeedback = newDF;
      // Cap feedback at 0.55 to prevent runaway accumulation
      const safeFeedback = Math.min(this.synthParams.delayFeedback, 0.55);
      this.delayFeedback.gain.setTargetAtTime(safeFeedback, now, 0.1);
    }

    const newComp = Math.round(this.synthParams.compression * 100);
    if (this.compressor && newComp !== snap.compression) {
      snap.compression = newComp;
      // Cap ratio at 8:1 instead of 16:1 to prevent over-compression
      this.compressor.ratio.setTargetAtTime(1 + this.synthParams.compression * 8, now, 0.1);
    }

    // Bitcrusher: only update when bit depth changes meaningfully
    const newBits = Math.round(this.synthParams.bitcrush);
    if (this.bitcrusherNode && newBits !== this.lastBitcrush) {
      this.lastBitcrush = newBits;
      this.bitcrusherNode.curve = this.makeBitcrushCurve(newBits);
    }

    // Reverb impulse: only regenerate on large changes (>15% shift)
    // Generate async to avoid blocking the main thread
    const quantizedReverb = Math.round(this.synthParams.reverbSize * 6) / 6;
    if (this.reverbNode && this.ctx && Math.abs(quantizedReverb - this.lastReverbSize) > 0.1) {
      this.lastReverbSize = quantizedReverb;
      const duration = 0.5 + this.synthParams.reverbSize * 4;
      const decay = 1 + (1 - this.synthParams.reverbSize) * 3;
      this.generateReverbAsync(duration, decay);
    }
  }

  setMasterVolume(vol: number) {
    if (this.masterGain && this.ctx) {
      // vol 0-1 maps to gain 0-1.0 (limiter catches anything above)
      this.masterGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.05);
    }
  }

  getAnalyserData(): Uint8Array {
    if (!this.analyser || !this.analyserFreqData) return new Uint8Array(0);
    this.analyser.getByteFrequencyData(this.analyserFreqData);
    return this.analyserFreqData;
  }

  getWaveformData(): Uint8Array {
    if (!this.analyser || !this.analyserWaveData) return new Uint8Array(0);
    this.analyser.getByteTimeDomainData(this.analyserWaveData);
    return this.analyserWaveData;
  }

  // Play a synthesized drum hit at a precise scheduled time
  // All drum voices respond to surreal parameters for cohesive sound shaping
  playDrum(voice: DrumVoice, velocity: number, accent: boolean, time?: number) {
    if (!this.ctx || !this.compressor) return;
    const when = time ?? this.ctx.currentTime;
    const vol = velocity * (accent ? 1.1 : 0.85);
    const p = this.synthParams;
    // Route through voice-specific stereo panner (falls back to compressor if panner not ready)
    const dest = this.drumPanners.get(voice) ?? this.compressor;

    const glitchDetune = Math.random() < p.glitchProb
      ? (Math.random() - 0.5) * p.pitchRandom
      : 0;

    switch (voice) {
      case "kick":
        this.synthKick(when, vol, glitchDetune, p, dest);
        break;
      case "snare":
        this.synthSnare(when, vol, glitchDetune, p, dest);
        break;
      case "hihat":
        this.synthHihat(when, vol, false, glitchDetune, p, dest);
        break;
      case "clap":
        this.synthClap(when, vol, glitchDetune, p, dest);
        break;
      case "tom":
        this.synthTom(when, vol, glitchDetune, p, dest);
        break;
      case "rim":
        this.synthRim(when, vol, glitchDetune, p, dest);
        break;
      case "cymbal":
        this.synthHihat(when, vol, true, glitchDetune, p, dest);
        break;
      case "perc":
        this.synthPerc(when, vol, glitchDetune, p, dest);
        break;
    }
  }

  playNote(frequency: number, duration: number, velocity: number, slide: boolean, time?: number, synthMode?: SynthMode) {
    this.playNotes([frequency], duration, velocity, slide, time, synthMode);
  }

  playNotes(frequencies: number[], duration: number, velocity: number, slide: boolean, time?: number, synthMode?: SynthMode) {
    if (!this.ctx || !this.compressor || frequencies.length === 0) return;
    const mode = synthMode ?? "subtractive";
    switch (mode) {
      case "fm":
        this.playNotesFM(frequencies, duration, velocity, slide, time);
        break;
      case "pluck":
        this.playNotesPluck(frequencies, duration, velocity, slide, time);
        break;
      default:
        this.playNotesSubtractive(frequencies, duration, velocity, slide, time);
        break;
    }
  }

  // ── Subtractive synthesis (original): dual osc + sub + filter + distortion ──
  private playNotesSubtractive(frequencies: number[], duration: number, velocity: number, slide: boolean, time?: number) {
    if (!this.ctx || !this.compressor) return;
    const now = time ?? this.ctx.currentTime;
    const p = this.synthParams;
    const voiceVol = velocity * 0.4 / Math.max(1, frequencies.length * 0.7);

    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    const distortion = this.ctx.createWaveShaper();
    const curveKey = Math.round(p.waveformMix * 20);
    let curve = this.distortionCurveCache.get(curveKey);
    if (!curve) {
      curve = this.makeDistortionCurve(p.waveformMix * 200);
      this.distortionCurveCache.set(curveKey, curve);
    }
    distortion.curve = curve;

    filter.type = "lowpass";
    filter.frequency.value = p.filterCutoff;
    filter.Q.value = p.resonance;
    filter.frequency.setValueAtTime(p.filterCutoff * 2, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(p.filterCutoff * 0.3, 100), now + p.filterDecay);

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(voiceVol, now + p.attack);
    if (slide) {
      gain.gain.setTargetAtTime(voiceVol * 0.7, now + duration * 0.5, duration * 0.3);
    } else {
      gain.gain.setTargetAtTime(0, now + duration * 0.6, duration * 0.3);
    }

    filter.connect(distortion);
    distortion.connect(gain);
    gain.connect(this.compressor);

    for (const frequency of frequencies) {
      const osc1 = this.ctx.createOscillator();
      const osc2 = this.ctx.createOscillator();
      osc1.type = p.waveformMix < 0.33 ? "sine" : p.waveformMix < 0.66 ? "sawtooth" : "square";
      osc1.frequency.value = frequency;
      osc1.detune.value = p.detune + (Math.random() < p.glitchProb ? (Math.random() - 0.5) * p.pitchRandom : 0);
      osc2.type = "sawtooth";
      osc2.frequency.value = frequency * (1 + p.harmonicSpread * 0.01);
      osc2.detune.value = -p.detune;

      const sub = this.ctx.createOscillator();
      const subGain = this.ctx.createGain();
      sub.type = "sine";
      sub.frequency.value = frequency * 0.5;
      subGain.gain.setValueAtTime(0.15, now);
      subGain.gain.setTargetAtTime(0, now + duration * 0.5, duration * 0.25);
      sub.connect(subGain);
      subGain.connect(filter);

      osc1.connect(filter);
      osc2.connect(filter);
      osc1.start(now);
      osc2.start(now);
      sub.start(now);
      osc1.stop(now + duration + 0.5);
      osc2.stop(now + duration + 0.5);
      sub.stop(now + duration + 0.5);
      osc1.onended = () => { osc1.disconnect(); };
      osc2.onended = () => { osc2.disconnect(); };
      sub.onended = () => { sub.disconnect(); subGain.disconnect(); };
    }

    const cleanupTime = (duration + 0.6) * 1000;
    setTimeout(() => { filter.disconnect(); distortion.disconnect(); gain.disconnect(); }, cleanupTime);
  }

  // ── FM synthesis: carrier + modulator for metallic, bell-like, and evolving tones ──
  private playNotesFM(frequencies: number[], duration: number, velocity: number, slide: boolean, time?: number) {
    if (!this.ctx || !this.compressor) return;
    const now = time ?? this.ctx.currentTime;
    const p = this.synthParams;
    const voiceVol = velocity * 0.35 / Math.max(1, frequencies.length * 0.7);

    // FM routing: modulator → carrier → filter → output
    // Surreal routing:
    // grotesqueness → mod index (more harmonics, more metallic)
    // institutionalDecay → mod decay (how fast the brightness fades)
    // visceralTension → carrier attack sharpness
    // cosmicDread → mod ratio drift (inharmonic, bell-like)
    const modIndex = 80 + p.waveformMix * 600; // modulation depth: 80-680 Hz
    const modRatio = 2 + p.pitchShift * -0.05; // ~2.0 at 0 dread, ~2.35 at max — slightly inharmonic
    const modDecay = 0.05 + p.filterDecay * 0.8; // how fast modulation fades

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(Math.min(p.filterCutoff * 3, 12000), now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(p.filterCutoff * 0.5, 200), now + p.filterDecay);
    filter.Q.value = Math.min(p.resonance * 0.5, 5); // gentler resonance for FM

    const masterGain = this.ctx.createGain();
    masterGain.gain.setValueAtTime(0, now);
    masterGain.gain.linearRampToValueAtTime(voiceVol, now + Math.max(p.attack * 0.5, 0.001));
    if (slide) {
      masterGain.gain.setTargetAtTime(voiceVol * 0.6, now + duration * 0.5, duration * 0.3);
    } else {
      masterGain.gain.setTargetAtTime(0, now + duration * 0.5, duration * 0.25);
    }

    filter.connect(masterGain);
    masterGain.connect(this.compressor);

    for (const frequency of frequencies) {
      // Modulator oscillator
      const mod = this.ctx.createOscillator();
      const modGain = this.ctx.createGain();
      mod.type = "sine";
      mod.frequency.value = frequency * modRatio;
      // Mod depth starts high and decays — creates the classic FM "plonk"
      modGain.gain.setValueAtTime(modIndex, now);
      modGain.gain.exponentialRampToValueAtTime(Math.max(modIndex * 0.05, 1), now + modDecay);

      // Carrier oscillator — frequency modulated by modulator
      const carrier = this.ctx.createOscillator();
      carrier.type = "sine";
      carrier.frequency.value = frequency;
      carrier.detune.value = p.detune * 0.5 + (Math.random() < p.glitchProb ? (Math.random() - 0.5) * p.pitchRandom : 0);

      // Second carrier at slight detune for width
      const carrier2 = this.ctx.createOscillator();
      carrier2.type = "sine";
      carrier2.frequency.value = frequency;
      carrier2.detune.value = -p.detune * 0.3 + p.harmonicSpread * 5;

      // Route: mod → carrier.frequency (FM)
      mod.connect(modGain);
      modGain.connect(carrier.frequency);
      modGain.connect(carrier2.frequency);

      carrier.connect(filter);
      carrier2.connect(filter);

      mod.start(now);
      carrier.start(now);
      carrier2.start(now);
      mod.stop(now + duration + 0.5);
      carrier.stop(now + duration + 0.5);
      carrier2.stop(now + duration + 0.5);
      carrier.onended = () => { carrier.disconnect(); carrier2.disconnect(); mod.disconnect(); modGain.disconnect(); };
    }

    const cleanupTime = (duration + 0.6) * 1000;
    setTimeout(() => { filter.disconnect(); masterGain.disconnect(); }, cleanupTime);
  }

  // ── Pluck synthesis: sharp attack with fast filter decay for guitar/harp/kalimba tones ──
  private playNotesPluck(frequencies: number[], duration: number, velocity: number, slide: boolean, time?: number) {
    if (!this.ctx || !this.compressor) return;
    const now = time ?? this.ctx.currentTime;
    const p = this.synthParams;
    const voiceVol = velocity * 0.45 / Math.max(1, frequencies.length * 0.7);

    // Pluck character:
    // grotesqueness → noise burst brightness and waveform
    // institutionalDecay → how fast the pluck decays
    // visceralTension → attack sharpness, more "snap"
    // cosmicDread → body resonance, darker tone
    const pluckDecay = 0.15 + (1 - p.compression) * 0.3; // shorter with tension
    const bodyDecay = duration * (0.4 + p.filterDecay * 0.3); // tail length from decay param
    const brightStart = 3000 + p.filterCutoff * 0.8; // initial brightness
    const darkEnd = Math.max(200, p.filterCutoff * 0.15); // how dark it gets

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    // Fast filter sweep is the pluck character — starts bright, decays quickly
    filter.frequency.setValueAtTime(Math.min(brightStart, 12000), now);
    filter.frequency.exponentialRampToValueAtTime(darkEnd, now + pluckDecay);
    filter.Q.value = 1 + p.resonance * 0.3; // mild resonance for body

    const masterGain = this.ctx.createGain();
    // Sharp attack, natural decay
    masterGain.gain.setValueAtTime(voiceVol, now); // instant attack
    if (slide) {
      masterGain.gain.setTargetAtTime(voiceVol * 0.4, now + bodyDecay * 0.3, bodyDecay * 0.4);
    } else {
      masterGain.gain.setTargetAtTime(0, now + bodyDecay * 0.15, bodyDecay * 0.35);
    }

    filter.connect(masterGain);
    masterGain.connect(this.compressor);

    for (const frequency of frequencies) {
      // Main tone — triangle or sawtooth depending on grotesqueness
      const osc = this.ctx.createOscillator();
      osc.type = p.waveformMix < 0.5 ? "triangle" : "sawtooth";
      osc.frequency.value = frequency;
      osc.detune.value = p.detune * 0.3 + (Math.random() < p.glitchProb ? (Math.random() - 0.5) * p.pitchRandom : 0);

      // Noise burst for the "pick" transient
      const burstDur = 0.008 + p.compression * 0.008; // punchier with tension
      this.playNoiseBuffer(this.noiseBufferShort, now, burstDur, voiceVol * 0.6, "highpass", 4000, 1);

      // Octave harmonic for shimmer (fades faster)
      const harm = this.ctx.createOscillator();
      const harmGain = this.ctx.createGain();
      harm.type = "sine";
      harm.frequency.value = frequency * 2;
      harmGain.gain.setValueAtTime(voiceVol * (0.15 + p.harmonicSpread * 0.15), now);
      harmGain.gain.exponentialRampToValueAtTime(0.001, now + pluckDecay * 0.6);
      harm.connect(harmGain);
      harmGain.connect(filter);

      osc.connect(filter);
      osc.start(now);
      harm.start(now);
      osc.stop(now + duration + 0.5);
      harm.stop(now + duration + 0.5);
      osc.onended = () => { osc.disconnect(); };
      harm.onended = () => { harm.disconnect(); harmGain.disconnect(); };
    }

    const cleanupTime = (duration + 0.6) * 1000;
    setTimeout(() => { filter.disconnect(); masterGain.disconnect(); }, cleanupTime);
  }

  /** Generate reverb impulse response. Deferred via setTimeout to avoid
   *  blocking during the calling frame, but the generation loop itself
   *  is synchronous (~5-15ms for typical impulse lengths). */
  private generateReverbAsync(duration: number, decay: number) {
    if (!this.ctx) return;
    const rate = this.ctx.sampleRate;
    const length = Math.ceil(rate * duration);
    setTimeout(() => {
      if (!this.ctx || !this.reverbNode) return;
      const buffer = this.ctx.createBuffer(2, length, rate);
      for (let ch = 0; ch < 2; ch++) {
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < length; i++) {
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
        }
      }
      if (this.reverbNode) {
        this.reverbNode.buffer = buffer;
      }
    }, 0);
  }

  /** Create a staircase curve that quantizes amplitude to `bits` levels */
  private makeBitcrushCurve(bits: number): Float32Array<ArrayBuffer> {
    const samples = 65536;
    const curve = new Float32Array(samples) as Float32Array<ArrayBuffer>;
    const steps = Math.pow(2, bits);
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = Math.round(x * steps) / steps;
    }
    return curve;
  }

  private makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
    const samples = 256;
    const curve = new Float32Array(samples) as Float32Array<ArrayBuffer>;
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }

  // Play a cached noise buffer (no allocation per hit)
  private playNoiseBuffer(buffer: AudioBuffer | null, time: number, duration: number, vol: number, filterType: BiquadFilterType, filterFreq: number, filterQ: number, dest?: AudioNode) {
    if (!this.ctx || !this.compressor || !buffer) return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    filter.Q.value = filterQ;
    gain.gain.setValueAtTime(vol, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(dest ?? this.compressor);
    source.start(time);
    source.stop(time + duration + 0.05);
    source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
  }

  private synthKick(time: number, vol: number, detune: number, p: SynthMappedParams, dest: AudioNode) {
    if (!this.ctx || !this.compressor) return;
    // Surreal routing:
    // grotesqueness (via detune/harmonicSpread) → pitch range warping, harmonic loudness
    // institutionalDecay (via filterDecay) → tail length
    // visceralTension (via attack/compression) → transient punch
    // cosmicDread (via pitchShift) → lower sub pitch
    const tailMult = 0.7 + p.filterDecay * 0.3; // 0.7–1.3x tail length
    const subDrop = 35 + p.pitchShift * 1.5; // lower floor when cosmic dread high (pitchShift is negative)
    const clickVol = vol * (0.25 + p.compression * 0.25); // more transient punch with tension

    // Main body: sine with pitch sweep
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(160 + detune * 0.5 + p.detune * 0.3, time);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, subDrop), time + 0.18 * tailMult);
    gain.gain.setValueAtTime(vol * 0.85, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.5 * tailMult);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(time);
    osc.stop(time + 0.6 * tailMult);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    // Second harmonic for body/warmth — louder with grotesqueness
    const osc2 = this.ctx.createOscillator();
    const gain2 = this.ctx.createGain();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(320 + detune + p.detune * 0.5, time);
    osc2.frequency.exponentialRampToValueAtTime(70, time + 0.1 * tailMult);
    gain2.gain.setValueAtTime(vol * (0.2 + p.harmonicSpread * 0.2), time);
    gain2.gain.exponentialRampToValueAtTime(0.001, time + 0.12 * tailMult);
    osc2.connect(gain2);
    gain2.connect(dest);
    osc2.start(time);
    osc2.stop(time + 0.2 * tailMult);
    osc2.onended = () => { osc2.disconnect(); gain2.disconnect(); };
    // Noise click for transient attack — punchier with tension
    this.playNoiseBuffer(this.noiseBufferShort, time, 0.02, clickVol, "highpass", 2000, 1, dest);
  }

  private synthSnare(time: number, vol: number, detune: number, p: SynthMappedParams, dest: AudioNode) {
    if (!this.ctx || !this.compressor) return;
    // Surreal routing:
    // grotesqueness → body frequency warping, noise Q
    // institutionalDecay → noise tail length, filter darkening
    // visceralTension → tighter body snap, brighter noise
    // cosmicDread → lower body pitch
    const tailMult = 0.7 + p.filterDecay * 0.3;
    const noiseFreq = 2000 + Math.min(p.filterCutoff, 6000) * 0.3; // darker when decayed
    const snapSpeed = 0.06 - p.compression * 0.02; // tighter snap with tension (0.04–0.06)

    // Body tone: sine for warmth
    const body = this.ctx.createOscillator();
    const bodyGain = this.ctx.createGain();
    body.type = "sine";
    body.frequency.value = 170 + detune * 0.2 + p.detune * 0.4;
    bodyGain.gain.setValueAtTime(vol * 0.4, time);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, time + 0.08 * tailMult);
    body.connect(bodyGain);
    bodyGain.connect(dest);
    body.start(time);
    body.stop(time + 0.12 * tailMult);
    body.onended = () => { body.disconnect(); bodyGain.disconnect(); };
    // Snap tone: triangle for attack character — tighter with tension
    const osc = this.ctx.createOscillator();
    const oscGain = this.ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = 230 + detune * 0.3 + p.detune * 0.3;
    oscGain.gain.setValueAtTime(vol * (0.4 + p.compression * 0.2), time);
    oscGain.gain.exponentialRampToValueAtTime(0.001, time + Math.max(0.02, snapSpeed));
    osc.connect(oscGain);
    oscGain.connect(dest);
    osc.start(time);
    osc.stop(time + Math.max(0.04, snapSpeed) + 0.02);
    osc.onended = () => { osc.disconnect(); oscGain.disconnect(); };
    // Noise: frequency responds to filter cutoff (decay), duration to tail
    this.playNoiseBuffer(this.noiseBufferMed, time, 0.18 * tailMult, vol * 0.85, "bandpass", noiseFreq, 1.5 + p.harmonicSpread, dest);
  }

  private synthHihat(time: number, vol: number, open: boolean, detune: number, p: SynthMappedParams, dest: AudioNode) {
    // Surreal routing:
    // grotesqueness → spread between body/shimmer bands
    // institutionalDecay → open duration, filter darkening
    // visceralTension → tighter closed hat
    // cosmicDread → lower body frequency
    const baseDuration = open ? 0.3 : 0.06;
    const tailMult = open ? (0.8 + p.filterDecay * 0.4) : (1.0 - p.compression * 0.3); // tension tightens closed hats
    const duration = baseDuration * Math.max(0.4, tailMult);
    const bodyFreq = 6000 + detune * 2 - p.pitchShift * 100; // cosmic dread shifts body down (pitchShift is negative)
    const shimmerFreq = 10000 + detune + p.detune * 20; // grotesqueness widens gap

    const buf = open ? this.noiseBufferLong : this.noiseBufferShort;
    // Lower band for body
    this.playNoiseBuffer(buf, time, duration, vol * 0.5, "bandpass", Math.max(2000, bodyFreq), 2 + p.harmonicSpread, dest);
    // Upper band for shimmer/brightness
    this.playNoiseBuffer(buf, time, duration * 0.7, vol * 0.4, "highpass", Math.max(4000, shimmerFreq), 1, dest);
  }

  private synthClap(time: number, vol: number, _detune: number, p: SynthMappedParams, dest: AudioNode) {
    if (!this.ctx || !this.compressor) return;
    // Surreal routing:
    // visceralTension → tighter spacing between bursts, sharper
    // institutionalDecay → longer tail
    // grotesqueness → wider bandwidth (lower Q)
    const burstSpacing = 0.015 - p.compression * 0.005; // 0.01–0.015 — tighter with tension
    const tailMult = 0.7 + p.filterDecay * 0.3;
    const clapQ = 3 - p.harmonicSpread * 1.5; // grotesqueness opens up the bandwidth

    // Multiple micro-bursts using cached noise
    for (let i = 0; i < 3; i++) {
      const t = time + i * Math.max(0.008, burstSpacing);
      this.playNoiseBuffer(this.noiseBufferShort, t, 0.04, vol * 0.9, "bandpass", 2000, Math.max(0.5, clapQ), dest);
    }
    // Tail — longer with decay
    this.playNoiseBuffer(this.noiseBufferMed, time + 0.04, 0.11 * tailMult, vol * 1.0, "bandpass", 2500, 2, dest);
  }

  private synthTom(time: number, vol: number, detune: number, p: SynthMappedParams, dest: AudioNode) {
    if (!this.ctx || !this.compressor) return;
    // Surreal routing:
    // grotesqueness → start pitch, detune
    // institutionalDecay → decay length
    // cosmicDread → lower floor pitch
    const tailMult = 0.7 + p.filterDecay * 0.3;
    const floorPitch = Math.max(30, 60 + p.pitchShift * 2); // lower with cosmic dread

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(120 + detune * 0.4 + p.detune * 0.3, time);
    osc.frequency.exponentialRampToValueAtTime(floorPitch, time + 0.2 * tailMult);
    gain.gain.setValueAtTime(vol * 0.7, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.3 * tailMult);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(time);
    osc.stop(time + 0.35 * tailMult);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  }

  private synthRim(time: number, vol: number, detune: number, p: SynthMappedParams, dest: AudioNode) {
    if (!this.ctx || !this.compressor) return;
    // Surreal routing:
    // grotesqueness → frequency warping
    // visceralTension → sharper, shorter decay
    const decay = 0.03 - p.compression * 0.01; // tighter with tension

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 800 + detune + p.detune * 2;
    gain.gain.setValueAtTime(vol * 0.8, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + Math.max(0.01, decay));
    osc.connect(gain);
    gain.connect(dest);
    osc.start(time);
    osc.stop(time + Math.max(0.02, decay) + 0.02);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  }

  private synthPerc(time: number, vol: number, detune: number, p: SynthMappedParams, dest: AudioNode) {
    if (!this.ctx || !this.compressor) return;
    // Surreal routing:
    // grotesqueness → start/end pitch spread
    // institutionalDecay → tail length
    // visceralTension → sharper attack
    const tailMult = 0.7 + p.filterDecay * 0.3;
    const startFreq = 600 + detune + p.detune * 2;
    const endFreq = Math.max(80, 200 + p.pitchShift * 5);

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(startFreq, time);
    osc.frequency.exponentialRampToValueAtTime(endFreq, time + 0.05 * tailMult);
    gain.gain.setValueAtTime(vol * 1.0, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.1 * tailMult);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(time);
    osc.stop(time + 0.15 * tailMult);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  }

  get currentTime(): number {
    return this.ctx?.currentTime ?? 0;
  }

  get isReady(): boolean {
    return this.ctx !== null;
  }

  async resume() {
    if (this.ctx?.state === "suspended") {
      await this.ctx.resume();
    }
  }

  getState(): string {
    return this.ctx?.state ?? "uninitialized";
  }

  /** Create a MediaStream tapped from the limiter output — for recording.
   *  Returns both the stream and a cleanup function to disconnect the tap. */
  createOutputStream(): { stream: MediaStream; cleanup: () => void } | null {
    if (!this.ctx || !this.limiter) return null;
    const dest = this.ctx.createMediaStreamDestination();
    this.limiter.connect(dest);
    return {
      stream: dest.stream,
      cleanup: () => {
        try { this.limiter?.disconnect(dest); } catch { /* already disconnected */ }
        dest.stream.getTracks().forEach(t => t.stop());
      },
    };
  }

  /** Expose the AudioContext and limiter node for direct PCM capture (WAV export). */
  getAudioGraph(): { ctx: AudioContext; limiter: AudioNode } | null {
    if (!this.ctx || !this.limiter) return null;
    return { ctx: this.ctx, limiter: this.limiter };
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 44100;
  }

  playTestTone() {
    if (!this.ctx || !this.compressor) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 440;
    gain.gain.setValueAtTime(0.5, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 1.0);
    osc.connect(gain);
    gain.connect(this.compressor); // route through signal chain, not directly to destination
    osc.start(this.ctx.currentTime);
    osc.stop(this.ctx.currentTime + 1.1);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  }
}
