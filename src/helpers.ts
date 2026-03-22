import type { ChordType, ArpMode, MelodyStep } from "./types";
import { SCALES, CHORD_INTERVALS } from "./types";
import { emptyMelodyStep } from "./presets";

// Convert MIDI note to frequency
export function midiToFreq(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

// Quantize a note to the current scale
export function quantizeToScale(note: number, rootNote: number, scaleIntervals: number[]): number {
  if (!scaleIntervals || scaleIntervals.length === 0) return note;
  const offset = note - rootNote;
  const octave = Math.floor(offset / 12);
  const degree = ((offset % 12) + 12) % 12;
  let closest = scaleIntervals[0]!;
  for (const interval of scaleIntervals) {
    if (Math.abs(interval - degree) < Math.abs(closest - degree)) {
      closest = interval;
    }
  }
  return rootNote + octave * 12 + closest;
}

// Build a chord from a root note using scale-aware intervals
export function buildChord(root: number, chordType: ChordType, rootNote: number, scaleIntervals: number[]): number[] {
  const intervals = CHORD_INTERVALS[chordType];
  if (!intervals) return [root];
  return intervals.map(interval => {
    const raw = root + interval;
    // Quantize to scale for musical chord voicings
    if (chordType === "cluster") return raw; // clusters are intentionally chromatic
    return quantizeToScale(raw, rootNote, scaleIntervals);
  });
}

// Generate an arpeggio pattern across steps
export function generateArp(
  rootNote: number,
  chordType: ChordType,
  arpMode: ArpMode,
  scale: string,
  scaleRoot: number,
  stepsPerBar: number,
): MelodyStep[] {
  const scaleIntervals = SCALES[scale] ?? SCALES.chromatic!;
  const chordNotes = buildChord(rootNote, chordType, scaleRoot, scaleIntervals);

  // Build the arp sequence based on mode
  let sequence: number[] = [];
  switch (arpMode) {
    case "up":
      // Repeat chord notes ascending across 2 octaves
      for (let oct = 0; oct < 2; oct++) {
        for (const n of chordNotes) sequence.push(n + oct * 12);
      }
      break;
    case "down":
      for (let oct = 1; oct >= 0; oct--) {
        for (let i = chordNotes.length - 1; i >= 0; i--) sequence.push(chordNotes[i]! + oct * 12);
      }
      break;
    case "updown": {
      const up: number[] = [];
      for (let oct = 0; oct < 2; oct++) {
        for (const n of chordNotes) up.push(n + oct * 12);
      }
      sequence = [...up, ...up.slice(1, -1).reverse()];
      break;
    }
    case "random":
      // Random selection from chord tones across 2 octaves
      for (let i = 0; i < stepsPerBar; i++) {
        const oct = Math.floor(Math.random() * 2);
        const note = chordNotes[Math.floor(Math.random() * chordNotes.length)]!;
        sequence.push(note + oct * 12);
      }
      break;
    case "drunk":
      // Drunk walk through scale degrees starting from root
      {
        let current = rootNote;
        for (let i = 0; i < stepsPerBar; i++) {
          sequence.push(current);
          const step = Math.floor(Math.random() * 3) - 1; // -1, 0, or 1
          const currentDeg = scaleIntervals.indexOf(((current - scaleRoot) % 12 + 12) % 12);
          if (currentDeg >= 0) {
            const newDeg = Math.max(0, Math.min(scaleIntervals.length - 1, currentDeg + step));
            const octShift = Math.random() > 0.85 ? (Math.random() > 0.5 ? 12 : -12) : 0;
            current = scaleRoot + Math.floor((current - scaleRoot) / 12) * 12 + scaleIntervals[newDeg]! + octShift;
          }
        }
      }
      break;
  }

  // Map sequence to steps, cycling if needed
  const steps: MelodyStep[] = [];
  for (let i = 0; i < stepsPerBar; i++) {
    const seqNote = sequence[i % sequence.length];
    const isRest = arpMode !== "random" && arpMode !== "drunk" && Math.random() > 0.85; // occasional rests
    if (seqNote !== undefined && !isRest) {
      steps.push({
        active: true,
        notes: [seqNote],
        velocity: 0.5 + Math.random() * 0.3,
        slide: arpMode === "drunk" || (arpMode === "updown" && Math.random() > 0.7),
        tie: false,
      });
    } else {
      steps.push(emptyMelodyStep());
    }
  }
  return steps;
}

// ──────────────────────────────────────────────
// Euclidean rhythm (Bjorklund/Bresenham)
// ──────────────────────────────────────────────
export function euclideanRhythm(hits: number, steps: number): boolean[] {
  if (hits >= steps) return Array(steps).fill(true);
  if (hits <= 0) return Array(steps).fill(false);
  const pattern: boolean[] = [];
  let bucket = 0;
  for (let i = 0; i < steps; i++) {
    bucket += hits;
    if (bucket >= steps) {
      bucket -= steps;
      pattern.push(true);
    } else {
      pattern.push(false);
    }
  }
  return pattern;
}

// Seeded random for deterministic flower shapes
export function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// Generate latent pitches via seeded scale walk
export function generateLatentPitches(seed: number, rootNote: number, scale: string, count: number): number[] {
  const rand = seededRandom(seed);
  const scaleInts = SCALES[scale] ?? SCALES.chromatic!;
  const pitches: number[] = [];
  let current = rootNote;

  for (let i = 0; i < count; i++) {
    const jump = Math.floor(rand() * 3) - 1; // -1, 0, +1 scale degrees
    const noteInOctave = ((current - rootNote) % 12 + 12) % 12;
    const currentDeg = scaleInts.indexOf(noteInOctave);
    if (currentDeg >= 0) {
      let newDeg = currentDeg + jump;
      let octShift = 0;
      if (newDeg >= scaleInts.length) { newDeg -= scaleInts.length; octShift = 12; }
      if (newDeg < 0) { newDeg += scaleInts.length; octShift = -12; }
      current = rootNote + Math.floor((current - rootNote) / 12) * 12 + (scaleInts[newDeg] ?? 0) + octShift;
      current = Math.max(rootNote, Math.min(rootNote + 24, current));
    }
    pitches.push(current);
  }
  return pitches;
}

// Apply Euclidean rhythm + growth to produce melody steps
export function applyEuclideanToPattern(
  rootNote: number,
  scale: string,
  stepsPerBar: number,
  hits: number,
  rotation: number,
  growth: number,
  latentPitches: number[],
): MelodyStep[] {
  const rhythm = euclideanRhythm(hits, stepsPerBar);
  // Apply rotation (shift right)
  const rot = ((rotation % stepsPerBar) + stepsPerBar) % stepsPerBar;
  const rotated = rot > 0
    ? [...rhythm.slice(rhythm.length - rot), ...rhythm.slice(0, rhythm.length - rot)]
    : rhythm;

  const scaleInts = SCALES[scale] ?? SCALES.chromatic!;
  const steps: MelodyStep[] = [];

  // First pass: place spores at Euclidean positions
  for (let i = 0; i < stepsPerBar; i++) {
    if (rotated[i]) {
      steps.push({
        active: true,
        notes: [latentPitches[i] ?? rootNote],
        velocity: 0.7,
        slide: false,
        tie: false,
      });
    } else {
      steps.push({ active: false, notes: [], velocity: 0.5, slide: false, tie: false });
    }
  }

  // Second pass: growth fills gaps between spores
  if (growth > 0) {
    for (let i = 0; i < stepsPerBar; i++) {
      if (steps[i]!.active) continue;

      // Find nearest spore before and after (circular)
      let prevI = -1, nextI = -1;
      for (let j = 1; j < stepsPerBar; j++) {
        const idx = (i - j + stepsPerBar) % stepsPerBar;
        if (steps[idx]!.active) { prevI = idx; break; }
      }
      for (let j = 1; j < stepsPerBar; j++) {
        const idx = (i + j) % stepsPerBar;
        if (steps[idx]!.active) { nextI = idx; break; }
      }
      if (prevI < 0 || nextI < 0) continue;

      const distPrev = (i - prevI + stepsPerBar) % stepsPerBar;
      const distNext = (nextI - i + stepsPerBar) % stepsPerBar;
      const gapSize = distPrev + distNext;
      const minDist = Math.min(distPrev, distNext);
      const maxReach = Math.ceil(growth * gapSize / 2);

      if (minDist <= maxReach) {
        const t = distPrev / gapSize;
        const prevNote = steps[prevI]!.notes[0] ?? rootNote;
        const nextNote = steps[nextI]!.notes[0] ?? rootNote;
        const interpolated = Math.round(prevNote + (nextNote - prevNote) * t);
        const quantized = quantizeToScale(interpolated, rootNote, scaleInts);

        steps[i] = {
          active: true,
          notes: [quantized],
          velocity: 0.3 + growth * 0.15,
          slide: true,
          tie: false,
        };
      }
    }
  }

  return steps;
}

// Pitch class to hue (12-stop color wheel)
const PITCH_HUES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
export function noteToHue(midi: number): number {
  return PITCH_HUES[midi % 12] ?? 0;
}

// Note name helpers
export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function noteName(midi: number): string {
  const name = NOTE_NAMES[midi % 12] ?? "?";
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

export function isBlackKey(midi: number): boolean {
  const n = midi % 12;
  return n === 1 || n === 3 || n === 6 || n === 8 || n === 10;
}
