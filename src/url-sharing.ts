import type { PatternState, SynthMode } from "./types";
import { createDefaultPattern, emptyMelodyStep } from "./presets";

// Compact URL encoding for pattern sharing
// Format: base64-encoded JSON with abbreviated keys to minimize URL length

interface CompactPattern {
  t: number;   // tempo
  sw: number;  // swing
  sc: string;  // scale
  rn: number;  // rootNote
  sm: string;  // synthMode
  mv: number;  // masterVolume
  su: number[]; // surreal [grot, decay, corrupt, tension, dread]
  d: string[];  // drum tracks: each is a compact string encoding
  m: string;    // melody track: compact string encoding
  dm: number;  // drum mute bitmask
  mm: number;  // melody muted (0/1)
  dv: number[]; // drum volumes
  mo: number;  // melody octave
  mlv: number; // melody volume
  ch?: number; // customHue (0-360)
  pn?: string; // preset name for shared patterns
}

function encodeDrumTrack(steps: PatternState["drumTracks"][0]["steps"]): string {
  // Each step: 2 chars — velocity hex (0-F) + flags (active bit 0, accent bit 1)
  return steps.map(s => {
    const vel = Math.round(s.velocity * 15).toString(16);
    const flags = (s.active ? 1 : 0) | (s.accent ? 2 : 0);
    return vel + flags.toString(16);
  }).join("");
}

function decodeDrumTrack(encoded: string): PatternState["drumTracks"][0]["steps"] {
  const steps = [];
  for (let i = 0; i < encoded.length; i += 2) {
    const vel = parseInt(encoded[i] ?? "7", 16) / 15;
    const flags = parseInt(encoded[i + 1] ?? "0", 16);
    steps.push({
      active: (flags & 1) !== 0,
      velocity: vel,
      accent: (flags & 2) !== 0,
    });
  }
  return steps;
}

function encodeMelodyTrack(steps: PatternState["melodyTrack"]["steps"]): string {
  // Each step: variable length, separated by ','
  // Format: flags(hex) + notes(midi, joined by '+') + 'v' + velocity_hex
  return steps.map(s => {
    const flags = (s.active ? 1 : 0) | (s.slide ? 2 : 0) | (s.tie ? 4 : 0);
    if (!s.active) return flags.toString(16);
    const notes = s.notes.join("+");
    const vel = Math.round(s.velocity * 15).toString(16);
    return `${flags.toString(16)}${notes}v${vel}`;
  }).join(",");
}

function decodeMelodyTrack(encoded: string): PatternState["melodyTrack"]["steps"] {
  return encoded.split(",").map(part => {
    if (part.length === 0) return emptyMelodyStep();
    const flags = parseInt(part[0] ?? "0", 16);
    const active = (flags & 1) !== 0;
    const slide = (flags & 2) !== 0;
    const tie = (flags & 4) !== 0;

    if (!active) return { active, notes: [], velocity: 0.7, slide, tie };

    const rest = part.slice(1);
    const vIdx = rest.lastIndexOf("v");
    if (vIdx === -1) return { active, notes: [], velocity: 0.7, slide, tie };

    const noteStr = rest.slice(0, vIdx);
    const velHex = rest.slice(vIdx + 1);
    const notes = noteStr.length > 0 ? noteStr.split("+").map(Number).filter(n => !isNaN(n)) : [];
    const velocity = parseInt(velHex || "b", 16) / 15;

    return { active, notes, velocity, slide, tie };
  });
}

