import type { PatternState } from "./types";
import { DRUM_VOICES } from "./types";

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ──────────────────────────────────────────────
// WAV encoding from raw PCM Float32 samples
// ──────────────────────────────────────────────

/** Encode interleaved Float32 PCM samples into a 16-bit WAV Blob. */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number,
  numChannels: number,
): Blob {
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataByteLength = samples.length * bytesPerSample;
  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + dataByteLength);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataByteLength, true); // file size - 8
  writeString(view, 8, "WAVE");

  // fmt sub-chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // sub-chunk size (PCM = 16)
  view.setUint16(20, 1, true); // audio format (1 = PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data sub-chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataByteLength, true);

  // Convert Float32 [-1, 1] to Int16
  let offset = headerSize;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    const int16 = s < 0 ? s * 0x8000 : s * 0x7FFF;
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  console.log(`WAV encoded: ${samples.length} samples, ${numChannels}ch, ${sampleRate}Hz, ${buffer.byteLength} bytes`);
  return new Blob([buffer], { type: "audio/wav" });
}

// ──────────────────────────────────────────────
// Audio recording (one loop) — captures raw PCM → WAV
// ──────────────────────────────────────────────

/**
 * Record one loop of audio as a WAV file by capturing raw PCM samples
 * from the audio engine's output via ScriptProcessorNode.
 */
export function recordOneLoop(
  ctx: AudioContext,
  sourceNode: AudioNode,
  durationMs: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const numChannels = 2; // stereo
    const sampleRate = ctx.sampleRate;
    const bufferSize = 4096;
    const totalDuration = durationMs + 500; // extra for reverb/delay tails
    const totalFrames = Math.ceil((totalDuration / 1000) * sampleRate);
    const totalInterleavedSamples = totalFrames * numChannels;

    // Collect interleaved stereo samples
    const allSamples = new Float32Array(totalInterleavedSamples);
    let samplesWritten = 0;
    let resolved = false;

    function finish() {
      if (resolved) return;
      resolved = true;
      try { sourceNode.disconnect(processor); } catch { /* ok */ }
      try { processor.disconnect(); } catch { /* ok */ }

      const trimmed = allSamples.subarray(0, samplesWritten);
      const wavBlob = encodeWav(trimmed, sampleRate, numChannels);
      console.log(`WAV recording complete: ${samplesWritten / numChannels} frames, ${wavBlob.size} bytes`);
      resolve(wavBlob);
    }

    // ScriptProcessorNode is deprecated but universally supported and simple for
    // one-shot capture. AudioWorklet would be overkill here since we only use
    // this briefly during export, not during live playback.
    let processor: ScriptProcessorNode;
    try {
      processor = ctx.createScriptProcessor(bufferSize, numChannels, numChannels);
    } catch (err) {
      reject(new Error(`Failed to create audio processor: ${err}`));
      return;
    }

    processor.onaudioprocess = (e: AudioProcessingEvent) => {
      if (samplesWritten >= totalInterleavedSamples) return;

      const left = e.inputBuffer.getChannelData(0);
      const right = e.inputBuffer.getChannelData(1);

      for (let i = 0; i < left.length; i++) {
        // Need room for both left AND right sample before writing either
        if (samplesWritten + 1 >= totalInterleavedSamples) break;
        allSamples[samplesWritten++] = left[i]!;
        allSamples[samplesWritten++] = right[i]!;
      }

      // Resolve early if we've captured enough samples (audio clock may
      // run ahead of wall clock, so this prevents unnecessary waiting)
      if (samplesWritten >= totalInterleavedSamples) {
        finish();
      }
    };

    // Tap into the source node (limiter output)
    sourceNode.connect(processor);
    processor.connect(ctx.destination); // processor must be connected to work

    console.log(`WAV recording started, will capture ${totalDuration}ms (${totalFrames} frames per channel)`);

    // Wall-clock safety timeout — ensures we always resolve even if
    // audio processing stalls or runs slower than real time
    setTimeout(() => {
      finish();
    }, totalDuration + 2000); // generous extra margin
  });
}

// ──────────────────────────────────────────────
// MIDI file generation
// ──────────────────────────────────────────────

// General MIDI drum map (channel 10)
const DRUM_MIDI_MAP: Record<string, number> = {
  kick: 36,    // Bass Drum 1
  snare: 38,   // Acoustic Snare
  hihat: 42,   // Closed Hi-Hat
  clap: 39,    // Hand Clap
  tom: 45,     // Low Tom
  rim: 37,     // Side Stick
  cymbal: 49,  // Crash Cymbal 1
  perc: 56,    // Cowbell
};

