// ---- Surreal parameter mapping ----
// These "emotional" parameters map to real synth parameters underneath
export interface SurrealParams {
  grotesqueness: number;     // 0-1: distortion + detuning + harmonic complexity
  institutionalDecay: number; // 0-1: lo-fi degradation, filter sweep, bit crush
  digitalCorruption: number;  // 0-1: glitch probability, stutter, pitch randomization
  visceralTension: number;    // 0-1: envelope sharpness, resonance, compression
  cosmicDread: number;        // 0-1: reverb size, delay feedback, pitch shift down
}

export interface DrumStep {
  active: boolean;
  velocity: number; // 0-1
  accent: boolean;
}

export interface MelodyStep {
  active: boolean;
  notes: number[];    // MIDI note numbers (polyphony — multiple notes per step)
  velocity: number;   // 0-1
  slide: boolean;     // glide to next note
  tie: boolean;       // sustain from previous step (don't retrigger)
}

export interface DrumTrack {
  name: string;
  steps: DrumStep[];
  muted: boolean;
  volume: number; // 0-1
}

export interface MelodyTrack {
  steps: MelodyStep[];
  muted: boolean;
  volume: number; // 0-1
  octave: number; // -2 to +2 offset
}

// Melody synthesis models
export type SynthMode = "subtractive" | "fm" | "pluck";

export const SYNTH_MODE_NAMES: Record<SynthMode, string> = {
  subtractive: "Analog",
  fm: "FM",
  pluck: "Pluck",
};

export interface PatternState {
  tempo: number; // BPM
  swing: number; // 0-1
  stepsPerBar: number; // 16
  bars: number; // 1-8
  currentBar: number;
  drumTracks: DrumTrack[];
  melodyTrack: MelodyTrack;
  surreal: SurrealParams;
  masterVolume: number;
  scale: string;   // e.g. "phrygian", "chromatic"
  rootNote: number; // MIDI note for root
  synthMode: SynthMode; // melody synthesis model
  customHue?: number; // 0-360 hue for Blank Canvas color customization
}

export interface PresetDefinition {
  name: string;
  description: string;
  colorScheme: { bg: string; accent: string; glow: string };
  defaultState: Partial<PatternState>;
}

// Drum voice types for synthesis
export type DrumVoice = "kick" | "snare" | "hihat" | "clap" | "tom" | "rim" | "cymbal" | "perc";

export const DRUM_VOICES: { name: string; voice: DrumVoice }[] = [
  { name: "KICK", voice: "kick" },
  { name: "SNARE", voice: "snare" },
  { name: "HAT", voice: "hihat" },
  { name: "CLAP", voice: "clap" },
  { name: "TOM", voice: "tom" },
  { name: "RIM", voice: "rim" },
  { name: "CYM", voice: "cymbal" },
  { name: "PERC", voice: "perc" },
];

export const SCALES: Record<string, number[]> = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  pentatonic_minor: [0, 3, 5, 7, 10],
  whole_tone: [0, 2, 4, 6, 8, 10],
  hungarian_minor: [0, 2, 3, 6, 7, 8, 11],
};

export const SCALE_NAMES: Record<string, string> = {
  chromatic: "Chromatic",
  phrygian: "Phrygian",
  minor: "Natural Minor",
  major: "Major",
  dorian: "Dorian",
  locrian: "Locrian",
  pentatonic_minor: "Pentatonic Minor",
  whole_tone: "Whole Tone",
  hungarian_minor: "Hungarian Minor",
};

// Chord types for the chord generator
export type ChordType = "triad" | "seventh" | "sus2" | "sus4" | "add9" | "power" | "cluster";

export const CHORD_INTERVALS: Record<ChordType, number[]> = {
  triad: [0, 4, 7],         // major triad (will be adjusted to scale)
  seventh: [0, 4, 7, 11],   // major 7th
  sus2: [0, 2, 7],          // suspended 2nd
  sus4: [0, 5, 7],          // suspended 4th
  add9: [0, 4, 7, 14],      // add 9
  power: [0, 7, 12],        // power chord (root + 5th + octave)
  cluster: [0, 1, 2, 3],    // chromatic cluster
};

export const CHORD_NAMES: Record<ChordType, string> = {
  triad: "Triad",
  seventh: "7th",
  sus2: "Sus2",
  sus4: "Sus4",
  add9: "Add9",
  power: "Power",
  cluster: "Cluster",
};

// Arp patterns
export type ArpMode = "up" | "down" | "updown" | "random" | "drunk";

export const ARP_NAMES: Record<ArpMode, string> = {
  up: "Rise",
  down: "Fall",
  updown: "Breathe",
  random: "Chaos",
  drunk: "Wander",
};