export function encodePatternToHash(pattern: PatternState, presetName?: string): string {
  const compact: CompactPattern = {
    t: pattern.tempo,
    sw: Math.round(pattern.swing * 100) / 100,
    sc: pattern.scale,
    rn: pattern.rootNote,
    sm: pattern.synthMode,
    mv: Math.round(pattern.masterVolume * 100) / 100,
    su: [
      Math.round(pattern.surreal.grotesqueness * 100) / 100,
      Math.round(pattern.surreal.institutionalDecay * 100) / 100,
      Math.round(pattern.surreal.digitalCorruption * 100) / 100,
      Math.round(pattern.surreal.visceralTension * 100) / 100,
      Math.round(pattern.surreal.cosmicDread * 100) / 100,
    ],
    d: pattern.drumTracks.map(t => encodeDrumTrack(t.steps)),
    m: encodeMelodyTrack(pattern.melodyTrack.steps),
    dm: pattern.drumTracks.reduce((mask, t, i) => mask | (t.muted ? (1 << i) : 0), 0),
    mm: pattern.melodyTrack.muted ? 1 : 0,
    dv: pattern.drumTracks.map(t => Math.round(t.volume * 100) / 100),
    mo: pattern.melodyTrack.octave,
    mlv: Math.round(pattern.melodyTrack.volume * 100) / 100,
    ...(pattern.customHue != null ? { ch: pattern.customHue } : {}),
    ...(presetName ? { pn: presetName } : {}),
  };

  const json = JSON.stringify(compact);
  // Unicode-safe base64 encoding via TextEncoder
  const bytes = new TextEncoder().encode(json);
  const binary = Array.from(bytes, b => String.fromCharCode(b)).join("");
  return btoa(binary);
}

export function decodePatternFromHash(hash: string): { pattern: PatternState; presetName?: string } | null {
  try {
    const binary = atob(hash);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const compact: CompactPattern = JSON.parse(json);
    const base = createDefaultPattern();

    // Validate essential fields exist
    if (typeof compact.t !== "number" || !compact.sc || !Array.isArray(compact.su)) {
      console.log("URL sharing: invalid pattern data");
      return null;
    }

    const surreal = {
      grotesqueness: compact.su[0] ?? 0.15,
      institutionalDecay: compact.su[1] ?? 0.1,
      digitalCorruption: compact.su[2] ?? 0,
      visceralTension: compact.su[3] ?? 0.3,
      cosmicDread: compact.su[4] ?? 0.2,
    };

    const drumTracks = base.drumTracks.map((baseTrack, i) => ({
      ...baseTrack,
      steps: compact.d[i] ? decodeDrumTrack(compact.d[i]) : baseTrack.steps,
      muted: (compact.dm & (1 << i)) !== 0,
      volume: compact.dv[i] ?? 0.8,
    }));

    const melodySteps = compact.m ? decodeMelodyTrack(compact.m) : base.melodyTrack.steps;

    return {
      pattern: {
        ...base,
        tempo: compact.t,
        swing: compact.sw ?? 0,
        scale: compact.sc,
        rootNote: compact.rn ?? 48,
        synthMode: (compact.sm as SynthMode) ?? "subtractive",
        masterVolume: compact.mv ?? 0.7,
        surreal,
        drumTracks,
        melodyTrack: {
          steps: melodySteps,
          muted: compact.mm === 1,
          volume: compact.mlv ?? 0.7,
          octave: compact.mo ?? 0,
        },
        ...(compact.ch != null ? { customHue: compact.ch } : {}),
      },
      presetName: compact.pn,
    };
  } catch (e) {
    console.log("URL sharing: failed to decode pattern from hash", e);
    return null;
  }
}

export function getPatternFromURL(): { pattern: PatternState; presetName?: string } | null {
  const hash = window.location.hash.slice(1); // remove '#'
  if (!hash || !hash.startsWith("p=")) return null;
  const encoded = hash.slice(2); // remove 'p='
  return decodePatternFromHash(decodeURIComponent(encoded));
}

export function setPatternToURL(pattern: PatternState, presetName?: string) {
  const encoded = encodePatternToHash(pattern, presetName);
  const url = new URL(window.location.href);
  url.hash = `p=${encoded}`;
  // Use replaceState to avoid polluting browser history on every change
  window.history.replaceState(null, "", url.toString());
}

export function clearPatternURL() {
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}