export function exportMidi(pattern: PatternState): Blob {
  const ticksPerQuarter = 480;
  const ticksPerStep = ticksPerQuarter / 4; // 16th notes

  const headerChunk = buildMidiHeader(3); // Format 1, 3 tracks (conductor + drums + melody)
  const conductorTrack = buildConductorTrack(pattern);
  const drumTrack = buildDrumTrack(pattern, ticksPerStep);
  const melodyTrack = buildMelodyTrack(pattern, ticksPerStep);

  const parts = [headerChunk, conductorTrack, drumTrack, melodyTrack];
  const totalLength = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }

  return new Blob([result], { type: "audio/midi" });
}

function buildMidiHeader(numTracks: number): ArrayBuffer {
  const buf = new ArrayBuffer(14);
  const view = new DataView(buf);
  // "MThd"
  writeString(view, 0, "MThd");
  view.setUint32(4, 6); // chunk length
  view.setUint16(8, 1); // format 1 (multi-track)
  view.setUint16(10, numTracks);
  view.setUint16(12, 480); // ticks per quarter note
  return buf;
}

function buildConductorTrack(pattern: PatternState): ArrayBuffer {
  const events: number[] = [];

  // Track name
  addMetaEvent(events, 0, 0x03, stringToBytes("Symphonia"));

  // Tempo
  const microsecondsPerBeat = Math.round(60000000 / pattern.tempo);
  addMetaEvent(events, 0, 0x51, [
    (microsecondsPerBeat >> 16) & 0xFF,
    (microsecondsPerBeat >> 8) & 0xFF,
    microsecondsPerBeat & 0xFF,
  ]);

  // Time signature: 4/4
  addMetaEvent(events, 0, 0x58, [4, 2, 24, 8]);

  // End of track
  addMetaEvent(events, 0, 0x2F, []);

  return wrapTrackChunk(events);
}

/** Apply swing offset: odd-numbered steps get pushed forward.
 *  Matches playback formula: swing * stepDuration * 0.33 for odd steps.
 *  swing=0 means no offset, swing=1 means maximum triplet-feel push. */
function swungTick(step: number, ticksPerStep: number, swing: number): number {
  const baseTick = step * ticksPerStep;
  if (step % 2 === 1 && swing > 0) {
    const swingOffset = Math.round(swing * ticksPerStep * 0.33);
    return baseTick + swingOffset;
  }
  return baseTick;
}

function buildDrumTrack(pattern: PatternState, ticksPerStep: number): ArrayBuffer {
  const events: number[] = [];

  // Track name
  addMetaEvent(events, 0, 0x03, stringToBytes("Drums"));

  // Collect all drum events
  const drumEvents: { tick: number; note: number; velocity: number }[] = [];

  for (let t = 0; t < pattern.drumTracks.length; t++) {
    const track = pattern.drumTracks[t];
    if (!track || track.muted) continue;
    const voice = DRUM_VOICES[t];
    if (!voice) continue;
    const midiNote = DRUM_MIDI_MAP[voice.voice] ?? 36;

    // Drum tracks may have fewer steps than stepsPerBar (e.g. 8 steps looping 2x in a 16-step bar)
    // Repeat the pattern to fill the full bar for MIDI export
    for (let s = 0; s < pattern.stepsPerBar; s++) {
      const step = track.steps[s % track.steps.length];
      if (!step || !step.active) continue;
      const velocity = Math.round(step.velocity * (step.accent ? 127 : 100));
      drumEvents.push({
        tick: swungTick(s, ticksPerStep, pattern.swing),
        note: midiNote,
        velocity: Math.min(127, velocity),
      });
    }
  }

  // Sort by tick
  drumEvents.sort((a, b) => a.tick - b.tick);

  // Flatten to on/off pairs so simultaneous hits don't corrupt timing
  const flatEvents: { tick: number; type: "on" | "off"; note: number; velocity: number }[] = [];
  for (const ev of drumEvents) {
    flatEvents.push({ tick: ev.tick, type: "on", note: ev.note, velocity: ev.velocity });
    flatEvents.push({ tick: ev.tick + Math.round(ticksPerStep * 0.5), type: "off", note: ev.note, velocity: 0 });
  }

  // Sort: offs before ons at same tick, then by tick
  flatEvents.sort((a, b) => {
    if (a.tick !== b.tick) return a.tick - b.tick;
    if (a.type === "off" && b.type === "on") return -1;
    if (a.type === "on" && b.type === "off") return 1;
    return 0;
  });

  let currentTick = 0;
  for (const ev of flatEvents) {
    const delta = ev.tick - currentTick;
    addVarLen(events, delta);
    if (ev.type === "on") {
      events.push(0x99, ev.note, ev.velocity); // channel 10
    } else {
      events.push(0x89, ev.note, 0); // note off
    }
    currentTick = ev.tick;
  }

  // End of track
  addMetaEvent(events, 0, 0x2F, []);

  return wrapTrackChunk(events);
}

