import type { PresetDefinition, PatternState, DrumTrack, MelodyTrack, DrumStep, MelodyStep, SynthMode } from "./types";
import { DRUM_VOICES } from "./types";

// Convert HSL to hex string
function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Derive a full color scheme from a hue (0-360) */
export function hueToColorScheme(hue: number): { bg: string; accent: string; glow: string } {
  return {
    bg: hslToHex(hue, 0.3, 0.04),
    accent: hslToHex(hue, 0.55, 0.45),
    glow: hslToHex(hue, 0.65, 0.58),
  };
}

function emptyDrumStep(): DrumStep {
  return { active: false, velocity: 0.7, accent: false };
}

export function emptyMelodyStep(): MelodyStep {
  return { active: false, notes: [], velocity: 0.7, slide: false, tie: false };
}

function emptyDrumTracks(): DrumTrack[] {
  return DRUM_VOICES.map(v => ({
    name: v.name,
    steps: Array.from({ length: 8 }, () => emptyDrumStep()),
    muted: false,
    volume: 0.8,
  }));
}

function emptyMelodyTrack(): MelodyTrack {
  return {
    steps: Array.from({ length: 16 }, () => emptyMelodyStep()),
    muted: false,
    volume: 0.7,
    octave: 0,
  };
}

export function createDefaultPattern(): PatternState {
  return {
    tempo: 120,
    swing: 0,
    stepsPerBar: 16,
    bars: 1,
    currentBar: 0,
    drumTracks: emptyDrumTracks(),
    melodyTrack: emptyMelodyTrack(),
    surreal: {
      grotesqueness: 0.15,
      institutionalDecay: 0.1,
      digitalCorruption: 0.0,
      visceralTension: 0.3,
      cosmicDread: 0.2,
    },
    masterVolume: 0.7,
    scale: "phrygian",
    rootNote: 48, // C3
    synthMode: "subtractive",
  };
}

// Helper: set a drum hit with velocity + optional accent
function setHit(tracks: DrumTrack[], trackIdx: number, stepIdx: number, velocity: number, accent = false) {
  const step = tracks[trackIdx]?.steps[stepIdx];
  if (step) { step.active = true; step.velocity = velocity; step.accent = accent; }
}

// Helper: set a melody note (single) on a step
function setNote(track: MelodyTrack, stepIdx: number, note: number, opts?: { velocity?: number; slide?: boolean; tie?: boolean }) {
  const step = track.steps[stepIdx];
  if (!step) return;
  step.active = true;
  step.notes = [note];
  if (opts?.velocity !== undefined) step.velocity = opts.velocity;
  if (opts?.slide) step.slide = true;
  if (opts?.tie) step.tie = true;
}

// Helper: set a chord on a step
function setChord(track: MelodyTrack, stepIdx: number, notes: number[], opts?: { velocity?: number; slide?: boolean; tie?: boolean }) {
  const step = track.steps[stepIdx];
  if (!step) return;
  step.active = true;
  step.notes = notes;
  if (opts?.velocity !== undefined) step.velocity = opts.velocity;
  if (opts?.slide) step.slide = true;
  if (opts?.tie) step.tie = true;
}

// Helper: set tie on a step (sustain previous notes)
function setTie(track: MelodyTrack, stepIdx: number) {
  const step = track.steps[stepIdx];
  if (!step) return;
  step.active = true;
  step.tie = true;
  step.notes = [];
}

// Drum track indices: 0=KICK, 1=SNARE, 2=HAT, 3=CLAP, 4=TOM, 5=RIM, 6=CYM, 7=PERC

export const PRESETS: PresetDefinition[] = [
  {
    name: "Blank Canvas",
    description: "Empty slate. Pure potential.",
    colorScheme: { bg: "#0a0a0a", accent: "#444444", glow: "#666666" },
    defaultState: {},
  },
  {
    name: "Bosch Hellscape",
    description: "Tortured harmonics writhe beneath industrial percussion.",
    colorScheme: { bg: "#1a0505", accent: "#cc2200", glow: "#ff4400" },
    defaultState: {
      tempo: 95,
      swing: 0.12,
      scale: "phrygian",
      rootNote: 36, // C2
      surreal: {
        grotesqueness: 0,
        institutionalDecay: 0,
        digitalCorruption: 0.15,
        visceralTension: 0,
        cosmicDread: 0.35,
      },
      drumTracks: (() => {
        const t = DRUM_VOICES.map(v => ({
          name: v.name,
          steps: Array.from({ length: 16 }, () => emptyDrumStep()),
          muted: false,
          volume: 0.8,
        }));
        // KICK: sparse, off-beat
        setHit(t, 0, 0, 0.53); setHit(t, 0, 9, 0.93); setHit(t, 0, 12, 0.6);
        // SNARE: scattered hits with ghosting
        setHit(t, 1, 0, 0.73); setHit(t, 1, 3, 0.53); setHit(t, 1, 4, 0.53);
        setHit(t, 1, 7, 0.53); setHit(t, 1, 13, 0.53); setHit(t, 1, 15, 0.67);
        // HAT: back-loaded, accented crash at end
        setHit(t, 2, 7, 0.73); setHit(t, 2, 8, 0.87); setHit(t, 2, 10, 0.93);
        setHit(t, 2, 13, 0.53); setHit(t, 2, 15, 0.93, true);
        // CLAP: busy texture, accented on 1
        setHit(t, 3, 1, 0.8); setHit(t, 3, 2, 0.8); setHit(t, 3, 5, 0.53);
        setHit(t, 3, 7, 0.8); setHit(t, 3, 10, 0.53); setHit(t, 3, 11, 0.6);
        setHit(t, 3, 12, 0.67); setHit(t, 3, 13, 0.6);
        // TOM: deep thuds, accented at end
        setHit(t, 4, 1, 0.93); setHit(t, 4, 5, 0.67); setHit(t, 4, 9, 0.67);
        setHit(t, 4, 14, 0.87); setHit(t, 4, 15, 0.8);
        // RIM: busy percussive texture, accented on 5
        setHit(t, 5, 2, 0.93); setHit(t, 5, 3, 1.0); setHit(t, 5, 4, 0.67);
        setHit(t, 5, 5, 0.8, true); setHit(t, 5, 7, 0.87); setHit(t, 5, 14, 0.6);
        // CYM: sparse wash
        setHit(t, 6, 0, 0.53); setHit(t, 6, 9, 0.87); setHit(t, 6, 11, 0.73);
        setHit(t, 6, 15, 0.67);
        // PERC: scattered texture
        setHit(t, 7, 1, 0.67); setHit(t, 7, 4, 0.73); setHit(t, 7, 7, 0.6);
        setHit(t, 7, 9, 0.67); setHit(t, 7, 13, 0.87); setHit(t, 7, 14, 0.6);
        return t;
      })(),
      melodyTrack: (() => {
        const m = emptyMelodyTrack();
        // Dark phrygian chords with wide spacing and silences
        setChord(m, 0, [58, 61, 65], { velocity: 0.6, slide: true });  // A#3+C#4+F4
        setTie(m, 1);
        setTie(m, 2);
        // step 3: rest
        setChord(m, 4, [41, 44, 48], { velocity: 0.73, slide: true }); // F2+Ab2+C3
        // steps 5-7: rest
        setNote(m, 8, 41, { velocity: 0.6 });                           // F2 — lone bass note
        // steps 9-10: rest
        setChord(m, 11, [36, 39, 43], { velocity: 0.8 });               // C2+Eb2+G2 — root chord
        setChord(m, 12, [43, 46, 49], { velocity: 0.8, slide: true });  // G2+Bb2+Db3
        setTie(m, 13);
        setTie(m, 14);
        // step 15: rest
        return m;
      })(),
    },
  },
  {
    name: "Corrupted Nostalgia",
    description: "A warped memory. Lo-fi ghosts of better times.",
    colorScheme: { bg: "#0a0a14", accent: "#6644aa", glow: "#8866cc" },
    defaultState: {
      tempo: 78,
      swing: 0.2,
      scale: "major",
      rootNote: 48, // C3
      synthMode: "pluck" as SynthMode,
      surreal: {
        grotesqueness: 0.08,
        institutionalDecay: 0.3,
        digitalCorruption: 0.05,
        visceralTension: 0.15,
        cosmicDread: 0.4,
      },
      drumTracks: (() => {
        const t = emptyDrumTracks();
        // Lo-fi boom bap with swing
        setHit(t, 0, 0, 0.8); setHit(t, 0, 5, 0.65);
        setHit(t, 1, 2, 0.7); setHit(t, 1, 6, 0.75, true);
        setHit(t, 2, 0, 0.4); setHit(t, 2, 2, 0.45); setHit(t, 2, 4, 0.4); setHit(t, 2, 6, 0.45);
        setHit(t, 3, 2, 0.5); setHit(t, 3, 6, 0.5);
        setHit(t, 5, 4, 0.25); setHit(t, 5, 7, 0.2);
        return t;
      })(),
      melodyTrack: (() => {
        const m = emptyMelodyTrack();
        // Bittersweet major melody — warm and memorable, like a half-remembered pop song
        setNote(m, 0, 60, { velocity: 0.6 });
        setTie(m, 1);
        setNote(m, 2, 64, { velocity: 0.55 });
        setNote(m, 4, 67, { velocity: 0.7 });
        setTie(m, 5);
        setNote(m, 6, 65, { velocity: 0.5, slide: true });
        setNote(m, 8, 64, { velocity: 0.65 });
        setTie(m, 9);
        setNote(m, 10, 67, { velocity: 0.6 });
        setNote(m, 12, 72, { velocity: 0.7 });
        setTie(m, 13);
        setNote(m, 14, 71, { velocity: 0.5, slide: true });
        setNote(m, 15, 67, { velocity: 0.4 });
        return m;
      })(),
    },
  },
  {
    name: "Adult Swim Fever Dream",
    description: "3am vibes. Surreal and wobbly.",
    colorScheme: { bg: "#0a100a", accent: "#00cc66", glow: "#00ff88" },
    defaultState: {
      tempo: 105,
      swing: 0.35,
      scale: "dorian",
      rootNote: 45, // A2
      synthMode: "fm" as SynthMode,
      surreal: {
        grotesqueness: 0.2,
        institutionalDecay: 0.15,
        digitalCorruption: 0.12,
        visceralTension: 0.25,
        cosmicDread: 0.3,
      },
      drumTracks: (() => {
        const t = emptyDrumTracks();
        // Tight syncopated funk — 8 steps
        setHit(t, 0, 0, 0.9); setHit(t, 0, 3, 0.6); setHit(t, 0, 5, 0.7);
        setHit(t, 1, 2, 0.8); setHit(t, 1, 6, 0.75);
        setHit(t, 2, 0, 0.5); setHit(t, 2, 1, 0.3); setHit(t, 2, 2, 0.5); setHit(t, 2, 3, 0.3);
        setHit(t, 2, 4, 0.5); setHit(t, 2, 5, 0.3); setHit(t, 2, 6, 0.5); setHit(t, 2, 7, 0.35);
        setHit(t, 3, 4, 0.65, true);
        setHit(t, 5, 3, 0.3); setHit(t, 5, 7, 0.25);
        return t;
      })(),
      melodyTrack: (() => {
        const m = emptyMelodyTrack();
        // Bouncy dorian hook — funky call-and-response, major feel with blue notes
        setNote(m, 0, 57, { velocity: 0.7 });
        setNote(m, 2, 60, { velocity: 0.6 });
        setNote(m, 3, 62, { velocity: 0.55 });
        setNote(m, 4, 64, { velocity: 0.75 });
        setTie(m, 5);
        setNote(m, 6, 62, { velocity: 0.5, slide: true });
        setNote(m, 8, 60, { velocity: 0.7 });
        setNote(m, 10, 57, { velocity: 0.55 });
        setNote(m, 12, 64, { velocity: 0.75 });
        setTie(m, 13);
        setNote(m, 14, 62, { velocity: 0.5, slide: true });
        setNote(m, 15, 60, { velocity: 0.45 });
        return m;
      })(),
    },
  },
  {
    name: "Cathedral of Flesh",
    description: "Vast reverberant space. Organ drones. Something breathing.",
    colorScheme: { bg: "#100808", accent: "#884444", glow: "#cc6666" },
    defaultState: {
      tempo: 56,
      scale: "hungarian_minor",
      rootNote: 36, // C2
      surreal: {
        grotesqueness: 0.12,
        institutionalDecay: 0.08,
        digitalCorruption: 0.0,
        visceralTension: 0.2,
        cosmicDread: 0.45,
      },
      drumTracks: (() => {
        const t = emptyDrumTracks();
        // Sparse ritual pulse
        setHit(t, 0, 0, 1.0, true);
        setHit(t, 4, 0, 0.6); setHit(t, 4, 4, 0.5);
        setHit(t, 5, 3, 0.2); setHit(t, 5, 7, 0.15);
        setHit(t, 6, 0, 0.5);
        return t;
      })(),
      melodyTrack: (() => {
        const m = emptyMelodyTrack();
        // Organ chord progression — open voicings, i → III → VI → VII (resolves upward)
        setChord(m, 0, [36, 43, 48], { velocity: 0.65, slide: true });
        setTie(m, 1);
        setTie(m, 2);
        setTie(m, 3);
        setChord(m, 4, [39, 43, 48], { velocity: 0.6, slide: true });
        setTie(m, 5);
        setTie(m, 6);
        setTie(m, 7);
        setChord(m, 8, [33, 41, 48], { velocity: 0.7, slide: true });
        setTie(m, 9);
        setTie(m, 10);
        setTie(m, 11);
        setChord(m, 12, [35, 43, 47], { velocity: 0.65, slide: true });
        setTie(m, 13);
        setTie(m, 14);
        setTie(m, 15);
        return m;
      })(),
    },
  },
  {
    name: "VHS Purgatory",
    description: "Tape wobble. Tracking errors. Liminal supermarket music.",
    colorScheme: { bg: "#0a0a10", accent: "#4466cc", glow: "#6688ee" },
    defaultState: {
      tempo: 98,
      swing: 0.18,
      scale: "whole_tone",
      rootNote: 50, // D3
      synthMode: "fm" as SynthMode,
      surreal: {
        grotesqueness: 0.1,
        institutionalDecay: 0.25,
        digitalCorruption: 0.15,
        visceralTension: 0.1,
        cosmicDread: 0.3,
      },
      drumTracks: (() => {
        const t = emptyDrumTracks();
        // Stiff drum machine — bossa nova gone wrong
        setHit(t, 0, 0, 0.55); setHit(t, 0, 4, 0.5);
        setHit(t, 1, 2, 0.5); setHit(t, 1, 6, 0.5);
        setHit(t, 2, 0, 0.4); setHit(t, 2, 2, 0.4); setHit(t, 2, 4, 0.4); setHit(t, 2, 6, 0.4);
        setHit(t, 3, 3, 0.3); setHit(t, 3, 7, 0.25);
        setHit(t, 5, 0, 0.2); setHit(t, 5, 4, 0.2);
        return t;
      })(),
      melodyTrack: (() => {
        const m = emptyMelodyTrack();
        // Dreamy whole-tone earworm — catchy ascending hook, elevator music through a broken TV
        setNote(m, 0, 62, { velocity: 0.6 });
        setTie(m, 1);
        setNote(m, 2, 64, { velocity: 0.55 });
        setNote(m, 4, 66, { velocity: 0.65 });
        setTie(m, 5);
        setNote(m, 6, 68, { velocity: 0.55, slide: true });
        setNote(m, 8, 66, { velocity: 0.6 });
        setNote(m, 10, 64, { velocity: 0.5 });
        setNote(m, 12, 62, { velocity: 0.55 });
        setNote(m, 14, 64, { velocity: 0.6, slide: true });
        setNote(m, 15, 66, { velocity: 0.5 });
        return m;
      })(),
    },
  },
];

export function applyPreset(presetName: string): PatternState {
  const preset = PRESETS.find(p => p.name === presetName);
  const base = createDefaultPattern();
  if (!preset) return base;

  return {
    ...base,
    ...preset.defaultState,
    surreal: { ...base.surreal, ...(preset.defaultState.surreal ?? {}) },
    drumTracks: preset.defaultState.drumTracks ?? base.drumTracks,
    melodyTrack: preset.defaultState.melodyTrack ?? base.melodyTrack,
    synthMode: preset.defaultState.synthMode ?? base.synthMode,
  };
}