function buildMelodyTrack(pattern: PatternState, ticksPerStep: number): ArrayBuffer {
  const events: number[] = [];
  const track = pattern.melodyTrack;

  // Track name
  addMetaEvent(events, 0, 0x03, stringToBytes("Melody"));

  // Program change: Synth Lead (GM program 81 = Lead 1 Square)
  addVarLen(events, 0);
  events.push(0xC0, 80); // channel 1, program 80 (0-indexed)

  if (track.muted) {
    addMetaEvent(events, 0, 0x2F, []);
    return wrapTrackChunk(events);
  }

  // Collect note events with proper durations (handle ties)
  const noteEvents: { tick: number; notes: number[]; velocity: number; duration: number }[] = [];

  for (let s = 0; s < track.steps.length; s++) {
    const step = track.steps[s];
    if (!step || !step.active || step.tie) continue;
    if (step.notes.length === 0) continue;

    // Calculate duration including ties (wraps across bar boundary)
    let duration = 1;
    for (let t = 1; t < track.steps.length; t++) {
      const idx = (s + t) % track.steps.length;
      const nextStep = track.steps[idx];
      if (nextStep && nextStep.active && nextStep.tie) {
        duration++;
      } else {
        break;
      }
    }

    // Calculate swung start and end ticks for accurate duration
    // Cap at bar end so looping MIDI doesn't overshoot
    const barEndTick = track.steps.length * ticksPerStep;
    const startTick = swungTick(s, ticksPerStep, pattern.swing);
    const rawEndTick = swungTick(s + duration, ticksPerStep, pattern.swing);
    const endTick = Math.min(rawEndTick, barEndTick);

    noteEvents.push({
      tick: startTick,
      notes: step.notes,
      velocity: Math.min(127, Math.round(step.velocity * 127)),
      duration: endTick - startTick,
    });
  }

  // Write events sorted by time — need to handle simultaneous note-offs and note-ons
  // Build a flat list of on/off events
  const flatEvents: { tick: number; type: "on" | "off"; note: number; velocity: number }[] = [];

  for (const ne of noteEvents) {
    for (const note of ne.notes) {
      flatEvents.push({ tick: ne.tick, type: "on", note, velocity: ne.velocity });
      flatEvents.push({ tick: ne.tick + ne.duration, type: "off", note, velocity: 0 });
    }
  }

  // Sort: offs before ons at same tick, then by tick
  flatEvents.sort((a, b) => {
    if (a.tick !== b.tick) return a.tick - b.tick;
    if (a.type === "off" && b.type === "on") return -1;
    if (a.type === "on" && b.type === "off") return 1;
    return 0;
  });

  let currentTick = 0;
  for (const ev of flatEvents) {
    const delta = ev.tick - currentTick;
    addVarLen(events, delta);
    if (ev.type === "on") {
      events.push(0x90, ev.note, ev.velocity); // note on channel 1
    } else {
      events.push(0x80, ev.note, 0); // note off channel 1
    }
    currentTick = ev.tick;
  }

  // End of track
  addMetaEvent(events, 0, 0x2F, []);

  return wrapTrackChunk(events);
}

// ── MIDI helpers ──

function addVarLen(events: number[], value: number) {
  if (value < 0) value = 0;
  const bytes: number[] = [];
  bytes.push(value & 0x7F);
  let v = value >> 7;
  while (v > 0) {
    bytes.push((v & 0x7F) | 0x80);
    v >>= 7;
  }
  bytes.reverse();
  events.push(...bytes);
}

function addMetaEvent(events: number[], delta: number, type: number, data: number[]) {
  addVarLen(events, delta);
  events.push(0xFF, type);
  addVarLen(events, data.length);
  events.push(...data);
}

function stringToBytes(str: string): number[] {
  return Array.from(str).map(c => c.charCodeAt(0));
}

function wrapTrackChunk(events: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(8 + events.length);
  const view = new DataView(buf);
  writeString(view, 0, "MTrk");
  view.setUint32(4, events.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < events.length; i++) {
    bytes[8 + i] = events[i]!;
  }
  return buf;
}

// ──────────────────────────────────────────────
// Download helper
// ──────────────────────────────────────────────

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Delay revocation so the browser has time to start the download
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Calculate the duration of one loop in milliseconds */
export function loopDurationMs(pattern: PatternState): number {
  const stepsPerBeat = 4;
  const beats = pattern.stepsPerBar / stepsPerBeat;
  return (beats / pattern.tempo) * 60 * 1000;
}
