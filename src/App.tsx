import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useRef, useCallback, useEffect, useMemo, memo } from "react";
import { Play, Square, Save, FolderOpen, Trash2, ChevronDown, ChevronUp, Dice5, Volume2, Link, Music, Zap, Flower2, Shuffle, Maximize2, Download, RotateCcw } from "lucide-react";
import { listPatterns, getPattern, savePattern, deletePattern } from "./pattern-store";
import { PRESETS, applyPreset, createDefaultPattern, emptyMelodyStep, hueToColorScheme } from "./presets";
import type { PatternState, DrumStep, SurrealParams, MelodyStep, ChordType, ArpMode, SynthMode } from "./types";
import { recordOneLoop, exportMidi, downloadBlob, loopDurationMs } from "./export-utils";
import { DRUM_VOICES, SCALES, SCALE_NAMES, CHORD_INTERVALS, CHORD_NAMES, ARP_NAMES, SYNTH_MODE_NAMES } from "./types";
import { getPatternFromURL, setPatternToURL, clearPatternURL } from "./url-sharing";
import { engine } from "./audio-context";
import type { AudioEngine } from "./audio-engine";
import { useSequencer } from "./useSequencer";
import {
  midiToFreq, quantizeToScale, buildChord, generateArp,
  NOTE_NAMES, noteName, isBlackKey,
} from "./helpers";



// SVG glow filter — reusable across radial components
function GlowFilter({ id, blur }: { id: string; blur: number }) {
  return (
    <filter id={id} x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation={blur} result="blur" />
      <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
    </filter>
  );
}

// ──────────────────────────────────────────────
// Surreal parameter slider
// ──────────────────────────────────────────────
const SurrealSlider = memo(function SurrealSlider({
  label,
  sublabel,
  value,
  onChange,
  color,
}: {
  label: string;
  sublabel: string;
  value: number;
  onChange: (v: number) => void;
  color: string;
}) {
  const pct = value * 100;
  return (
    <div className="mb-3">
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-xs md:text-sm font-bold tracking-[0.2em] uppercase" style={{ color }}>
          {label}
        </span>
        <span className="text-[10px] md:text-xs text-neutral-500 font-mono">{Math.round(pct)}</span>
      </div>
      <div className="text-[9px] md:text-[11px] text-neutral-600 mb-1 italic">{sublabel}</div>
      <div className="relative h-8 group cursor-default" style={{ touchAction: "none" }}>
        <div className="absolute inset-y-1 inset-x-0 rounded-sm bg-neutral-900 border border-neutral-800" />
        <div
          className="absolute top-1 left-0 rounded-sm transition-all duration-75"
          style={{
            width: `${pct}%`,
            height: "calc(100% - 8px)",
            background: `linear-gradient(90deg, ${color}33, ${color}aa)`,
            boxShadow: `0 0 ${8 + value * 15}px ${color}44`,
          }}
        />
        <input
          type="range"
          min={0}
          max={100}
          value={pct}
          onChange={(e) => onChange(Number(e.target.value) / 100)}
          className="absolute inset-0 w-full h-full opacity-0 cursor-default"
          style={{ touchAction: "none" }}
        />
      </div>
    </div>
  );
});

// ──────────────────────────────────────────────
// Director spectrum slider — bipolar (-1 to +1) with center line
// ──────────────────────────────────────────────
const DIRECTOR_SLIDER_CLASS = `director-slider w-full h-10 cursor-default appearance-none bg-transparent
  [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full
  [&::-webkit-slider-runnable-track]:bg-neutral-800
  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5
  [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:-mt-[7px]`;

const DirectorSlider = memo(function DirectorSlider({
  leftLabel,
  rightLabel,
  value,
  onChange,
  lowText,
  midText,
  highText,
}: {
  leftLabel: string;
  rightLabel: string;
  value: number;
  onChange: (v: number) => void;
  lowText: string;
  midText: string;
  highText: string;
}) {
  return (
    <div>
      <div className="flex justify-between items-baseline mb-2">
        <span className="text-[10px] md:text-xs font-bold tracking-widest uppercase text-neutral-500">{leftLabel}</span>
        <span className="text-[10px] md:text-xs font-bold tracking-widest uppercase text-neutral-500">{rightLabel}</span>
      </div>
      <div className="relative">
        <div className="absolute inset-y-0 left-1/2 w-px bg-neutral-800 -translate-x-px" />
        <input
          type="range"
          min={-100}
          max={100}
          value={value * 100}
          onChange={(e) => onChange(Number(e.target.value) / 100)}
          className={DIRECTOR_SLIDER_CLASS}
        />
      </div>
      <p className="text-[9px] md:text-[11px] text-neutral-700 mt-1 text-center italic">
        {value < -0.3 ? lowText : value > 0.3 ? highText : midText}
      </p>
    </div>
  );
});

// ──────────────────────────────────────────────
// Step button for drum sequencer
// ──────────────────────────────────────────────
const DrumStepButton = memo(function DrumStepButton({
  step,
  isCurrentStep,
  beatGroup,
  trackIdx,
  stepIdx,
  onToggleStep,
  onAccentStep,
  color,
}: {
  step: DrumStep;
  isCurrentStep: boolean;
  beatGroup: number;
  trackIdx: number;
  stepIdx: number;
  onToggleStep: (trackIdx: number, stepIdx: number) => void;
  onAccentStep: (trackIdx: number, stepIdx: number) => void;
  color: string;
}) {
  const bgShade = beatGroup % 2 === 0 ? "bg-neutral-900" : "bg-neutral-800/60";
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    didLongPress.current = false;
    longPressRef.current = setTimeout(() => {
      didLongPress.current = true;
      onAccentStep(trackIdx, stepIdx);
    }, 400);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, [onAccentStep, trackIdx, stepIdx]);

  const handlePointerUp = useCallback(() => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
    if (!didLongPress.current) {
      onToggleStep(trackIdx, stepIdx);
    }
  }, [onToggleStep, trackIdx, stepIdx]);

  const handlePointerCancel = useCallback(() => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  }, []);

  // Clear long-press timer on unmount to prevent stale callback
  useEffect(() => {
    return () => {
      if (longPressRef.current) clearTimeout(longPressRef.current);
    };
  }, []);

  return (
    <button
      type="button"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onDoubleClick={(e) => {
        e.preventDefault();
        onAccentStep(trackIdx, stepIdx);
      }}
      className={`
        w-full h-7 rounded-[3px] border transition-all duration-75 cursor-default select-none
        ${isCurrentStep ? "ring-1 ring-white/40" : ""}
        ${step.active
          ? step.accent
            ? "border-white/60"
            : "border-white/20"
          : `${bgShade} border-neutral-800 hover:border-neutral-700`
        }
      `}
      style={{
        touchAction: "manipulation",
        ...(step.active ? {
          backgroundColor: step.accent ? color : `${color}88`,
          boxShadow: isCurrentStep ? `0 0 8px ${color}` : undefined,
        } : {}),
      }}
    />
  );
});

// ──────────────────────────────────────────────
// Compute a compact per-row fingerprint string for a given note across all steps.
// Only changes when the cells relevant to this noteIndex actually change.
function melodyRowFingerprint(steps: MelodyStep[], noteIndex: number): string {
  let fp = "";
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const hasNote = step.active && step.notes.includes(noteIndex);
    const isTie = step.active && step.tie;
    let tiedNote = false;
    if (isTie && i > 0) {
      for (let j = i - 1; j >= 0; j--) {
        const prev = steps[j]!;
        if (prev.active && !prev.tie) { tiedNote = prev.notes.includes(noteIndex); break; }
        if (!prev.active || !prev.tie) break;
      }
    }
    // encode cell state: N=note, T=tied, E=empty tie, _=empty
    fp += hasNote ? "N" : tiedNote ? "T" : (isTie && step.notes.length === 0) ? "E" : "_";
  }
  return fp;
}

// Melody piano roll row (polyphonic + ties)
// Memoized with a fingerprint prop so rows only re-render when their actual cell states change.
// The current-step highlight is handled by a CSS selector on the parent container.
// ──────────────────────────────────────────────
const MelodyRow = memo(function MelodyRow({
  noteIndex,
  noteName,
  fingerprint: _fp,
  steps,
  onToggle,
  isBlackKey,
  editMode,
}: {
  noteIndex: number;
  noteName: string;
  fingerprint: string;
  steps: MelodyStep[];
  onToggle: (stepIdx: number, noteIndex: number) => void;
  isBlackKey: boolean;
  editMode: "note" | "chord" | "tie";
  chordType: string;
}) {
  return (
    <div className="flex items-center gap-[1px]">
      <div
        className={`w-8 text-[9px] font-mono text-right pr-1 flex-shrink-0 ${
          isBlackKey ? "text-neutral-500" : "text-neutral-400"
        }`}
      >
        {noteName}
      </div>
      {steps.map((step, i) => {
        const hasThisNote = step.active && step.notes.includes(noteIndex);
        const isTie = step.active && step.tie;
        const beatGroup = Math.floor(i / 4);

        // Check if this note is held (tied from a previous step)
        let isTiedNote = false;
        if (isTie && i > 0) {
          for (let j = i - 1; j >= 0; j--) {
            const prev = steps[j];
            if (prev && prev.active && !prev.tie) {
              isTiedNote = prev.notes.includes(noteIndex);
              break;
            }
            if (prev && (!prev.active || !prev.tie)) break;
          }
        }

        return (
          <button
            key={i}
            type="button"
            data-step={i}
            onPointerDown={() => { onToggle(i, noteIndex); }}
            style={{ touchAction: "manipulation" }}
            className={`
              melody-step flex-1 h-4 min-w-0 rounded-[2px] border transition-all duration-75 cursor-default relative
              ${hasThisNote
                ? "bg-cyan-500/80 border-cyan-400/60"
                : isTiedNote
                  ? "bg-cyan-500/30 border-cyan-400/20"
                  : isTie && step.notes.length === 0
                    ? "bg-amber-500/15 border-amber-400/20"
                    : `${beatGroup % 2 === 0 ? "bg-neutral-900" : "bg-neutral-900/60"} border-neutral-800/60 ${isBlackKey ? "hover:bg-neutral-800/40" : "hover:bg-neutral-800/60"}`
              }
            `}
          >
            {isTiedNote && (
              <div className="absolute left-0 top-1/2 -translate-y-1/2 w-full h-[2px] bg-cyan-500/50" />
            )}
          </button>
        );
      })}
    </div>
  );
}, (prev, next) => prev.fingerprint === next.fingerprint && prev.editMode === next.editMode && prev.chordType === next.chordType);

// ──────────────────────────────────────────────
// Waveform visualizer
// ──────────────────────────────────────────────
// Parse hex color to [r, g, b]
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16) || 0,
    parseInt(h.substring(2, 4), 16) || 0,
    parseInt(h.substring(4, 6), 16) || 0,
  ];
}

// Build a 256-entry color LUT: black → accent → glow → white
function buildColorLut(accent: string, glow: string): Uint8Array {
  const lut = new Uint8Array(256 * 3);
  const black: [number, number, number] = [0, 0, 0];
  const accentRgb = hexToRgb(accent);
  const glowRgb = hexToRgb(glow);
  const white: [number, number, number] = [255, 255, 255];

  // 4 stops: black(0) → accent(0.35) → glow(0.7) → white(1.0)
  const stops: { t: number; c: [number, number, number] }[] = [
    { t: 0, c: black },
    { t: 0.35, c: accentRgb },
    { t: 0.7, c: glowRgb },
    { t: 1.0, c: white },
  ];

  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    // Find the two stops we're between
    let lo = stops[0]!;
    let hi = stops[1]!;
    for (let s = 1; s < stops.length; s++) {
      if (stops[s]!.t >= t) { hi = stops[s]!; break; }
      lo = stops[s]!;
    }
    const range = hi.t - lo.t;
    const f = range > 0 ? (t - lo.t) / range : 0;
    lut[i * 3] = Math.round(lo.c[0] + (hi.c[0] - lo.c[0]) * f);
    lut[i * 3 + 1] = Math.round(lo.c[1] + (hi.c[1] - lo.c[1]) * f);
    lut[i * 3 + 2] = Math.round(lo.c[2] + (hi.c[2] - lo.c[2]) * f);
  }
  return lut;
}

const SPEC_HEIGHT = 80;

const Visualizer = memo(function Visualizer({ engine: eng, isPlaying, colorScheme }: { engine: AudioEngine; isPlaying: boolean; colorScheme: { accent: string; glow: string } }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const sizeRef = useRef({ w: 400, h: SPEC_HEIGHT });
  const colorsRef = useRef(colorScheme);
  colorsRef.current = colorScheme;
  // Pre-built color lookup table — rebuilt only when colors change
  const lut = useMemo(() => buildColorLut(colorScheme.accent, colorScheme.glow), [colorScheme.accent, colorScheme.glow]);
  const lutRef = useRef(lut);
  lutRef.current = lut;

  // Scale canvas to actual container width
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = SPEC_HEIGHT;
      sizeRef.current = { w, h };
      // For spectrograph we work at 1:1 pixel ratio (no DPR scaling)
      // to keep the scrolling buffer simple and pixel-crisp
      canvas.width = w;
      canvas.height = h;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    if (!isPlaying) {
      // When stopped, fade the existing spectrograph and draw a dim center line
      const { w, h } = sizeRef.current;
      const imageData = ctx.getImageData(0, 0, w, h);
      // Dim existing content
      for (let i = 3; i < imageData.data.length; i += 4) {
        imageData.data[i] = Math.floor((imageData.data[i] ?? 0) * 0.4);
      }
      ctx.putImageData(imageData, 0, 0);
      // Draw a faint center line — "flatline" idle state
      const accentRgb = hexToRgb(colorsRef.current.accent);
      ctx.strokeStyle = `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, 0.15)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
      return;
    }

    let lastDraw = 0;
    const draw = (now: number) => {
      // Throttle to ~24fps for smooth scrolling without burning CPU
      if (now - lastDraw < 42) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }
      lastDraw = now;

      const { w, h } = sizeRef.current;
      const lut = lutRef.current;
      const freq = eng.getAnalyserData();
      if (freq.length === 0) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      // Shift existing image left by 1 pixel
      const existing = ctx.getImageData(1, 0, w - 1, h);
      ctx.putImageData(existing, 0, 0);

      // Paint new column on the right edge
      // Map frequency bins to canvas height (low freq at bottom, high at top)
      const binCount = freq.length;
      const newCol = ctx.createImageData(1, h);
      for (let y = 0; y < h; y++) {
        // y=0 is top (high freq), y=h-1 is bottom (low freq)
        const freqIdx = Math.floor((1 - y / h) * binCount);
        const val = freq[freqIdx] ?? 0;
        // Apply a slight power curve to boost contrast on quieter signals
        const intensity = Math.floor(Math.pow(val / 255, 0.85) * 255);
        const ci = intensity * 3;
        const pi = y * 4;
        newCol.data[pi] = lut[ci] ?? 0;
        newCol.data[pi + 1] = lut[ci + 1] ?? 0;
        newCol.data[pi + 2] = lut[ci + 2] ?? 0;
        // Alpha: fade very quiet bins to transparent for a cleaner look
        newCol.data[pi + 3] = intensity < 8 ? 0 : Math.min(255, intensity + 60);
      }
      ctx.putImageData(newCol, w - 1, 0);

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [eng, isPlaying]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full rounded-lg"
      style={{ height: SPEC_HEIGHT, imageRendering: "pixelated" }}
    />
  );
});


// Deterministic jitter from indices (no Math.random in render)
function deterministicNoise(a: number, b: number): number {
  return ((Math.sin(a * 12.9898 + b * 78.233) * 43758.5453) % 1 + 1) % 1 - 0.5;
}

// ──────────────────────────────────────────────
// Pond — Concentric layout: Ripple Core + Lily Pads + Melody Ring
// ──────────────────────────────────────────────

// 5 surreal params arranged in a pentagon (starting from top, clockwise)
const RIPPLE_POLES: { key: keyof SurrealParams; label: string; hue: number; angle: number }[] = [
  { key: "grotesqueness", label: "GROTESQUE", hue: 0, angle: -Math.PI / 2 },
  { key: "visceralTension", label: "TENSION", hue: 35, angle: -Math.PI / 2 + (2 * Math.PI) / 5 },
  { key: "digitalCorruption", label: "CORRUPT", hue: 150, angle: -Math.PI / 2 + (4 * Math.PI) / 5 },
  { key: "institutionalDecay", label: "DECAY", hue: 270, angle: -Math.PI / 2 + (6 * Math.PI) / 5 },
  { key: "cosmicDread", label: "DREAD", hue: 220, angle: -Math.PI / 2 + (8 * Math.PI) / 5 },
];

// ──────────────────────────────────────────────
// Ripple Core — organic radar blob for 5 surreal params
// ──────────────────────────────────────────────
const RippleCore = memo(function RippleCore({
  surreal,
  onUpdate,
  isPlaying,
  beatPulse,
  isMobile = false,
}: {
  surreal: SurrealParams;
  onUpdate: (key: keyof SurrealParams, value: number) => void;
  isPlaying: boolean;
  beatPulse: number;
  isMobile?: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<keyof SurrealParams | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  // Visual-only surreal values for blob wobble (LFO-modulated, never saved)
  const [displaySurreal, setDisplaySurreal] = useState<SurrealParams | null>(null);

  const size = 200;
  const cx = size / 2;
  const cy = size / 2;
  const minR = isMobile ? 30 : 22; // minimum blob radius (when param = 0)
  const maxR = isMobile ? 95 : 85; // maximum blob radius (when param = 1)

  // Use LFO-modulated values for visual rendering, fall back to base values
  const visualSurreal = displaySurreal ?? surreal;
  const totalSurreal = (visualSurreal.grotesqueness + visualSurreal.institutionalDecay + visualSurreal.digitalCorruption + visualSurreal.visceralTension + visualSurreal.cosmicDread) / 5;

  // Calculate blob points for each pole
  const blobPoints = useMemo(() => {
    return RIPPLE_POLES.map((pole) => {
      const val = visualSurreal[pole.key];
      const r = minR + val * (maxR - minR);
      // Add organic warping based on value
      const warp = val > 0.1 ? deterministicNoise(pole.hue, 500) * val * 8 : 0;
      const px = cx + Math.cos(pole.angle) * (r + warp);
      const py = cy + Math.sin(pole.angle) * (r + warp);
      return { ...pole, val, r, x: px, y: py };
    });
  }, [visualSurreal]);

  // Build smooth closed blob path using cubic beziers
  const blobPath = useMemo(() => {
    const pts = blobPoints;
    const n = pts.length;
    if (n < 3) return "";
    // Smooth closed shape: for each point, use the midpoints to neighbors as control points
    let d = "";
    for (let i = 0; i < n; i++) {
      const curr = pts[i]!;
      const next = pts[(i + 1) % n]!;
      const prev = pts[(i - 1 + n) % n]!;
      const nextNext = pts[(i + 2) % n]!;
      // Catmull-Rom to cubic bezier conversion
      const tension = 0.35;
      const cp1x = curr.x + (next.x - prev.x) * tension;
      const cp1y = curr.y + (next.y - prev.y) * tension;
      const cp2x = next.x - (nextNext.x - curr.x) * tension;
      const cp2y = next.y - (nextNext.y - curr.y) * tension;
      if (i === 0) d += `M ${curr.x} ${curr.y} `;
      d += `C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${next.x} ${next.y} `;
    }
    d += "Z";
    return d;
  }, [blobPoints]);

  // Concentric ripple rings (water effect)
  const rippleRings = useMemo(() => {
    const rings: { r: number; opacity: number }[] = [];
    for (let i = 1; i <= 4; i++) {
      rings.push({ r: maxR + i * 12, opacity: 0.08 - i * 0.015 });
    }
    return rings;
  }, []);

  // Drag: find which sector, map radial distance to value
  const getSectorAndValue = useCallback((clientX: number, clientY: number) => {
    if (!svgRef.current) return null;
    const rect = svgRef.current.getBoundingClientRect();
    const mx = ((clientX - rect.left) / rect.width) * size;
    const my = ((clientY - rect.top) / rect.height) * size;
    const dx = mx - cx;
    const dy = my - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);

    // Find nearest pole by angle
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < RIPPLE_POLES.length; i++) {
      const pole = RIPPLE_POLES[i]!;
      let diff = Math.abs(angle - pole.angle);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    const pole = RIPPLE_POLES[bestIdx]!;
    const val = Math.max(0, Math.min(1, (dist - minR) / (maxR - minR)));
    return { key: pole.key, idx: bestIdx, val };
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const result = getSectorAndValue(e.clientX, e.clientY);
    if (!result) return;
    setDragging(result.key);
    onUpdate(result.key, result.val);
    (e.target as Element).setPointerCapture(e.pointerId);
  }, [getSectorAndValue, onUpdate]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) {
      // Hover detection
      const result = getSectorAndValue(e.clientX, e.clientY);
      if (result) setHovered(result.idx);
      return;
    }
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * size;
    const my = ((e.clientY - rect.top) / rect.height) * size;
    const dx = mx - cx;
    const dy = my - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const val = Math.max(0, Math.min(1, (dist - minR) / (maxR - minR)));
    onUpdate(dragging, val);
  }, [dragging, onUpdate, getSectorAndValue]);

  const handlePointerUp = useCallback(() => setDragging(null), []);

  // Dominant hue for the blob fill (weighted average of active param hues)
  const blobFill = useMemo(() => {
    let totalWeight = 0;
    let hueX = 0, hueY = 0;
    for (const pole of RIPPLE_POLES) {
      const val = visualSurreal[pole.key];
      const w = val * val; // square for emphasis
      hueX += Math.cos((pole.hue / 180) * Math.PI) * w;
      hueY += Math.sin((pole.hue / 180) * Math.PI) * w;
      totalWeight += w;
    }
    if (totalWeight < 0.01) return { hue: 200, sat: 15, light: 12 };
    const avgHue = ((Math.atan2(hueY, hueX) * 180) / Math.PI + 360) % 360;
    return { hue: avgHue, sat: 20 + totalSurreal * 50, light: 8 + totalSurreal * 18 };
  }, [visualSurreal, totalSurreal]);

  const pulseScale = isPlaying && beatPulse > 0.5 ? 1 + (beatPulse - 0.5) * 0.06 * totalSurreal : 1;

  // LFO modulates surreal params directly on the audio engine — bypasses React state
  // Only updates React state at a low rate for visual feedback
  const baseValuesRef = useRef<Record<string, number>>({});
  const lfoFromDragRef = useRef(false);
  // Snapshot base values when surreal params change externally (randomize, preset load)
  // or when user stops dragging
  useEffect(() => {
    if (!dragging) {
      for (const pole of RIPPLE_POLES) {
        baseValuesRef.current[pole.key] = surreal[pole.key];
      }
      lfoFromDragRef.current = false;
    } else {
      lfoFromDragRef.current = true;
    }
  }, [dragging, surreal]);

  // Store surreal ref so the animation loop always uses the latest
  const surrealRef = useRef(surreal);
  surrealRef.current = surreal;

  useEffect(() => {
    // Only run LFO when playing and not dragging
    if (!isPlaying || dragging) return;

    let raf: number;
    const start = performance.now();
    const LFO_DEPTH = 0.05; // ±5%
    let initialized = false;
    let lastVisualUpdate = 0;
    let lastEngineUpdate = 0;

    const tick = () => {
      if (!initialized) {
        initialized = true;
        for (const pole of RIPPLE_POLES) {
          baseValuesRef.current[pole.key] = surrealRef.current[pole.key];
        }
      }

      const now = performance.now();
      const t = (now - start) / 1000;

      // Compute LFO values — default missing keys to 0 to avoid NaN in audio params
      const lfoValues: Record<string, number> = {};
      for (let i = 0; i < RIPPLE_POLES.length; i++) {
        const pole = RIPPLE_POLES[i]!;
        const base = baseValuesRef.current[pole.key] ?? 0;
        const lfoVal = Math.sin(t * (0.035 + i * 0.006) * Math.PI * 2) * LFO_DEPTH;
        lfoValues[pole.key] = Math.max(0, Math.min(1, base + lfoVal));
      }
      // Update audio engine ~15x/sec (setTargetAtTime interpolates the rest)
      if (engine.isReady && now - lastEngineUpdate > 66) {
        lastEngineUpdate = now;
        engine.updateSurrealParams(lfoValues as unknown as SurrealParams);
      }
      // Update visual-only state ~4x/sec for blob wobble (does NOT touch pattern state)
      if (now - lastVisualUpdate > 250) {
        lastVisualUpdate = now;
        setDisplaySurreal(lfoValues as unknown as SurrealParams);
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      setDisplaySurreal(null); // revert blob to user's base values
    };
  }, [isPlaying, dragging]);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${size} ${size}`}
      className="w-full h-full"
      style={{ touchAction: "none" }}
    >
      <defs>
        <GlowFilter id="rippleGlow" blur={6} />
        <radialGradient id="waterGrad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={`hsl(${blobFill.hue}, ${blobFill.sat}%, ${blobFill.light + 5}%)`} />
          <stop offset="60%" stopColor={`hsl(${blobFill.hue}, ${blobFill.sat * 0.5}%, ${blobFill.light}%)`} />
          <stop offset="100%" stopColor="transparent" />
        </radialGradient>
        <radialGradient id="blobGrad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={`hsl(${blobFill.hue}, ${blobFill.sat + 10}%, ${blobFill.light + 15}%)`} />
          <stop offset="70%" stopColor={`hsl(${blobFill.hue}, ${blobFill.sat}%, ${blobFill.light + 5}%)`} />
          <stop offset="100%" stopColor={`hsl(${blobFill.hue}, ${blobFill.sat * 0.7}%, ${blobFill.light}%)`} />
        </radialGradient>
      </defs>

      {/* Water ripple rings */}
      {rippleRings.map((ring, i) => (
        <circle key={`ring-${i}`} cx={cx} cy={cy} r={ring.r}
          fill="none" stroke={`hsl(${blobFill.hue}, 30%, 40%)`}
          strokeWidth="0.5" opacity={ring.opacity} />
      ))}

      {/* Ambient water glow */}
      <circle cx={cx} cy={cy} r={maxR + 15} fill="url(#waterGrad)" opacity={0.3 + totalSurreal * 0.3} />

      {/* Beat pulse ring */}
      {isPlaying && beatPulse > 0.5 && (
        <circle cx={cx} cy={cy} r={maxR * pulseScale + 5}
          fill="none" stroke={`hsl(${blobFill.hue}, 60%, 50%)`}
          strokeWidth="1.5" opacity={(beatPulse - 0.5) * 0.5 * totalSurreal}
          filter="url(#rippleGlow)" />
      )}

      {/* The blob — organic radar shape */}
      <g transform={`translate(${cx * (1 - pulseScale)}, ${cy * (1 - pulseScale)}) scale(${pulseScale})`}>
        {/* Blob shadow */}
        <path d={blobPath} fill="black" opacity={0.15} transform="translate(1.5, 1.5)" />
        {/* Blob fill */}
        <path d={blobPath} fill="url(#blobGrad)" stroke={`hsl(${blobFill.hue}, ${blobFill.sat + 20}%, ${blobFill.light + 25}%)`}
          strokeWidth="1.5" opacity={0.85} />
        {/* Inner glow */}
        <path d={blobPath} fill={`hsl(${blobFill.hue}, ${blobFill.sat + 30}%, ${blobFill.light + 30}%)`}
          opacity={0.15} filter="url(#rippleGlow)" />
      </g>

      {/* Axis lines + labels + drag targets */}
      {blobPoints.map((bp, i) => {
        const isHov = hovered === i;
        const isDrag = dragging === bp.key;
        const axisEndX = cx + Math.cos(bp.angle) * (maxR + 3);
        const axisEndY = cy + Math.sin(bp.angle) * (maxR + 3);
        const glowColor = `hsl(${bp.hue}, 80%, 55%)`;

        return (
          <g key={bp.key}>
            {/* Subtle axis line */}
            <line x1={cx} y1={cy} x2={axisEndX} y2={axisEndY}
              stroke={isDrag ? glowColor : `hsl(${bp.hue}, 25%, 25%)`}
              strokeWidth={isDrag ? 1.2 : 0.5}
              opacity={isDrag ? 0.7 : isHov ? 0.4 : 0.15}
              strokeDasharray={isDrag ? "none" : "2 3"} />

            {/* Invisible fat hit area from center outward */}
            <line x1={cx} y1={cy}
              x2={cx + Math.cos(bp.angle) * (maxR + 10)}
              y2={cy + Math.sin(bp.angle) * (maxR + 10)}
              stroke="transparent" strokeWidth={20}
              style={{ pointerEvents: "all", touchAction: "none" }}
              className="cursor-default"
              role="slider" aria-label={bp.key} aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={Math.round(bp.val * 100)}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp} />

            {/* Draggable handle on the blob edge */}
            <circle
              cx={bp.x} cy={bp.y}
              r={isDrag ? 10 : isHov ? 8 : 6}
              fill={`hsl(${bp.hue}, ${40 + bp.val * 40}%, ${30 + bp.val * 25}%)`}
              stroke={isDrag ? "white" : isHov ? glowColor : `hsl(${bp.hue}, 35%, 45%)`}
              strokeWidth={isDrag ? 2 : 1}
              opacity={isDrag ? 1 : isHov ? 0.9 : 0.7}
              filter={isDrag ? "url(#rippleGlow)" : undefined}
              className="cursor-grab"
              style={{ cursor: isDrag ? "grabbing" : "grab", pointerEvents: "all", touchAction: "none" }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
            />

            {/* Value tooltip on drag/hover only */}
            {(isDrag || isHov) && (
              <text
                x={bp.x} y={bp.y - (isDrag ? 14 : 12)}
                textAnchor="middle" dominantBaseline="middle"
                fill={glowColor}
                fontSize="7"
                fontFamily="monospace" fontWeight="bold"
              >
                {bp.label} {Math.round(bp.val * 100)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
});

// ──────────────────────────────────────────────
// Compact Lily Pad — drum pattern indicator for pond view
// ──────────────────────────────────────────────
const LilyPad = memo(function LilyPad({
  steps,
  currentStep,
  isPlaying,
  color,
  voiceName,
  trackIdx,
  muted,
  onToggleStep,
  onToggleMute,
}: {
  steps: DrumStep[];
  currentStep: number;
  isPlaying: boolean;
  color: string;
  voiceName: string;
  trackIdx: number;
  muted: boolean;
  onToggleStep: (trackIdx: number, stepIdx: number) => void;
  onToggleMute: (trackIdx: number) => void;
}) {
  const svgSize = 80;
  const cx = svgSize / 2;
  const cy = svgSize / 2;
  const stepR = 28; // radius where step dots sit
  const dotR = 4; // each step dot radius (visible)
  const hitR = 10; // hit area radius — big enough for touch
  const padR = 18; // inner lily pad circle

  return (
    <div
      className="cursor-default select-none"
      style={{ opacity: muted ? 0.3 : 1, transition: "opacity 150ms" }}
    >
      <svg viewBox={`0 0 ${svgSize} ${svgSize}`} className="w-full h-full" style={{ touchAction: "none" }}
        role="group" aria-label={`${voiceName} drum pattern`}>
        <defs>
          <GlowFilter id={`lilyGlow-${trackIdx}`} blur={3} />
        </defs>

        {/* Lily pad base — the "leaf" */}
        <circle cx={cx} cy={cy} r={padR}
          fill={`${color}15`} stroke={`${color}40`} strokeWidth="1"
          className="cursor-default"
          role="button" aria-label={`${muted ? "Unmute" : "Mute"} ${voiceName}`}
          onClick={(e) => { e.stopPropagation(); onToggleMute(trackIdx); }}
        />

        {/* Voice name in center */}
        <text x={cx} y={cy - 1} textAnchor="middle" dominantBaseline="middle"
          fill={color} fontSize="7" fontFamily="monospace" fontWeight="bold" opacity={0.7}
          className="cursor-default pointer-events-none">
          {voiceName}
        </text>

        {/* Mute indicator (visual only — center pad toggles mute) */}
        {muted && (
          <text x={cx} y={cy + 9} textAnchor="middle" dominantBaseline="middle"
            fill="#999" fontSize="5" fontFamily="monospace" className="pointer-events-none" opacity={0.7}>
            MUTED
          </text>
        )}

        {/* Step dots around the rim */}
        {steps.map((step, i) => {
          const angle = (i / steps.length) * Math.PI * 2 - Math.PI / 2;
          const sx = cx + Math.cos(angle) * stepR;
          const sy = cy + Math.sin(angle) * stepR;
          const isCurrent = isPlaying && (currentStep % steps.length) === i;

          return (
            <g key={i}>
              {/* Hit area — large for reliable touch */}
              <circle cx={sx} cy={sy} r={hitR}
                fill="transparent" className="cursor-default"
                role="checkbox" aria-checked={step.active} aria-label={`${voiceName} step ${i + 1}`}
                onClick={(e) => { e.stopPropagation(); onToggleStep(trackIdx, i); }} />
              {/* Step dot — always outlined, filled when active */}
              <circle
                cx={sx} cy={sy}
                r={isCurrent ? dotR + 1.5 : dotR}
                fill={step.active ? (isCurrent ? "white" : color) : "transparent"}
                stroke={isCurrent && step.active ? "white" : color}
                strokeWidth={step.active ? 1.2 : 0.8}
                opacity={step.active ? (step.accent ? 1 : 0.8) : 0.4}
                filter={isCurrent && step.active ? `url(#lilyGlow-${trackIdx})` : undefined}
                className="pointer-events-none"
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
});

// Continuous hue mapping for radial views: smooth rainbow across the pitch range
function radialNoteToHue(note: number, rootNote: number, pitchRange = 24): number {
  return ((note - rootNote) / pitchRange) * 280 + 120;
}

// ──────────────────────────────────────────────
// Melody Ring — outer ring of spores for pond view
// ──────────────────────────────────────────────
const MelodyRing = memo(function MelodyRing({
  steps,
  currentStep,
  isPlaying,
  surreal,
  colorScheme,
  rootNote,
  scale,
  onDragPitch,
  onToggleStep,
  onTapRing,
  viewSize,
  isMobile = false,
}: {
  steps: MelodyStep[];
  currentStep: number;
  isPlaying: boolean;
  surreal: SurrealParams;
  colorScheme: { bg: string; accent: string; glow: string };
  rootNote: number;
  scale: string;
  onDragPitch: (stepIdx: number, note: number) => void;
  onToggleStep: (stepIdx: number) => void;
  onTapRing: () => void;
  viewSize: number;
  isMobile?: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [hoveredSpore, setHoveredSpore] = useState<number | null>(null);

  const cx = viewSize / 2;
  const cy = viewSize / 2;
  // Melody ring sits in its own outer ring, outside lily pads
  // Pulled in from 0.47 to 0.44 so spores + glow don't clip the container edge
  const ringR = viewSize * 0.44;
  // Pitch mapped to subtle radial offset — small range so nodes stay on the ring
  const pitchRange = 24; // 2 octaves
  const pitchOffset = viewSize * 0.025; // max inward/outward displacement (tight)

  const scaleIntervals = SCALES[scale] ?? SCALES.chromatic!;

  const stepAngle = useCallback((i: number) => {
    return (i / steps.length) * Math.PI * 2 - Math.PI / 2;
  }, [steps.length]);

  const didDragRef = useRef(false);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const DRAG_THRESHOLD = 5; // pixels before a tap becomes a drag

  // Handle drag for pitch adjustment (active steps only)
  const handlePointerDown = useCallback((e: React.PointerEvent, stepIdx: number) => {
    if (!steps[stepIdx]?.active) return;
    didDragRef.current = false;
    setDragging(stepIdx);
    pointerStartRef.current = { x: e.clientX, y: e.clientY };
    (e.target as Element).setPointerCapture(e.pointerId);
  }, [steps]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (dragging === null || !svgRef.current) return;
    // Check if we've moved past the drag threshold
    if (!didDragRef.current && pointerStartRef.current) {
      const dx = e.clientX - pointerStartRef.current.x;
      const dy = e.clientY - pointerStartRef.current.y;
      if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      didDragRef.current = true;
    }
    const rect = svgRef.current.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * viewSize;
    const my = ((e.clientY - rect.top) / rect.height) * viewSize;
    const dx = mx - cx;
    const dy = my - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Map distance from center to pitch: closer = lower, farther = higher
    const normalizedDist = (dist - (ringR - pitchOffset)) / (pitchOffset * 2);
    const pitchVal = Math.max(0, Math.min(1, normalizedDist));
    const rawNote = rootNote + Math.round(pitchVal * pitchRange);
    const note = quantizeToScale(rawNote, rootNote, scaleIntervals);
    onDragPitch(dragging, note);
  }, [dragging, cx, cy, ringR, pitchOffset, rootNote, pitchRange, scaleIntervals, onDragPitch, viewSize]);

  const handlePointerUp = useCallback(() => { setDragging(null); }, []);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${viewSize} ${viewSize}`}
      className="absolute inset-0 w-full h-full"
      style={{ pointerEvents: "none", overflow: "visible", touchAction: "none" }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <defs>
        <GlowFilter id="sporeGlow" blur={3} />
      </defs>

      {/* Melody ring track — visible lane (tap to expand editor) */}
      <circle cx={cx} cy={cy} r={ringR}
        fill="none" stroke="hsl(200, 20%, 18%)" strokeWidth="12" opacity={0.01}
        style={{ pointerEvents: "all" }} className="cursor-default"
        onClick={onTapRing} />
      <circle cx={cx} cy={cy} r={ringR}
        fill="none" stroke="hsl(200, 20%, 18%)" strokeWidth="1" opacity={0.5}
        style={{ pointerEvents: "none" }} />
      <circle cx={cx} cy={cy} r={ringR - pitchOffset}
        fill="none" stroke="hsl(200, 15%, 14%)" strokeWidth="0.5" opacity={0.25}
        strokeDasharray="3 4" />
      <circle cx={cx} cy={cy} r={ringR + pitchOffset}
        fill="none" stroke="hsl(200, 15%, 14%)" strokeWidth="0.5" opacity={0.25}
        strokeDasharray="3 4" />

      {/* Tendrils connecting consecutive active steps */}
      {steps.map((step, i) => {
        if (!step.active) return null;
        const nextIdx = (i + 1) % steps.length;
        const nextStep = steps[nextIdx];
        if (!nextStep?.active) return null;

        const a1 = stepAngle(i);
        const a2 = stepAngle(nextIdx);
        const note1 = step.notes[0] ?? rootNote;
        const note2 = nextStep.notes[0] ?? rootNote;
        const r1 = ringR + ((note1 - rootNote) / pitchRange - 0.5) * pitchOffset * 2;
        const r2 = ringR + ((note2 - rootNote) / pitchRange - 0.5) * pitchOffset * 2;
        const x1 = cx + Math.cos(a1) * r1;
        const y1 = cy + Math.sin(a1) * r1;
        const x2 = cx + Math.cos(a2) * r2;
        const y2 = cy + Math.sin(a2) * r2;

        // Control point warped by surreal params
        // Handle wrap-around (step 15→0) so the arc doesn't stretch across the circle
        let angleDiff = a2 - a1;
        if (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        const midA = a1 + angleDiff / 2;
        const warpR = (r1 + r2) / 2 + surreal.cosmicDread * 8 - surreal.visceralTension * 5;
        const cpx = cx + Math.cos(midA) * warpR + deterministicNoise(i, 600) * surreal.digitalCorruption * 6;
        const cpy = cy + Math.sin(midA) * warpR + deterministicNoise(i, 601) * surreal.grotesqueness * 4;

        const hue = radialNoteToHue((note1 + note2) / 2, rootNote);
        return (
          <path key={`tendril-${i}`}
            d={`M ${x1} ${y1} Q ${cpx} ${cpy} ${x2} ${y2}`}
            fill="none" stroke={`hsl(${hue}, 50%, 35%)`}
            strokeWidth={step.slide ? 2 : 1}
            opacity={0.4 + surreal.visceralTension * 0.3} />
        );
      })}

      {/* Spore nodes */}
      {steps.map((step, i) => {
        const angle = stepAngle(i);
        const note = step.notes[0] ?? rootNote;
        const pitchNorm = (note - rootNote) / pitchRange;
        const r = ringR + (pitchNorm - 0.5) * pitchOffset * 2;
        const sx = cx + Math.cos(angle) * r;
        const sy = cy + Math.sin(angle) * r;
        const isCurrent = isPlaying && i === currentStep;
        const isHov = hoveredSpore === i;
        const isDrag = dragging === i;
        const hue = radialNoteToHue(note, rootNote);

        const baseR = step.active ? (step.velocity >= 0.5 ? (isMobile ? 7 : 5) : (isMobile ? 5 : 3.5)) : (isMobile ? 3 : 2);
        const displayR = isDrag ? baseR + 3 : isHov ? baseR + 2 : isCurrent && step.active ? baseR + 1.5 : baseR;
        const hitAreaR = isMobile ? 16 : 12;

        return (
          <g key={`spore-${i}`}>
            {/* Invisible hit area — click to toggle, drag to pitch-shift */}
            <circle cx={sx} cy={sy} r={hitAreaR}
              fill="transparent"
              style={{ pointerEvents: "all", touchAction: "none" }}
              className="cursor-default"
              onClick={() => { if (!steps[i]?.active || !didDragRef.current) onToggleStep(i); }}
              onPointerDown={(e) => handlePointerDown(e, i)}
              onPointerEnter={() => setHoveredSpore(i)}
              onPointerLeave={() => setHoveredSpore(null)} />
            {/* Node visual — always outlined, filled when active */}
            <circle cx={sx} cy={sy} r={isDrag ? baseR + 3 : isHov ? baseR + 2 : baseR}
              fill={step.active
                ? (isCurrent ? "white" : `hsl(${hue}, 60%, ${40 + step.velocity * 25}%)`)
                : "transparent"}
              stroke={step.active
                ? (isDrag ? "white" : isCurrent ? "white" : `hsl(${hue}, 50%, 50%)`)
                : `hsl(${hue}, 30%, 35%)`}
              strokeWidth={step.active ? 1 : 0.7}
              opacity={step.active ? (isDrag || isCurrent ? 1 : 0.8) : 0.4}
              filter={isCurrent && step.active ? "url(#sporeGlow)" : undefined}
              style={{ transition: "r 80ms" }} />
            {/* Step number on hover/drag */}
            {(isHov || isDrag) && (
              <text x={sx} y={sy - displayR - 5}
                textAnchor="middle" fill={`hsl(${hue}, 50%, 65%)`}
                fontSize="6" fontFamily="monospace">
                {i + 1}{step.active ? `:${noteName(note)}` : ""}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
});

// ──────────────────────────────────────────────
// Melody Flower — circular 16-step melody editor (expanded view)
// ──────────────────────────────────────────────
const MelodyFlower = memo(function MelodyFlower({
  steps,
  currentStep,
  isPlaying,
  colorScheme,
  rootNote,
  scale,
  onToggleStep,
  onDragPitch,
  onToggleMute,
  muted,
  isMobile = false,
}: {
  steps: MelodyStep[];
  currentStep: number;
  isPlaying: boolean;
  colorScheme: { bg: string; accent: string; glow: string };
  rootNote: number;
  scale: string;
  onToggleStep: (stepIdx: number) => void;
  onDragPitch: (stepIdx: number, note: number) => void;
  onToggleMute: () => void;
  muted: boolean;
  isMobile?: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [hoveredStep, setHoveredStep] = useState<number | null>(null);

  const size = 220;
  const cx = size / 2;
  const cy = size / 2;
  const ringR = size * 0.36; // ring where step dots sit
  const innerR = size * 0.15; // center circle
  const dotBaseR = isMobile ? 8 : 6;
  const pitchRange = 24;

  const didDragRef = useRef(false);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const DRAG_THRESHOLD = 5;

  const handlePointerDown = useCallback((e: React.PointerEvent, stepIdx: number) => {
    if (!steps[stepIdx]?.active) return;
    didDragRef.current = false;
    pointerStartRef.current = { x: e.clientX, y: e.clientY };
    setDragging(stepIdx);
    (e.target as Element).setPointerCapture(e.pointerId);
  }, [steps]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (dragging === null || !svgRef.current) return;
    // Check drag threshold before committing to drag
    if (!didDragRef.current && pointerStartRef.current) {
      const dx = e.clientX - pointerStartRef.current.x;
      const dy = e.clientY - pointerStartRef.current.y;
      if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      didDragRef.current = true;
    }
    const rect = svgRef.current.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * size;
    const my = ((e.clientY - rect.top) / rect.height) * size;
    const dist = Math.sqrt((mx - cx) ** 2 + (my - cy) ** 2);
    // Map radial distance to pitch: closer to center = lower, farther = higher
    const normalizedDist = (dist - innerR) / (ringR * 1.6 - innerR);
    const pitchVal = Math.max(0, Math.min(1, normalizedDist));
    const rawNote = rootNote + Math.round(pitchVal * pitchRange);
    const scaleIntervals = SCALES[scale] ?? SCALES.chromatic!;
    const note = quantizeToScale(rawNote, rootNote, scaleIntervals);
    onDragPitch(dragging, note);
  }, [dragging, cx, cy, innerR, ringR, rootNote, scale, onDragPitch]);

  const handlePointerUp = useCallback(() => { setDragging(null); }, []);

  const playheadAngle = currentStep >= 0
    ? (currentStep / steps.length) * 360 - 90
    : -90;

  return (
    <div className={`flex flex-col items-center ${muted ? "opacity-30" : ""}`}>
      <button
        type="button"
        onClick={onToggleMute}
        className="text-[9px] font-bold tracking-wider uppercase cursor-default mb-1 transition-colors"
        style={{ color: muted ? "#555" : colorScheme.accent }}
      >
        MELODY {muted ? "(MUTED)" : ""}
      </button>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${size} ${size}`}
        className="w-full aspect-square"
        style={{ touchAction: "none" }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        <defs>
          <GlowFilter id="melFlowerGlow" blur={2} />
        </defs>

        {/* Ring track */}
        <circle cx={cx} cy={cy} r={ringR}
          fill="none" stroke={`${colorScheme.accent}20`} strokeWidth="1" />

        {/* Beat marker dots (clock face) */}
        {steps.map((_, i) => {
          const angle = (i / steps.length) * Math.PI * 2 - Math.PI / 2;
          const dotR = ringR + 12;
          const dx = cx + Math.cos(angle) * dotR;
          const dy = cy + Math.sin(angle) * dotR;
          const isBeat = i % 4 === 0;
          return (
            <circle
              key={`tick-${i}`}
              cx={dx} cy={dy}
              r={isBeat ? 2 : 1}
              fill={i === currentStep && isPlaying ? colorScheme.accent : isBeat ? "#555" : "#333"}
              opacity={i === currentStep && isPlaying ? 1 : 0.5}
            />
          );
        })}

        {/* Step nodes on the ring */}
        {steps.map((step, i) => {
          const angle = (i / steps.length) * Math.PI * 2 - Math.PI / 2;
          const note = step.notes[0] ?? rootNote;
          const pitchNorm = step.active ? (note - rootNote) / pitchRange : 0.5;
          // Active notes offset radially by pitch
          const r = step.active ? ringR + (pitchNorm - 0.5) * ringR * 0.4 : ringR;
          const sx = cx + Math.cos(angle) * r;
          const sy = cy + Math.sin(angle) * r;
          const isCurrent = isPlaying && i === currentStep;
          const isHov = hoveredStep === i;
          const isDrag = dragging === i;
          const hue = step.active ? radialNoteToHue(note, rootNote) : 200;

          const nodeR = isDrag ? dotBaseR + 4 : isHov ? dotBaseR + 2 : isCurrent && step.active ? dotBaseR + 1 : dotBaseR;

          return (
            <g key={`mel-${i}`}>
              {/* Hit area */}
              <circle cx={sx} cy={sy} r={isMobile ? 18 : 14}
                fill="transparent"
                className="cursor-default"
                style={{ touchAction: "none" }}
                onClick={() => { if (!steps[i]?.active || !didDragRef.current) onToggleStep(i); }}
                onPointerDown={(e) => handlePointerDown(e, i)}
                onPointerEnter={() => setHoveredStep(i)}
                onPointerLeave={() => setHoveredStep(null)} />
              {/* Node — outlined always, filled when active */}
              <circle cx={sx} cy={sy} r={nodeR}
                fill={step.active
                  ? (isCurrent ? "white" : step.tie ? `hsl(${hue}, 30%, 30%)` : `hsl(${hue}, 55%, ${35 + step.velocity * 25}%)`)
                  : (isHov ? `${colorScheme.accent}15` : "transparent")}
                stroke={step.active
                  ? (isDrag || isCurrent ? "white" : `hsl(${hue}, 50%, 50%)`)
                  : (isHov ? `${colorScheme.accent}88` : `${colorScheme.accent}35`)}
                strokeWidth={step.active ? 1.2 : 0.7}
                opacity={step.active ? (isDrag || isCurrent ? 1 : 0.85) : (isHov ? 0.7 : 0.35)}
                filter={isCurrent && step.active ? "url(#melFlowerGlow)" : undefined}
                style={{ transition: "r 80ms" }}
              />
              {/* Tie indicator — dashed arc to next step */}
              {step.tie && (
                <text x={sx} y={sy} textAnchor="middle" dominantBaseline="middle"
                  fill={`hsl(${hue}, 40%, 55%)`} fontSize="7" fontFamily="monospace" className="pointer-events-none">
                  ~
                </text>
              )}
              {/* Note name on hover/active */}
              {(isHov || isDrag) && step.active && !step.tie && (
                <text x={sx} y={sy - nodeR - 5}
                  textAnchor="middle" fill={`hsl(${hue}, 50%, 65%)`}
                  fontSize="7" fontFamily="monospace" className="pointer-events-none">
                  {noteName(note)}
                </text>
              )}
              {/* Step number for inactive on hover */}
              {isHov && !step.active && (
                <text x={sx} y={sy - nodeR - 4}
                  textAnchor="middle" fill="#666"
                  fontSize="6" fontFamily="monospace" className="pointer-events-none">
                  {i + 1}
                </text>
              )}
              {/* Chord indicator — small dots for extra notes */}
              {step.active && !step.tie && step.notes.length > 1 && (
                <text x={sx} y={sy + nodeR + 7}
                  textAnchor="middle" fill={`hsl(${hue}, 40%, 50%)`}
                  fontSize="5" fontFamily="monospace" className="pointer-events-none">
                  {step.notes.length}
                </text>
              )}
            </g>
          );
        })}

        {/* Connections between consecutive active steps */}
        {steps.map((step, i) => {
          if (!step.active) return null;
          const nextIdx = (i + 1) % steps.length;
          const nextStep = steps[nextIdx];
          if (!nextStep?.active) return null;

          const a1 = (i / steps.length) * Math.PI * 2 - Math.PI / 2;
          const a2 = (nextIdx / steps.length) * Math.PI * 2 - Math.PI / 2;
          const note1 = step.notes[0] ?? rootNote;
          const note2 = nextStep.notes[0] ?? rootNote;
          const r1 = ringR + ((note1 - rootNote) / pitchRange - 0.5) * ringR * 0.4;
          const r2 = ringR + ((note2 - rootNote) / pitchRange - 0.5) * ringR * 0.4;
          const x1 = cx + Math.cos(a1) * r1;
          const y1 = cy + Math.sin(a1) * r1;
          const x2 = cx + Math.cos(a2) * r2;
          const y2 = cy + Math.sin(a2) * r2;
          const hue = radialNoteToHue((note1 + note2) / 2, rootNote);

          return (
            <line key={`conn-${i}`}
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={`hsl(${hue}, 35%, 35%)`}
              strokeWidth={nextStep.tie ? 2 : 0.8}
              opacity={nextStep.tie ? 0.5 : 0.25}
              strokeDasharray={nextStep.slide ? "none" : "2 3"} />
          );
        })}

        {/* Center circle */}
        <circle cx={cx} cy={cy} r={innerR}
          fill={colorScheme.bg} stroke={colorScheme.accent} strokeWidth="1.5" opacity={0.85} />
        <text x={cx} y={cy - 3} textAnchor="middle" dominantBaseline="middle"
          fill={colorScheme.accent} fontSize="7" fontFamily="monospace" fontWeight="bold" opacity={0.6}
          className="pointer-events-none">
          MELODY
        </text>
        <text x={cx} y={cy + 7} textAnchor="middle" dominantBaseline="middle"
          fill="#666" fontSize="5" fontFamily="monospace" className="pointer-events-none">
          tap to toggle
        </text>

        {/* Playhead */}
        {isPlaying && currentStep >= 0 && (
          <line
            x1={cx} y1={cy}
            x2={cx + Math.cos((playheadAngle * Math.PI) / 180) * (ringR + 14)}
            y2={cy + Math.sin((playheadAngle * Math.PI) / 180) * (ringR + 14)}
            stroke={colorScheme.accent}
            strokeWidth="1.5"
            opacity={0.5}
            filter="url(#melFlowerGlow)"
            style={{ transition: isPlaying ? "all 150ms linear" : "none" }}
          />
        )}
      </svg>
    </div>
  );
});

// ──────────────────────────────────────────────
// Radial Scene — concentric layout: core + drum ring + melody ring
// ──────────────────────────────────────────────
function RadialScene({
  pattern,
  currentStep,
  isPlaying,
  colorScheme,
  drumColors,
  beatPulse,
  onUpdateSurreal,
  onToggleDrumStep,
  onToggleDrumMute,
  onDragMelodyPitch,
  onToggleMelodyStep,
  onToggleMelodyMute,
  melodyExpanded,
  onExpandMelody,
  surreal,
}: {
  pattern: PatternState;
  currentStep: number;
  isPlaying: boolean;
  colorScheme: { bg: string; accent: string; glow: string };
  drumColors: string[];
  beatPulse: number;
  onUpdateSurreal: (key: keyof SurrealParams, value: number) => void;
  onToggleDrumStep: (trackIdx: number, stepIdx: number) => void;
  onToggleDrumMute: (trackIdx: number) => void;
  onDragMelodyPitch: (stepIdx: number, note: number) => void;
  onToggleMelodyStep: (stepIdx: number) => void;
  onToggleMelodyMute: () => void;
  melodyExpanded: boolean;
  onExpandMelody: (expanded: boolean) => void;
  surreal: SurrealParams;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState(400);

  // Track container size for responsive layout
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const s = Math.min(entry.contentRect.width, entry.contentRect.height);
        setContainerSize(s);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Lily pad positions — 8 pads in a circle (pulled inward so melody ring has its own lane)
  // On small screens, push pads further out and shrink them to reduce overlap
  const lilyPadPositions = useMemo(() => {
    const r = containerSize < 400 ? 33 : 30; // % from center — wider on small screens
    return pattern.drumTracks.map((_, i) => {
      const angle = (i / 8) * Math.PI * 2 - Math.PI / 2;
      return {
        left: `${50 + Math.cos(angle) * r}%`,
        top: `${50 + Math.sin(angle) * r}%`,
      };
    });
  }, [pattern.drumTracks.length, containerSize]);

  // Size of each lily pad as percentage of container — smaller on small screens to prevent overlap
  const padSizePct = containerSize < 400 ? 20 : 16;

  // Blinking ASCII stars — many possible positions, only 4-5 visible at a time
  // Stars use pure CSS animation — no JS state updates needed
  const allStarPositions = useMemo(() => [
    { char: "*", top: "3%", left: "8%", size: "text-lg", delay: 0 },
    { char: "·", top: "7%", left: "45%", size: "text-2xl", delay: 3.2 },
    { char: "+", top: "5%", left: "78%", size: "text-sm", delay: 7.1 },
    { char: "*", top: "12%", left: "92%", size: "text-base", delay: 1.5 },
    { char: "·", top: "18%", left: "4%", size: "text-xl", delay: 5.8 },
    { char: "+", top: "25%", left: "94%", size: "text-xs", delay: 9.3 },
    { char: "*", top: "35%", left: "2%", size: "text-sm", delay: 2.7 },
    { char: "·", top: "40%", left: "97%", size: "text-lg", delay: 6.4 },
    { char: "+", top: "55%", left: "1%", size: "text-base", delay: 11.2 },
    { char: "*", top: "60%", left: "96%", size: "text-xl", delay: 4.1 },
    { char: "·", top: "72%", left: "5%", size: "text-sm", delay: 8.6 },
    { char: "+", top: "70%", left: "93%", size: "text-lg", delay: 0.8 },
    { char: "*", top: "82%", left: "10%", size: "text-xs", delay: 10.5 },
    { char: "·", top: "88%", left: "50%", size: "text-base", delay: 3.9 },
    { char: "+", top: "80%", left: "85%", size: "text-sm", delay: 7.7 },
    { char: "*", top: "92%", left: "30%", size: "text-lg", delay: 12.1 },
    { char: "·", top: "15%", left: "25%", size: "text-xs", delay: 5.3 },
    { char: "+", top: "50%", left: "96%", size: "text-sm", delay: 9.8 },
    { char: "*", top: "95%", left: "70%", size: "text-base", delay: 2.2 },
    { char: "·", top: "30%", left: "3%", size: "text-lg", delay: 6.9 },
    // Extra stars for wide desktop — fill the horizontal margins
    { char: "+", top: "10%", left: "15%", size: "text-xs", delay: 4.5 },
    { char: "*", top: "22%", left: "88%", size: "text-sm", delay: 1.1 },
    { char: "·", top: "45%", left: "7%", size: "text-base", delay: 8.2 },
    { char: "+", top: "48%", left: "90%", size: "text-xs", delay: 3.6 },
    { char: "*", top: "65%", left: "12%", size: "text-lg", delay: 10.8 },
    { char: "·", top: "68%", left: "88%", size: "text-sm", delay: 0.4 },
    { char: "+", top: "85%", left: "15%", size: "text-base", delay: 7.3 },
    { char: "*", top: "78%", left: "92%", size: "text-xs", delay: 5.7 },
    { char: "·", top: "38%", left: "12%", size: "text-sm", delay: 11.9 },
    { char: "+", top: "53%", left: "88%", size: "text-lg", delay: 2.8 },
  ], []);

  // Detect mobile (narrow) layout — use window width since we measure before ref mounts
  const [windowWidth, setWindowWidth] = useState(() => typeof window !== "undefined" ? window.innerWidth : 600);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const isMobile = windowWidth < 520;

  // Shared expanded overlays
  const expandedMelody = melodyExpanded && (
    <div className="mt-3 relative">
      <div className="flex items-center justify-between mb-1 px-2">
        <span className="text-[10px] font-bold tracking-[0.2em] uppercase" style={{ color: colorScheme.accent }}>
          MELODY — EDIT PATTERN
        </span>
        <button
          type="button"
          onClick={() => onExpandMelody(false)}
          className="text-[10px] px-2 py-0.5 rounded bg-neutral-800 text-neutral-400 cursor-default"
        >
          CLOSE
        </button>
      </div>
      <div className="flex justify-center">
        <div style={{ maxWidth: "300px", width: "100%" }}>
          <MelodyFlower
            steps={pattern.melodyTrack.steps}
            currentStep={currentStep}
            isPlaying={isPlaying}
            colorScheme={colorScheme}
            rootNote={pattern.rootNote}
            scale={pattern.scale}
            onToggleStep={onToggleMelodyStep}
            onDragPitch={onDragMelodyPitch}
            onToggleMute={onToggleMelodyMute}
            muted={pattern.melodyTrack.muted}
            isMobile={isMobile}
          />
        </div>
      </div>
    </div>
  );


  // ── Mobile: stacked vertical layout (effects → drums → melody) ──
  if (isMobile) {
    return (
      <div className="px-3 pb-2 space-y-4 overflow-hidden">
        {/* ASCII stars scattered around */}
        <div className="relative overflow-hidden">
          {allStarPositions.slice(0, 8).map((star, i) => (
            <span
              key={`star-${i}`}
              className={`absolute ${star.size} font-['Share_Tech_Mono',monospace] select-none`}
              style={{
                top: star.top, left: star.left,
                color: colorScheme.glow, pointerEvents: "none",
                animation: `starBlink 5s ease-in-out ${star.delay}s infinite`, opacity: 0,
              }}
            >
              {star.char}
            </span>
          ))}
        </div>

        {/* ── Effects (RippleCore) ── */}
        <div>
          <div className="text-[10px] font-bold tracking-[0.2em] uppercase text-neutral-500 mb-2 px-1">EFFECTS</div>
          <div className="mx-auto" style={{ maxWidth: "260px" }}>
            <RippleCore
              surreal={pattern.surreal}
              onUpdate={onUpdateSurreal}
              isPlaying={isPlaying}
              beatPulse={beatPulse}
              isMobile={isMobile}
            />
          </div>
        </div>

        {/* ── Drums (LilyPads in a grid) ── */}
        <div>
          <div className="text-[10px] font-bold tracking-[0.2em] uppercase text-neutral-500 mb-2 px-1">DRUMS</div>
          <div className="grid grid-cols-4 gap-2">
            {pattern.drumTracks.map((track, i) => (
              <div key={i} className="aspect-square">
                <LilyPad
                  steps={track.steps}
                  currentStep={currentStep}
                  isPlaying={isPlaying}
                  color={drumColors[i] ?? colorScheme.accent}
                  voiceName={track.name}
                  trackIdx={i}
                  muted={track.muted}
                  onToggleStep={onToggleDrumStep}
                  onToggleMute={onToggleDrumMute}
                />
              </div>
            ))}
          </div>
        </div>

        {/* ── Melody (MelodyRing + expand) ── */}
        <div>
          <div className="text-[10px] font-bold tracking-[0.2em] uppercase text-neutral-500 mb-2 px-1">MELODY</div>
          <div className="mx-auto relative" style={{ maxWidth: "300px", aspectRatio: "1" }}>
            <MelodyRing
              steps={pattern.melodyTrack.steps}
              currentStep={currentStep}
              isPlaying={isPlaying}
              surreal={pattern.surreal}
              colorScheme={colorScheme}
              rootNote={pattern.rootNote}
              scale={pattern.scale}
              onDragPitch={onDragMelodyPitch}
              onToggleStep={onToggleMelodyStep}
              onTapRing={() => onExpandMelody(!melodyExpanded)}
              viewSize={300}
              isMobile={isMobile}
            />
          </div>
          {expandedMelody}
        </div>
      </div>
    );
  }

  // ── Desktop: circular overlapping pond layout ──
  return (
    <div className="px-2 pb-2">
      {/* Full-width star field — stars fill the horizontal space */}
      <div className="relative w-full overflow-hidden" style={{ minHeight: "min(85vh, 85vw, 900px)" }}>
        {/* ASCII stars — spread across full width */}
        {allStarPositions.map((star, i) => (
          <span
            key={`star-${i}`}
            className={`absolute ${star.size} font-['Share_Tech_Mono',monospace] select-none`}
            style={{
              top: star.top,
              left: star.left,
              color: colorScheme.glow,
              pointerEvents: "none",
              animation: `starBlink 5s ease-in-out ${star.delay}s infinite`,
              opacity: 0,
            }}
          >
            {star.char}
          </span>
        ))}

        {/* Radial shape — centered, sized by viewport height */}
        <div className="relative mx-auto" style={{ width: "min(85vh, 85vw, 900px)", maxWidth: "100%" }}>
        <div
          ref={containerRef}
          className="relative mx-auto"
          style={{
            width: "100%",
            aspectRatio: "1",
          }}
        >
          {/* Subtle concentric guide rings */}
          <svg className="absolute inset-0 w-full h-full" viewBox="0 0 400 400" style={{ pointerEvents: "none" }}>
            {[0.3, 0.5, 0.7, 0.85, 0.95].map((t, i) => (
              <circle key={`ring-${i}`} cx="200" cy="200" r={200 * t}
                fill="none" stroke={colorScheme.glow} strokeWidth="0.5" opacity={0.06 - i * 0.008} />
            ))}
          </svg>

        {/* Melody Ring — outermost layer */}
        <MelodyRing
          steps={pattern.melodyTrack.steps}
          currentStep={currentStep}
          isPlaying={isPlaying}
          surreal={pattern.surreal}
          colorScheme={colorScheme}
          rootNote={pattern.rootNote}
          scale={pattern.scale}
          onDragPitch={onDragMelodyPitch}
          onToggleStep={onToggleMelodyStep}
          onTapRing={() => onExpandMelody(!melodyExpanded)}
          viewSize={400}
          isMobile={isMobile}
        />

        {/* Ripple Core — center (pointer-events: none on wrapper, SVG children opt-in) */}
        <div className="absolute" style={{
          left: "20%", top: "20%", width: "60%", height: "60%",
          pointerEvents: "none",
        }}>
          <RippleCore
            surreal={pattern.surreal}
            onUpdate={onUpdateSurreal}
            isPlaying={isPlaying}
            beatPulse={beatPulse}
            isMobile={isMobile}
          />
        </div>

        {/* Lily Pads — 8 drum voices in a circle */}
        {pattern.drumTracks.map((track, i) => {
          const pos = lilyPadPositions[i];
          if (!pos) return null;
          return (
            <div
              key={i}
              className="absolute"
              style={{
                left: pos.left,
                top: pos.top,
                width: `${padSizePct}%`,
                height: `${padSizePct}%`,
                transform: "translate(-50%, -50%)",
                zIndex: 10,
              }}
            >
              <LilyPad
                steps={track.steps}
                currentStep={currentStep}
                isPlaying={isPlaying}
                color={drumColors[i] ?? colorScheme.accent}
                voiceName={track.name}
                trackIdx={i}
                muted={track.muted}
                onToggleStep={onToggleDrumStep}
                onToggleMute={onToggleDrumMute}
              />
            </div>
          );
        })}
      </div>

      {expandedMelody}
      </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// Main Groovebox
// ──────────────────────────────────────────────
function Groovebox() {
  const queryClient = useQueryClient();

  // Pattern state — check URL hash first for shared patterns
  const urlDataRef = useRef(getPatternFromURL());
  const [pattern, setPattern] = useState<PatternState>(() => {
    const fromURL = urlDataRef.current;
    if (fromURL) {
      console.log("Groovebox: loaded pattern from shared URL");
      clearPatternURL();
      return fromURL.pattern;
    }
    return applyPreset("Bosch Hellscape");
  });
  const [activePreset, setActivePreset] = useState(() => {
    return urlDataRef.current ? "Shared Pattern" : "Bosch Hellscape";
  });
  // Named canvas: replaces Blank Canvas in preset bar when set (from URL share or user rename)
  const [canvasName, setCanvasName] = useState<string | null>(() => {
    const d = urlDataRef.current;
    return d ? (d.presetName ?? "Shared Pattern") : null;
  });
  const [isEditingCanvasName, setIsEditingCanvasName] = useState(false);
  const [saveFlash, setSaveFlash] = useState(false);
  // Scratchpad: stashes canvas pattern when switching to a built-in preset
  const scratchpadRef = useRef<PatternState | null>(urlDataRef.current ? urlDataRef.current.pattern : null);
  const [saveReminder, setSaveReminder] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showLoadDialog, setShowLoadDialog] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [currentPatternId, setCurrentPatternId] = useState<number | null>(null);
  const [resetJitter, setResetJitter] = useState(0);
  const [showMelody, setShowMelody] = useState(true);
  const [showDrums, setShowDrums] = useState(true);
  const [audioState, setAudioState] = useState("uninitialized");

  // Melody edit modes
  const [editMode, setEditMode] = useState<"note" | "chord" | "tie">("note");
  const [chordType, setChordType] = useState<ChordType>("triad");
  const [arpMode, setArpMode] = useState<ArpMode>("up");
  const [appView, setAppView] = useState<"classic" | "radial" | "director">("radial");
  const [melodyExpanded, setMelodyExpanded] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [showHints, setShowHints] = useState(false);
  const [showGuide, setShowGuide] = useState(() => {
    try { return !localStorage.getItem("symphonia-guided"); } catch { return true; }
  });

  // Sequencer (shared hook)
  const { isPlaying, isPlayingRef, currentStep, beatPulse, handlePlay, handleStop } = useSequencer(pattern);

  // Track whether user has ever hit play — once true, always show visualizer instead of intro text
  const hasEverPlayed = useRef(false);
  useEffect(() => {
    if (isPlaying) hasEverPlayed.current = true;
  }, [isPlaying]);

  // Director personality sliders (-1 to 1, 0 = neutral/preset default)
  const [directorValues, setDirectorValues] = useState({
    mood: 0,       // maudlin (-1) ↔ irreverent (+1)
    fidelity: 0,   // pristine (-1) ↔ corroded (+1)
    space: 0,      // intimate (-1) ↔ cathedral (+1)
    stability: 0,  // rigid (-1) ↔ elastic (+1)
    intensity: 0,  // gentle (-1) ↔ violent (+1)
  });

  // Undo history (stores snapshots of pattern state, max 30)
  const patternRef = useRef(pattern);
  useEffect(() => { patternRef.current = pattern; }, [pattern]);
  const historyRef = useRef<PatternState[]>([]);
  const pushHistory = useCallback(() => {
    historyRef.current = [...historyRef.current.slice(-29), structuredClone(patternRef.current)];
  }, []);

  const undo = useCallback(() => {
    const prev = historyRef.current.pop();
    if (prev) setPattern(prev);
  }, []);

  // Fonts are loaded by FontLoader at the App level

  // Escape key to dismiss modals
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmDeleteId !== null) { setConfirmDeleteId(null); return; }
        if (showSaveDialog) { setShowSaveDialog(false); setSaveName(""); return; }
        if (showLoadDialog) { setShowLoadDialog(false); return; }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showSaveDialog, showLoadDialog, confirmDeleteId]);

  // Is the user currently on their canvas (Blank Canvas or a shared/named canvas)?
  const isOnCanvas = activePreset === "Blank Canvas" || activePreset === "Shared Pattern";

  // Keep scratchpad in sync while on canvas
  if (isOnCanvas) {
    scratchpadRef.current = pattern;
  }

  // Get the current preset's color scheme (customHue overrides when on Blank Canvas)
  const presetDef = PRESETS.find(p => p.name === activePreset) ?? PRESETS[0]!;
  const colorScheme = isOnCanvas && pattern.customHue != null
    ? hueToColorScheme(pattern.customHue)
    : presetDef.colorScheme;

  // Detect touch device for responsive piano roll sizing
  const isTouchDevice = useMemo(() =>
    typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches
  , []);

  // Scale notes for the piano roll (2 octaves on desktop, 1 on touch devices)
  const melodyOctaves = isTouchDevice ? 1 : 2;
  const melodyNotes = useMemo(() => {
    const notes: number[] = [];
    const intervals = SCALES[pattern.scale] ?? SCALES.chromatic!;
    for (let octave = melodyOctaves - 1; octave >= 0; octave--) {
      for (let i = intervals.length - 1; i >= 0; i--) {
        notes.push(pattern.rootNote + octave * 12 + intervals[i]!);
      }
    }
    return notes;
  }, [pattern.scale, pattern.rootNote, melodyOctaves]);

  // Precompute melody row fingerprints once per steps change (not per render)
  const melodyFingerprints = useMemo(() => {
    const map = new Map<number, string>();
    for (const noteIdx of melodyNotes) {
      map.set(noteIdx, melodyRowFingerprint(pattern.melodyTrack.steps, noteIdx));
    }
    return map;
  }, [pattern.melodyTrack.steps, melodyNotes]);

  const handleTestTone = useCallback(async () => {
    await engine.init();
    await engine.resume();
    setAudioState(engine.getState());
    engine.playTestTone();
    console.log("Groovebox: test tone triggered, audioState:", engine.getState());
  }, []);

  // Keyboard shortcuts: space=play/stop, ctrl+z=undo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        if (isExportingRef.current) return; // Don't toggle during export
        if (isPlayingRef.current) { handleStop(); } else { void handlePlay(); }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleStop, handlePlay, undo, isPlayingRef]);

  // Update engine when surreal params change
  useEffect(() => {
    if (engine.isReady) {
      engine.updateSurrealParams(pattern.surreal);
    }
  }, [pattern.surreal]);

  useEffect(() => {
    if (engine.isReady) {
      engine.setMasterVolume(pattern.masterVolume);
    }
  }, [pattern.masterVolume]);

  // ── Drag-guard: push undo history once per drag gesture ──
  // Returns a function that calls pushHistory on the first invocation per drag,
  // then auto-resets on pointerup/touchend/pointercancel/timeout.
  const makeDragGuard = useCallback(() => {
    const ref = { active: false };
    return () => {
      if (!ref.active) {
        ref.active = true;
        pushHistory();
        const reset = () => { ref.active = false; };
        window.addEventListener("pointerup", reset, { once: true });
        window.addEventListener("touchend", reset, { once: true });
        window.addEventListener("pointercancel", reset, { once: true });
        setTimeout(reset, 3000);
      }
    };
  }, [pushHistory]);

  const guardSurreal = useMemo(() => makeDragGuard(), [makeDragGuard]);
  const guardDirector = useMemo(() => makeDragGuard(), [makeDragGuard]);
  const guardDrumVelocity = useMemo(() => makeDragGuard(), [makeDragGuard]);

  // ── Pattern mutations ──
  const updateSurreal = useCallback((key: keyof SurrealParams, value: number) => {
    guardSurreal();
    setPattern(prev => ({
      ...prev,
      surreal: { ...prev.surreal, [key]: value },
    }));
  }, [pushHistory]);

  // Map director personality sliders to surreal params
  const applyDirectorValues = useCallback((values: typeof directorValues) => {
    // Get the base surreal values from the current preset
    const preset = PRESETS.find(p => p.name === activePreset);
    const base = preset?.defaultState?.surreal ?? createDefaultPattern().surreal;

    // Each director axis blends the surreal params
    // Positive values push toward maximum, negative toward minimum
    const clamp = (v: number) => Math.max(0, Math.min(1, v));

    const surreal: SurrealParams = {
      // Mood: maudlin(-1) = more grotesque/dark, irreverent(+1) = less grotesque/brighter
      grotesqueness: clamp(base.grotesqueness + values.mood * -0.3),
      // Fidelity: pristine(-1) = less decay, corroded(+1) = more decay
      institutionalDecay: clamp(base.institutionalDecay + values.fidelity * 0.35),
      // Space: intimate(-1) = less reverb, cathedral(+1) = more reverb
      cosmicDread: clamp(base.cosmicDread + values.space * 0.4),
      // Stability: rigid(-1) = less glitch, elastic(+1) = more glitch
      digitalCorruption: clamp(base.digitalCorruption + values.stability * 0.25),
      // Intensity: gentle(-1) = less tension, violent(+1) = more tension
      visceralTension: clamp(base.visceralTension + values.intensity * 0.4),
    };

    setPattern(prev => ({ ...prev, surreal }));
  }, [activePreset]);

  const updateDirector = useCallback((key: keyof typeof directorValues, value: number) => {
    guardDirector();
    setDirectorValues(prev => {
      const next = { ...prev, [key]: value };
      applyDirectorValues(next);
      return next;
    });
  }, [applyDirectorValues, guardDirector]);

  // Reset director sliders when preset changes
  const prevPresetRef = useRef(activePreset);
  useEffect(() => {
    if (prevPresetRef.current !== activePreset) {
      prevPresetRef.current = activePreset;
      setDirectorValues({ mood: 0, fidelity: 0, space: 0, stability: 0, intensity: 0 });
    }
  }, [activePreset]);

  // Auto-dismiss save reminder after 4 seconds, or immediately when returning to canvas
  useEffect(() => {
    if (isOnCanvas) setSaveReminder(false);
  }, [isOnCanvas]);
  useEffect(() => {
    if (!saveReminder) return;
    const t = setTimeout(() => setSaveReminder(false), 6000);
    return () => clearTimeout(t);
  }, [saveReminder]);

  // Helper: update a single drum step immutably
  const updateDrumStep = useCallback((
    trackIdx: number, stepIdx: number,
    fn: (step: DrumStep) => DrumStep | null, // return null to skip
  ) => {
    setPattern(prev => {
      const tracks = [...prev.drumTracks];
      const track = tracks[trackIdx];
      if (!track) return prev;
      const steps = [...track.steps];
      const step = steps[stepIdx];
      if (!step) return prev;
      const updated = fn(step);
      if (!updated) return prev;
      steps[stepIdx] = updated;
      tracks[trackIdx] = { ...track, steps };
      return { ...prev, drumTracks: tracks };
    });
  }, []);

  const toggleDrumStep = useCallback((trackIdx: number, stepIdx: number) => {
    pushHistory();
    updateDrumStep(trackIdx, stepIdx, step => ({ ...step, active: !step.active, accent: false }));
  }, [pushHistory, updateDrumStep]);

  const toggleDrumAccent = useCallback((trackIdx: number, stepIdx: number) => {
    pushHistory();
    updateDrumStep(trackIdx, stepIdx, step => step.active ? { ...step, accent: !step.accent } : null);
  }, [pushHistory, updateDrumStep]);

  // Melody step toggle — handles note, chord, and tie modes
  const toggleMelodyStep = useCallback((stepIdx: number, noteIndex: number) => {
    pushHistory();
    setPattern(prev => {
      const steps = [...prev.melodyTrack.steps];
      const step = steps[stepIdx];
      if (!step) return prev;
      const scaleInts = SCALES[prev.scale] ?? SCALES.chromatic!;

      if (editMode === "tie") {
        // Toggle tie on this step
        if (step.tie) {
          // Remove tie
          steps[stepIdx] = { ...step, active: false, tie: false, notes: [] };
        } else {
          // Add tie (sustain from previous)
          steps[stepIdx] = { ...step, active: true, tie: true, notes: [] };
        }
      } else if (editMode === "chord") {
        // Chord mode: place a chord rooted at the clicked note
        const chord = buildChord(noteIndex, chordType, prev.rootNote, scaleInts);
        const hasExactChord = step.active && !step.tie && step.notes.length === chord.length &&
          chord.every(n => step.notes.includes(n));
        if (hasExactChord) {
          // Remove the chord
          steps[stepIdx] = { ...step, active: false, notes: [], tie: false };
        } else {
          steps[stepIdx] = { ...step, active: true, notes: chord, tie: false };
        }
      } else {
        // Note mode: toggle individual notes (polyphonic)
        const hasNote = step.notes.includes(noteIndex);
        if (hasNote) {
          // Remove this note
          const newNotes = step.notes.filter(n => n !== noteIndex);
          if (newNotes.length === 0) {
            steps[stepIdx] = { ...step, active: false, notes: [], tie: false };
          } else {
            steps[stepIdx] = { ...step, notes: newNotes };
          }
        } else {
          // Add this note (polyphonic — add to existing notes)
          steps[stepIdx] = {
            ...step,
            active: true,
            notes: [...step.notes.filter(n => n !== noteIndex), noteIndex].sort((a, b) => a - b),
            tie: false,
          };
        }
      }
      return { ...prev, melodyTrack: { ...prev.melodyTrack, steps } };
    });
  }, [editMode, chordType, pushHistory]);

  // Update velocity for a drum step (used by flower sequencer drag)
  const updateDrumVelocity = useCallback((trackIdx: number, stepIdx: number, velocity: number) => {
    guardDrumVelocity();
    updateDrumStep(trackIdx, stepIdx, step => step.active ? { ...step, velocity } : null);
  }, [guardDrumVelocity, updateDrumStep]);

  const toggleDrumMute = useCallback((trackIdx: number) => {
    setPattern(prev => {
      const tracks = [...prev.drumTracks];
      const track = tracks[trackIdx];
      if (!track) return prev;
      tracks[trackIdx] = { ...track, muted: !track.muted };
      return { ...prev, drumTracks: tracks };
    });
  }, []);

  const setDrumVolume = useCallback((trackIdx: number, volume: number) => {
    setPattern(prev => {
      const tracks = [...prev.drumTracks];
      const track = tracks[trackIdx];
      if (!track) return prev;
      tracks[trackIdx] = { ...track, volume };
      return { ...prev, drumTracks: tracks };
    });
  }, []);

  // ── Preset selection ──
  // Switch to a built-in preset (Bosch, Midnight, etc.) — stashes canvas if leaving it
  const selectPreset = useCallback((presetName: string) => {
    // Show save reminder if leaving an unsaved scratchpad
    if (isOnCanvas && scratchpadRef.current && !canvasName) {
      setSaveReminder(true);
    }
    pushHistory();
    handleStop();
    const newPattern = applyPreset(presetName);
    setPattern(newPattern);
    setActivePreset(presetName);
    setCurrentPatternId(null);
    // Don't clear canvasName — the named button should persist in the bar
    console.log("Groovebox: preset selected:", presetName);
  }, [handleStop, pushHistory, isOnCanvas, canvasName]);

  // Return to canvas (restore scratchpad)
  const goToCanvas = useCallback(() => {
    const stashed = scratchpadRef.current;
    if (stashed) {
      pushHistory();
      handleStop();
      setPattern(stashed);
      setActivePreset(canvasName ? "Blank Canvas" : "Blank Canvas");
      console.log("Groovebox: restored canvas from scratchpad");
    } else {
      // No scratchpad — just go to empty Blank Canvas
      pushHistory();
      handleStop();
      setPattern(applyPreset("Blank Canvas"));
      setActivePreset("Blank Canvas");
      console.log("Groovebox: went to empty canvas");
    }
  }, [handleStop, pushHistory, canvasName]);

  // Reset canvas to empty — clears scratchpad, canvasName, everything
  const resetCanvas = useCallback(() => {
    pushHistory();
    handleStop();
    scratchpadRef.current = null;
    setPattern(applyPreset("Blank Canvas"));
    setActivePreset("Blank Canvas");
    setCanvasName(null);
    setCurrentPatternId(null);
    setResetJitter(n => n + 1);
    console.log("Groovebox: canvas reset to empty");
  }, [handleStop, pushHistory]);

  // ── Generate arpeggio ──
  const generateArpPattern = useCallback(() => {
    pushHistory();
    setPattern(prev => {
      const arpSteps = generateArp(
        prev.rootNote,
        chordType,
        arpMode,
        prev.scale,
        prev.rootNote,
        prev.stepsPerBar,
      );
      return {
        ...prev,
        melodyTrack: { ...prev.melodyTrack, steps: arpSteps },
      };
    });
    console.log("Groovebox: arp generated, mode:", arpMode, "chord:", chordType);
  }, [chordType, arpMode, pushHistory]);

  // ── Clear melody ──
  const clearMelody = useCallback(() => {
    pushHistory();
    setPattern(prev => ({
      ...prev,
      melodyTrack: {
        ...prev.melodyTrack,
        steps: Array.from({ length: prev.stepsPerBar }, () => emptyMelodyStep()),
      },
    }));
    console.log("Groovebox: melody cleared");
  }, [pushHistory]);

  const updateMelodySpore = useCallback((stepIdx: number, note: number) => {
    setPattern(prev => {
      const steps = [...prev.melodyTrack.steps];
      const step = steps[stepIdx];
      if (!step || !step.active) return prev;
      steps[stepIdx] = { ...step, notes: [note] };
      return { ...prev, melodyTrack: { ...prev.melodyTrack, steps } };
    });
  }, []);

  // Toggle melody step on/off (for radial MelodyFlower)
  const toggleMelodyStepRadial = useCallback((stepIdx: number) => {
    pushHistory();
    setPattern(prev => {
      const steps = [...prev.melodyTrack.steps];
      const step = steps[stepIdx];
      if (!step) return prev;
      if (step.active) {
        // Turn off
        steps[stepIdx] = { ...step, active: false, notes: [], tie: false };
      } else {
        // Turn on with a default note from the scale
        const scaleInts = SCALES[prev.scale] ?? SCALES.chromatic!;
        const degreeIdx = stepIdx % scaleInts.length;
        const note = prev.rootNote + (scaleInts[degreeIdx] ?? 0);
        steps[stepIdx] = { ...step, active: true, notes: [note], tie: false, velocity: 0.7 };
      }
      return { ...prev, melodyTrack: { ...prev.melodyTrack, steps } };
    });
  }, [pushHistory]);

  const toggleMelodyMute = useCallback(() => {
    setPattern(prev => ({
      ...prev,
      melodyTrack: { ...prev.melodyTrack, muted: !prev.melodyTrack.muted },
    }));
  }, []);

  // ── Randomize pattern ──
  const [randomTarget, setRandomTarget] = useState<"all" | "drums" | "melody" | "effects">("all");

  const randomizeDrums = useCallback((prev: PatternState) => ({
    ...prev,
    drumTracks: prev.drumTracks.map(track => ({
      ...track,
      steps: track.steps.map(() => ({
        active: Math.random() > 0.65,
        velocity: 0.5 + Math.random() * 0.5,
        accent: Math.random() > 0.85,
      })),
    })),
  }), []);

  const randomizeMelody = useCallback((prev: PatternState) => {
    const scaleInts = SCALES[prev.scale] ?? SCALES.chromatic!;
    const newSteps: MelodyStep[] = [];
    for (let i = 0; i < prev.stepsPerBar; i++) {
      const roll = Math.random();
      if (roll > 0.7 && i > 0 && newSteps[i - 1]?.active) {
        newSteps.push({ active: true, notes: [], velocity: 0.7, slide: false, tie: true });
      } else if (roll > 0.3) {
        const randomOctave = Math.floor(Math.random() * 2);
        const randomDegree = scaleInts[Math.floor(Math.random() * scaleInts.length)]!;
        const note = prev.rootNote + randomOctave * 12 + randomDegree;
        const useChord = Math.random() > 0.65;
        const notes = useChord
          ? buildChord(note, "triad", prev.rootNote, scaleInts)
          : [note];
        newSteps.push({
          active: true, notes, velocity: 0.5 + Math.random() * 0.4,
          slide: Math.random() > 0.7, tie: false,
        });
      } else {
        newSteps.push(emptyMelodyStep());
      }
    }
    return { ...prev, melodyTrack: { ...prev.melodyTrack, steps: newSteps } };
  }, []);

  const randomizeEffects = useCallback((prev: PatternState) => ({
    ...prev,
    surreal: {
      grotesqueness: Math.random() * 0.6,
      institutionalDecay: Math.random() * 0.5,
      digitalCorruption: Math.random() * 0.3,
      visceralTension: Math.random() * 0.7,
      cosmicDread: Math.random() * 0.6,
    },
  }), []);

  const randomize = useCallback(() => {
    pushHistory();
    setPattern(prev => {
      let next = prev;
      if (randomTarget === "all" || randomTarget === "drums") next = randomizeDrums(next);
      if (randomTarget === "all" || randomTarget === "melody") next = randomizeMelody(next);
      if (randomTarget === "all" || randomTarget === "effects") next = randomizeEffects(next);
      return next;
    });
    console.log(`Groovebox: randomized ${randomTarget}`);
  }, [pushHistory, randomTarget, randomizeDrums, randomizeMelody, randomizeEffects]);

  const randomizeDrumsInline = useCallback(() => {
    pushHistory();
    setPattern(prev => randomizeDrums(prev));
    console.log("Groovebox: randomized drums (inline)");
  }, [pushHistory, randomizeDrums]);

  const randomizeMelodyInline = useCallback(() => {
    pushHistory();
    setPattern(prev => randomizeMelody(prev));
    console.log("Groovebox: randomized melody (inline)");
  }, [pushHistory, randomizeMelody]);

  // ── Save / Load ──
  const { data: savedPatterns } = useQuery({
    queryKey: ["patterns"],
    queryFn: () => listPatterns(),
    enabled: showLoadDialog,
  });

  const saveMutation = useMutation({
    mutationFn: (args: { name: string; id?: number }) =>
      savePattern({
        name: args.name,
        preset: activePreset === "Shared Pattern" ? "Blank Canvas" : activePreset,
        data: JSON.stringify(pattern),
        id: args.id,
      }),
    onSuccess: (result, args) => {
      if (result?.id) setCurrentPatternId(result.id);
      // When saving from Blank Canvas or a named canvas, update canvasName
      if (isOnCanvas) {
        setCanvasName(args.name);
      }
      setShowSaveDialog(false);
      setSaveName("");
      queryClient.invalidateQueries({ queryKey: ["patterns"] });
      console.log("Groovebox: pattern saved, id:", result?.id);
    },
  });

  const loadMutation = useMutation({
    mutationFn: (id: number) => getPattern(id),
    onSuccess: (result) => {
      if (result?.pattern) {
        handleStop();
        try {
          const data = JSON.parse(result.pattern.data) as PatternState;
          setPattern(data);
          setActivePreset(result.pattern.preset);
          setCurrentPatternId(result.pattern.id);
          // If loaded pattern was saved from Blank Canvas, restore canvasName and scratchpad
          if (result.pattern.preset === "Blank Canvas" || result.pattern.preset === "Shared Pattern") {
            setCanvasName(result.pattern.name);
            scratchpadRef.current = data;
          } else {
            setCanvasName(null);
          }
          setShowLoadDialog(false);
          console.log("Groovebox: pattern loaded:", result.pattern.name);
        } catch (e) {
          console.error("Groovebox: failed to parse pattern data", e);
        }
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deletePattern(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["patterns"] });
      console.log("Groovebox: pattern deleted");
    },
  });

  // ── Export ──
  const [isExportingAudio, setIsExportingAudio] = useState(false);
  const isExportingRef = useRef(false);

  const handleExportWav = useCallback(async () => {
    if (isExportingAudio) return;
    setIsExportingAudio(true);
    isExportingRef.current = true;
    try {
      await engine.init();
      await engine.resume();
      engine.updateSurrealParams(pattern.surreal);
      engine.setMasterVolume(pattern.masterVolume);

      const graph = engine.getAudioGraph();
      if (!graph) {
        console.error("Export: audio graph not available");
        setIsExportingAudio(false);
        return;
      }

      // Start playback if not already playing — always restart from step 0
      // so the exported loop starts cleanly at the bar boundary
      const wasPlaying = isPlayingRef.current;
      if (wasPlaying) handleStop();
      // Small delay to let stop settle, then start fresh
      await new Promise(r => setTimeout(r, 50));
      await handlePlay();

      const duration = loopDurationMs(pattern);
      console.log("Export: recording WAV audio, duration:", duration, "ms");
      const wavBlob = await recordOneLoop(graph.ctx, graph.limiter, duration);

      // Stop after recording unless user was already playing
      if (!wasPlaying) handleStop();

      const presetSlug = activePreset.toLowerCase().replace(/\s+/g, "-");
      downloadBlob(wavBlob, `symphonia-${presetSlug}.wav`);
      console.log("Export: WAV download triggered,", wavBlob.size, "bytes");
    } catch (err) {
      console.error("Export audio failed:", err);
    } finally {
      setIsExportingAudio(false);
      isExportingRef.current = false;
    }
  }, [isExportingAudio, pattern, activePreset, handlePlay, handleStop, isPlayingRef]);

  const handleExportMidi = useCallback(() => {
    const midi = exportMidi(pattern);
    const presetSlug = activePreset.toLowerCase().replace(/\s+/g, "-");
    downloadBlob(midi, `symphonia-${presetSlug}.mid`);
    console.log("Export: MIDI download triggered");
  }, [pattern, activePreset]);

  // ── Share URL ──
  const [shareStatus, setShareStatus] = useState<"idle" | "copied">("idle");
  const handleShare = useCallback(() => {
    setPatternToURL(pattern, activePreset);
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
      setShareStatus("copied");
      setTimeout(() => { setShareStatus("idle"); clearPatternURL(); }, 2000);
      console.log("Share: URL copied to clipboard, length:", url.length);
    }).catch(() => {
      // Fallback: just set the URL, user can copy from address bar
      setShareStatus("copied");
      setTimeout(() => { setShareStatus("idle"); }, 2000);
      console.log("Share: URL set (clipboard not available)");
    });
  }, [pattern, activePreset]);

  // ── Drum track colors (memoized) ──
  const drumColors = useMemo(() => [
    colorScheme.accent, "#ff6644", "#ffcc00", "#ff44aa",
    "#8844ff", "#44aaff", "#44ffaa", "#ff8844",
  ], [colorScheme.accent]);

  // Count active notes per step for the step status bar
  const stepNoteCount = useMemo(() => pattern.melodyTrack.steps.map(s =>
    s.active ? (s.tie ? "T" : s.notes.length.toString()) : ""
  ), [pattern.melodyTrack.steps]);

  return (
    <div
      className="min-h-screen text-white font-['Rajdhani',sans-serif] pt-safe pb-safe"
      style={{ backgroundColor: colorScheme.bg, maxWidth: "100vw", boxSizing: "border-box" as const, overflowX: "clip" as const }}
    >
      {/* Static global styles — never changes */}
      <style>{`
        html { overflow-x: clip; max-width: 100vw; }
        body { overflow-x: clip; max-width: 100vw; touch-action: manipulation; }
        *, *::before, *::after { box-sizing: border-box; }
        body { overscroll-behavior: none; }
        input[type="range"] { touch-action: none; }
        @media (pointer: coarse) {
          input[type="range"]::-webkit-slider-thumb { min-width: 28px; min-height: 28px; }
          input[type="range"]::-moz-range-thumb { min-width: 28px; min-height: 28px; }
          .melody-step { min-height: 44px !important; }
        }
        @keyframes starBlink {
          0%, 100% { opacity: 0; }
          15%, 35% { opacity: 0.45; }
          25% { opacity: 0.5; }
        }
        @keyframes resetJitter {
          0% { transform: translate(0, 0) rotate(0deg); }
          15% { transform: translate(-3px, 2px) rotate(-1deg); }
          30% { transform: translate(4px, -1px) rotate(1.5deg); }
          45% { transform: translate(-2px, -3px) rotate(-0.5deg); }
          60% { transform: translate(3px, 1px) rotate(1deg); }
          75% { transform: translate(-1px, 2px) rotate(-0.8deg); }
          100% { transform: translate(0, 0) rotate(0deg); }
        }
        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
        }
        :focus-visible { outline: 2px solid rgba(103, 232, 249, 0.6); outline-offset: 2px; }
        button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid rgba(103, 232, 249, 0.6); outline-offset: 2px; }
      `}</style>
      {/* Dynamic theme styles — only changes on preset switch */}
      <style key={colorScheme.accent}>{`
        .director-slider::-webkit-slider-thumb {
          background-color: ${colorScheme.accent};
          box-shadow: 0 0 8px ${colorScheme.glow}66;
        }
        .director-slider::-moz-range-thumb {
          background-color: ${colorScheme.accent};
          box-shadow: 0 0 8px ${colorScheme.glow}66;
          border: none;
        }
        .transport-slider {
          -webkit-appearance: none;
          appearance: none;
          background: transparent;
          cursor: default;
        }
        .transport-slider::-webkit-slider-runnable-track {
          height: 3px;
          border-radius: 2px;
          background: ${colorScheme.accent}33;
        }
        .transport-slider::-moz-range-track {
          height: 3px;
          border-radius: 2px;
          background: ${colorScheme.accent}33;
          border: none;
        }
        .transport-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 18px;
          height: 18px;
          margin-top: -7.5px;
          border: none;
          background: transparent;
          background-image: url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='-9 -9 18 18'><circle cx='0' cy='-4.2' r='2.8' fill='${colorScheme.accent}'/><circle cx='4' cy='-1.3' r='2.8' fill='${colorScheme.accent}'/><circle cx='2.5' cy='3.4' r='2.8' fill='${colorScheme.accent}'/><circle cx='-2.5' cy='3.4' r='2.8' fill='${colorScheme.accent}'/><circle cx='-4' cy='-1.3' r='2.8' fill='${colorScheme.accent}'/><circle cx='0' cy='0' r='2.2' fill='${colorScheme.glow}'/></svg>`)}");
          background-size: contain;
          filter: drop-shadow(0 0 4px ${colorScheme.glow}88);
        }
        .transport-slider::-moz-range-thumb {
          width: 18px;
          height: 18px;
          border: none;
          background: transparent;
          background-image: url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='-9 -9 18 18'><circle cx='0' cy='-4.2' r='2.8' fill='${colorScheme.accent}'/><circle cx='4' cy='-1.3' r='2.8' fill='${colorScheme.accent}'/><circle cx='2.5' cy='3.4' r='2.8' fill='${colorScheme.accent}'/><circle cx='-2.5' cy='3.4' r='2.8' fill='${colorScheme.accent}'/><circle cx='-4' cy='-1.3' r='2.8' fill='${colorScheme.accent}'/><circle cx='0' cy='0' r='2.2' fill='${colorScheme.glow}'/></svg>`)}");
          background-size: contain;
          filter: drop-shadow(0 0 4px ${colorScheme.glow}88);
          border-radius: 0;
        }
        .hue-slider::-webkit-slider-runnable-track {
          background: linear-gradient(to right, hsl(0,55%,45%), hsl(60,55%,45%), hsl(120,55%,45%), hsl(180,55%,45%), hsl(240,55%,45%), hsl(300,55%,45%), hsl(360,55%,45%)) !important;
          height: 5px;
          border-radius: 3px;
        }
        .hue-slider::-moz-range-track {
          background: linear-gradient(to right, hsl(0,55%,45%), hsl(60,55%,45%), hsl(120,55%,45%), hsl(180,55%,45%), hsl(240,55%,45%), hsl(300,55%,45%), hsl(360,55%,45%)) !important;
          height: 5px;
          border-radius: 3px;
          border: none;
        }
      `}</style>

      {/* ── Header ── */}
      <div className="px-4 py-3 border-b border-neutral-800/50 overflow-hidden">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="shrink-0">
            <h1
              className="text-lg md:text-3xl font-bold tracking-[0.3em] uppercase font-['Share_Tech_Mono',monospace]"
              style={{ color: colorScheme.glow, textShadow: `0 0 20px ${colorScheme.glow}44` }}
            >
              SYMPHONIA
            </h1>
            <div className="text-[10px] md:text-sm text-neutral-600 tracking-[0.15em] flex items-center gap-0">
              {isOnCanvas ? (
                isEditingCanvasName ? (
                  <input
                    type="text"
                    defaultValue={canvasName ?? (scratchpadRef.current ? "Scratchpad" : "Blank Canvas")}
                    autoFocus
                    maxLength={30}
                    onBlur={(e) => {
                      const name = e.target.value.trim();
                      setIsEditingCanvasName(false);
                      if (name && name !== "Blank Canvas" && name !== "Scratchpad") {
                        setCanvasName(name);
                        saveMutation.mutate({ name, id: currentPatternId ?? undefined });
                        setSaveFlash(true);
                        setTimeout(() => setSaveFlash(false), 1500);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setIsEditingCanvasName(false);
                    }}
                    className="bg-transparent border-b border-neutral-600 text-[10px] text-neutral-400 tracking-[0.15em] outline-none w-28"
                    style={{ fontFamily: "inherit" }}
                  />
                ) : (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => setIsEditingCanvasName(true)}
                    onKeyDown={(e) => { if (e.key === "Enter") setIsEditingCanvasName(true); }}
                    className="cursor-text hover:text-neutral-400 border-b border-dashed border-neutral-700 hover:border-neutral-500 transition-colors"
                    title="Click to name your canvas"
                  >
                    {canvasName ?? (scratchpadRef.current ? "Scratchpad" : "Blank Canvas")}
                  </span>
                )
              ) : (
                <span>{activePreset}</span>
              )}
              {saveFlash && <span className="text-green-500 mx-1 animate-pulse">saved!</span>}
              <span className="text-neutral-700 mx-1">|</span>{pattern.tempo} bpm
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 items-center justify-end min-w-0">
            {/* View toggle */}
            <div className="flex gap-0.5 border border-neutral-800 rounded p-0.5">
              <button
                type="button"
                onClick={() => setAppView("radial")}
                className={`px-2 py-1 rounded text-[9px] md:text-xs font-bold tracking-wider uppercase cursor-default transition-all ${
                  appView === "radial" ? "bg-cyan-900/50 text-cyan-400" : "text-neutral-600 hover:text-neutral-400"
                }`}
                title="Radial visual interface — touch to play"
              >
                <span className="block leading-tight">RADIAL</span>
                <span className={`block text-[7px] md:text-[9px] font-normal tracking-normal normal-case ${appView === "radial" ? "text-cyan-500/60" : "text-neutral-700"}`}>touch</span>
              </button>
              <button
                type="button"
                onClick={() => setAppView("classic")}
                className={`px-2 py-1 rounded text-[9px] md:text-xs font-bold tracking-wider uppercase cursor-default transition-all ${
                  appView === "classic" ? "bg-neutral-700 text-white" : "text-neutral-600 hover:text-neutral-400"
                }`}
                title="Traditional sliders, grid, and piano roll"
              >
                <span className="block leading-tight">CLASSIC</span>
                <span className={`block text-[7px] md:text-[9px] font-normal tracking-normal normal-case ${appView === "classic" ? "text-neutral-400" : "text-neutral-700"}`}>grid</span>
              </button>
              <button
                type="button"
                onClick={() => setAppView("director")}
                className={`px-2 py-1 rounded text-[9px] md:text-xs font-bold tracking-wider uppercase cursor-default transition-all ${
                  appView === "director" ? "bg-amber-900/50 text-amber-400" : "text-neutral-600 hover:text-neutral-400"
                }`}
                title="Shape the sound with personality"
              >
                <span className="block leading-tight">DIRECTOR</span>
                <span className={`block text-[7px] md:text-[9px] font-normal tracking-normal normal-case ${appView === "director" ? "text-amber-500/60" : "text-neutral-700"}`}>mood</span>
              </button>
            </div>
            <button
              type="button"
              onClick={() => setShowHints(!showHints)}
              className={`w-8 h-8 shrink-0 rounded-full text-[11px] font-bold cursor-default transition-all ${
                showHints
                  ? "bg-amber-900/60 text-amber-300 ring-1 ring-amber-500/40"
                  : "bg-neutral-800 text-neutral-500 hover:text-neutral-300"
              }`}
              title={showHints ? "Hide hints" : "Show hints"}
            >
              ?
            </button>
            <div className="flex flex-wrap gap-1.5 items-center">
              <button
                type="button"
                onClick={() => { setSaveName(canvasName ?? ""); setShowSaveDialog(true); }}
                className="p-2 rounded bg-neutral-800 hover:bg-neutral-700 transition-colors cursor-default min-w-[40px] min-h-[40px] flex items-center justify-center"
                title="Save pattern"
              >
                <Save size={15} />
              </button>
              <button
                type="button"
                onClick={() => setShowLoadDialog(true)}
                className="p-2 rounded bg-neutral-800 hover:bg-neutral-700 transition-colors cursor-default min-w-[40px] min-h-[40px] flex items-center justify-center"
                title="Load saved pattern"
              >
                <FolderOpen size={15} />
              </button>
              <button
                type="button"
                onClick={handleExportWav}
                disabled={isExportingAudio}
                className={`flex items-center gap-1 px-2.5 py-2 rounded text-[10px] md:text-xs font-bold tracking-wider uppercase cursor-default min-h-[40px] transition-all ${
                  isExportingAudio
                    ? "bg-amber-900/40 text-amber-400 border border-amber-700/50 animate-pulse"
                    : "bg-neutral-800 hover:bg-neutral-700 text-neutral-300"
                }`}
                title="Export one loop as audio"
              >
                <Download size={13} />
                {isExportingAudio ? "REC..." : "AUDIO"}
              </button>
              <button
                type="button"
                onClick={handleExportMidi}
                className="flex items-center gap-1 px-2.5 py-2 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-[10px] md:text-xs font-bold tracking-wider uppercase cursor-default min-h-[40px] transition-all"
                title="Export drums & melody as MIDI file"
              >
                <Download size={13} />
                MIDI
              </button>
              <button
                type="button"
                onClick={handleShare}
                className={`flex items-center gap-1 px-2.5 py-2 rounded text-[10px] md:text-xs font-bold tracking-wider uppercase cursor-default min-h-[40px] transition-all ${
                  shareStatus === "copied"
                    ? "bg-green-900/50 text-green-400 border border-green-700/50"
                    : "bg-neutral-800 hover:bg-neutral-700 text-neutral-300"
                }`}
                title="Copy shareable link to clipboard"
              >
                <Link size={13} />
                {shareStatus === "copied" ? "COPIED!" : "SHARE"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Save reminder toast ── */}
      {saveReminder && (
        <div
          className="px-4 py-2 bg-amber-900/30 border-b border-amber-700/30 flex items-center justify-between cursor-default"
          onClick={() => setSaveReminder(false)}
        >
          <span className="text-[10px] text-amber-400/80 tracking-wider uppercase">
            Your scratchpad is stashed
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setSaveReminder(false); setSaveName(canvasName ?? ""); setShowSaveDialog(true); }}
              className="text-[10px] font-bold text-amber-300 tracking-wider uppercase hover:text-amber-200 transition-colors"
            >
              Save now
            </button>
            <span className="text-[10px] text-amber-700">dismiss</span>
          </div>
        </div>
      )}

      {/* ── Intro / Visualizer ── */}
      {hasEverPlayed.current ? (
        <div className="px-4 pt-3">
          <div className="text-[10px] md:text-xs font-bold tracking-[0.2em] uppercase text-neutral-600 mb-1.5 px-1">SIGNAL</div>
          <Visualizer engine={engine} isPlaying={isPlaying} colorScheme={colorScheme} />
        </div>
      ) : (
        <div className="px-4 pt-4 pb-1">
          <p className="text-sm md:text-lg text-neutral-400 leading-relaxed max-w-lg">
            A groovebox for making strange, beautiful music.
            <span className="text-neutral-500"> Pick a preset below, then </span>
            <span className="text-white font-bold">hit play</span>
            <span className="text-neutral-500"> to hear it. Drag the center blob to warp the sound. Tap flowers to change the beat. Switch to </span>
            <button
              type="button"
              onClick={() => setAppView("classic")}
              className="text-neutral-300 underline underline-offset-2 cursor-default"
            >classic view</button>
            <span className="text-neutral-500"> for a grid sequencer.</span>
          </p>
        </div>
      )}

      {/* ── Transport ── */}
      <div className="px-4 py-3 space-y-2">
        {/* Primary row: Play, BPM, Volume, Audio status */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            aria-label={isPlaying ? "Stop playback" : "Start playback"}
            disabled={isExportingAudio}
            onClick={isPlaying ? handleStop : handlePlay}
            className={`flex items-center gap-2 px-5 py-2.5 rounded font-bold text-sm tracking-wider uppercase cursor-default transition-all min-h-[44px] ${
              !isPlaying && audioState === "suspended" ? "animate-pulse" : ""
            } ${isExportingAudio ? "opacity-50 pointer-events-none" : ""}`}
            style={{
              backgroundColor: isPlaying ? "#ff2200" : colorScheme.accent,
              boxShadow: `0 0 15px ${isPlaying ? "#ff220066" : colorScheme.glow}44`,
            }}
          >
            {isPlaying ? <Square size={14} /> : <Play size={14} />}
            {isPlaying ? "STOP" : audioState === "suspended" ? (isTouchDevice ? "TAP TO PLAY" : "PLAY") : "PLAY"}
          </button>

          {/* Tempo */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] md:text-xs text-neutral-500 tracking-wider uppercase">BPM</span>
            <input
              type="range"
              min={30}
              max={300}
              step={1}
              value={pattern.tempo}
              onChange={(e) => setPattern(prev => ({ ...prev, tempo: Number(e.target.value) }))}
              aria-label="Tempo in BPM"
              className="transport-slider w-20"
            />
            <span className="text-xs md:text-sm font-mono text-neutral-400 w-7 md:w-9 text-right">{pattern.tempo}</span>
          </div>

          {/* Master volume */}
          <div className="flex items-center gap-2">
            <Volume2 size={14} className="text-neutral-500" />
            <input
              type="range"
              min={0}
              max={100}
              value={pattern.masterVolume * 100}
              onChange={(e) => setPattern(prev => ({ ...prev, masterVolume: Number(e.target.value) / 100 }))}
              aria-label="Master volume"
              className="transport-slider w-16"
            />
          </div>

          {/* Audio status */}
          <div className="flex items-center gap-1.5 ml-auto" title={`Audio: ${audioState}`}>
            <div className={`w-2 h-2 rounded-full ${
              audioState === "running" ? "bg-green-500" : audioState === "suspended" ? "bg-yellow-500 animate-pulse" : "bg-neutral-700"
            }`} />
            {audioState !== "running" && audioState !== "uninitialized" && (
              <button
                type="button"
                onClick={handleTestTone}
                className="px-2 py-1 rounded text-[10px] font-bold tracking-wider uppercase cursor-default transition-all bg-yellow-900/40 text-yellow-400 border border-yellow-700/50 hover:bg-yellow-900/60"
              >
                TAP TO WAKE AUDIO
              </button>
            )}
          </div>
        </div>

        {/* Secondary row: Swing, Scale, Randomize */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-[10px] md:text-xs text-neutral-500 tracking-wider uppercase">SWING</span>
            <input
              type="range"
              min={0}
              max={100}
              value={pattern.swing * 100}
              onChange={(e) => setPattern(prev => ({ ...prev, swing: Number(e.target.value) / 100 }))}
              aria-label="Swing amount"
              className="transport-slider w-16"
            />
          </div>

          {isOnCanvas && (
            <div className="flex items-center gap-2">
              <Flower2 size={14} className="text-neutral-500" />
              <input
                type="range"
                min={0}
                max={360}
                step={1}
                value={pattern.customHue ?? 0}
                onChange={(e) => setPattern(prev => ({ ...prev, customHue: Number(e.target.value) }))}
                aria-label="Color hue"
                className="transport-slider hue-slider w-20"
              />
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="text-[10px] md:text-xs text-neutral-500 tracking-wider uppercase">SCALE</span>
            <select
              value={pattern.scale}
              onChange={(e) => setPattern(prev => ({ ...prev, scale: e.target.value }))}
              className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs"
            >
              {Object.entries(SCALE_NAMES).map(([key, name]) => (
                <option key={key} value={key}>{name}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[10px] md:text-xs text-neutral-500 tracking-wider uppercase">RANDOMIZE</span>
            <select
              value={randomTarget}
              onChange={(e) => setRandomTarget(e.target.value as typeof randomTarget)}
              className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs"
            >
              <option value="all">Everything</option>
              <option value="drums">Drums</option>
              <option value="melody">Melody</option>
              <option value="effects">Effects</option>
            </select>
            <button
              type="button"
              onClick={randomize}
              className="p-2 rounded bg-neutral-800 hover:bg-neutral-700 transition-colors cursor-default min-w-[36px] min-h-[36px] flex items-center justify-center"
              title={`Randomize ${randomTarget}`}
              style={{ color: colorScheme.accent }}
            >
              <Dice5 size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* ── Presets ── */}
      <div className="px-4 pb-2">
        <div className="flex flex-wrap gap-2">
          {/* Canvas button (first position): named → Scratchpad → Blank Canvas */}
          <button
            key="canvas-btn"
            type="button"
            onClick={() => { if (!isOnCanvas) goToCanvas(); }}
            className={`px-3 py-1.5 rounded text-[11px] md:text-sm font-bold tracking-wider uppercase border transition-all cursor-default ${
              isOnCanvas
                ? "border-white/30 text-white"
                : scratchpadRef.current
                  ? "bg-neutral-800/50 border-neutral-600 text-neutral-300 hover:text-neutral-200 hover:border-neutral-500 hover:bg-neutral-800"
                  : "bg-neutral-800/50 border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-600 hover:bg-neutral-800"
            }`}
            style={isOnCanvas ? {
              backgroundColor: `${colorScheme.accent}33`,
              borderColor: colorScheme.accent,
              boxShadow: `0 0 10px ${colorScheme.glow}33`,
            } : undefined}
          >
            {canvasName ?? (scratchpadRef.current ? "Scratchpad" : "Blank Canvas")}
          </button>

          {/* Built-in presets (excluding Blank Canvas) */}
          {PRESETS.filter(p => p.name !== "Blank Canvas").map(preset => (
            <button
              key={preset.name}
              type="button"
              onClick={() => { if (activePreset !== preset.name) selectPreset(preset.name); }}
              className={`px-3 py-1.5 rounded text-[11px] md:text-sm font-bold tracking-wider uppercase border transition-all cursor-default ${
                activePreset === preset.name
                  ? "border-white/30 text-white"
                  : "bg-neutral-800/50 border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-600 hover:bg-neutral-800"
              }`}
              style={activePreset === preset.name ? {
                backgroundColor: `${preset.colorScheme.accent}33`,
                borderColor: preset.colorScheme.accent,
                boxShadow: `0 0 10px ${preset.colorScheme.glow}33`,
              } : undefined}
            >
              {preset.name}
            </button>
          ))}

          {/* Reset button: appears when canvas has content (named or with scratchpad) */}
          {(canvasName || scratchpadRef.current) && (
            <button
              key="reset-canvas"
              type="button"
              onClick={resetCanvas}
              className="px-3 py-1.5 rounded text-[11px] font-bold tracking-wider uppercase border transition-all cursor-default bg-neutral-800/50 border-neutral-700 text-neutral-500 hover:text-neutral-200 hover:border-neutral-600 hover:bg-neutral-800 flex items-center gap-1.5"
              title="Reset to fresh blank canvas"
            >
              <RotateCcw size={10} />
              Blank Canvas
            </button>
          )}
        </div>
      </div>

      {/* ── Pond Scene (alternative view) ── */}
      {appView === "radial" && (<>
        {(showHints || !isPlaying) && (
          <div className="px-4 pb-2">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] md:text-xs text-neutral-500 font-mono tracking-wide">
              <span><span className="text-neutral-400">center</span> drag handles to shape effects</span>
              <span><span className="text-neutral-400">flowers</span> tap petals to toggle, drag to set volume</span>
              <span><span className="text-neutral-400">outer ring</span> tap nodes to toggle, drag to change pitch</span>
            </div>
          </div>
        )}
        <div
          key={`jitter-${resetJitter}`}
          style={resetJitter > 0 ? { animation: "resetJitter 0.4s ease-out" } : undefined}
        >
          <RadialScene
            pattern={pattern}
            currentStep={currentStep}
            isPlaying={isPlaying}
            colorScheme={colorScheme}
            drumColors={drumColors}
            beatPulse={beatPulse}
            onUpdateSurreal={updateSurreal}
            onToggleDrumStep={toggleDrumStep}
            onToggleDrumMute={toggleDrumMute}
            onDragMelodyPitch={updateMelodySpore}
            onToggleMelodyStep={toggleMelodyStepRadial}
            onToggleMelodyMute={toggleMelodyMute}
            melodyExpanded={melodyExpanded}
            onExpandMelody={setMelodyExpanded}
            surreal={pattern.surreal}
          />
        </div>
      </>)}

      {/* ── Classic Controls ── */}
      {appView === "classic" && (<>
      {showHints && (
        <div className="px-4 pb-2">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-neutral-500 font-mono tracking-wide">
            <span><span className="text-neutral-400">sliders</span> shape the sound</span>
            <span><span className="text-neutral-400">grid</span> tap to toggle, double-tap for accent</span>
            <span><span className="text-neutral-400">ctrl+z</span> undo</span>
          </div>
        </div>
      )}

      {/* ── Surreal Controls ── */}
      <div className="mx-4 mb-3 border-t border-neutral-800/50" />
      <div className="px-4 pb-3">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-x-4 gap-y-1">
          <SurrealSlider
            label="Grotesqueness"
            sublabel="distortion / detuning / harmonic chaos"
            value={pattern.surreal.grotesqueness}
            onChange={(v) => updateSurreal("grotesqueness", v)}
            color="#ff3322"
          />
          <SurrealSlider
            label="Inst. Decay"
            sublabel="lo-fi degradation / filter sweep"
            value={pattern.surreal.institutionalDecay}
            onChange={(v) => updateSurreal("institutionalDecay", v)}
            color="#aa66ff"
          />
          <SurrealSlider
            label="Digital Corruption"
            sublabel="glitch / stutter / pitch chaos"
            value={pattern.surreal.digitalCorruption}
            onChange={(v) => updateSurreal("digitalCorruption", v)}
            color="#00ff88"
          />
          <SurrealSlider
            label="Visceral Tension"
            sublabel="envelope sharpness / resonance"
            value={pattern.surreal.visceralTension}
            onChange={(v) => updateSurreal("visceralTension", v)}
            color="#ffaa00"
          />
          <SurrealSlider
            label="Cosmic Dread"
            sublabel="reverb / delay / pitch shift"
            value={pattern.surreal.cosmicDread}
            onChange={(v) => updateSurreal("cosmicDread", v)}
            color="#4488ff"
          />
        </div>
      </div>

      {/* ── Drum Sequencer ── */}
      <div className="mx-4 mb-2 border-t border-neutral-800/50" />
      <div className="px-4 pb-2">
        <div className="flex items-center gap-3 mb-2">
          <button
            type="button"
            onClick={() => setShowDrums(!showDrums)}
            className="flex items-center gap-2 text-[11px] font-bold tracking-[0.2em] uppercase text-neutral-400 cursor-default"
          >
            {showDrums ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            DRUM MACHINE
          </button>
          {showDrums && (<>
            <span className="text-[9px] text-neutral-600 italic">8 steps (loops 2x per bar) · hold for accent</span>
            <button
              type="button"
              onClick={randomizeDrumsInline}
              className="ml-auto p-1 rounded bg-neutral-800 hover:bg-neutral-700 transition-colors cursor-default"
              title="Randomize drums"
              style={{ color: colorScheme.accent }}
            >
              <Dice5 size={12} />
            </button>
          </>)}
        </div>

        {showDrums && (
          <div className="space-y-[2px] overflow-hidden" style={{ maxWidth: "100%" }}>
            <div className="flex items-center gap-[2px]">
              <div className="w-10 flex-shrink-0" />
              <div className="w-8 flex-shrink-0" />
              {Array.from({ length: pattern.drumTracks[0]?.steps.length ?? 8 }, (_, i) => (
                <div
                  key={i}
                  className={`flex-1 text-center text-[8px] font-mono min-w-0 ${
                    (currentStep % (pattern.drumTracks[0]?.steps.length ?? 8)) === i && isPlaying ? "text-white" : "text-neutral-700"
                  }`}
                >
                  {i + 1}
                </div>
              ))}
            </div>
            {pattern.drumTracks.map((track, trackIdx) => (
              <div key={trackIdx} className="flex items-center gap-[2px]">
                <button
                  type="button"
                  onClick={() => toggleDrumMute(trackIdx)}
                  className={`w-10 flex-shrink-0 text-[9px] font-bold tracking-wider text-left px-1 py-0.5 rounded cursor-default transition-colors ${
                    track.muted ? "text-neutral-700 line-through" : ""
                  }`}
                  style={{ color: track.muted ? undefined : drumColors[trackIdx] }}
                >
                  {track.name}
                </button>
                <input
                  type="range"
                  min={0} max={1} step={0.05}
                  value={track.volume}
                  onChange={(e) => setDrumVolume(trackIdx, parseFloat(e.target.value))}
                  className="w-8 h-3 flex-shrink-0 accent-neutral-500 opacity-40 hover:opacity-80 transition-opacity cursor-default"
                  title={`Volume: ${Math.round(track.volume * 100)}%`}
                  style={{ accentColor: drumColors[trackIdx] }}
                />
                {track.steps.map((step, stepIdx) => (
                  <div key={stepIdx} className="flex-1 min-w-0">
                    <DrumStepButton
                      step={step}
                      isCurrentStep={isPlaying && stepIdx === (currentStep % track.steps.length)}
                      beatGroup={Math.floor(stepIdx / 4)}
                      trackIdx={trackIdx}
                      stepIdx={stepIdx}
                      onToggleStep={toggleDrumStep}
                      onAccentStep={toggleDrumAccent}
                      color={drumColors[trackIdx] ?? colorScheme.accent}
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Melody Sequencer (Piano Roll) ── */}
      <div className="mx-4 mb-2 border-t border-neutral-800/50" />
      <div className="px-4 pb-4">
        {/* Melody header row */}
        <div className="flex items-center gap-3 mb-2">
          <button
            type="button"
            onClick={() => setShowMelody(!showMelody)}
            className="flex items-center gap-2 text-[11px] font-bold tracking-[0.2em] uppercase text-neutral-400 cursor-default"
          >
            {showMelody ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            MELODY
          </button>
          <button
            type="button"
            onClick={() => setPattern(prev => ({
              ...prev,
              melodyTrack: { ...prev.melodyTrack, muted: !prev.melodyTrack.muted },
            }))}
            className={`text-[9px] font-bold tracking-wider px-2 py-0.5 rounded cursor-default ${
              pattern.melodyTrack.muted ? "text-neutral-700 bg-neutral-900" : "text-cyan-400 bg-cyan-900/30"
            }`}
          >
            {pattern.melodyTrack.muted ? "MUTED" : "ON"}
          </button>
          <button
            type="button"
            onClick={randomizeMelodyInline}
            className="ml-auto p-1 rounded bg-neutral-800 hover:bg-neutral-700 transition-colors cursor-default"
            title="Randomize melody"
            style={{ color: colorScheme.accent }}
          >
            <Dice5 size={12} />
          </button>
        </div>

        {/* Melody toolbar */}
        {showMelody && (
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            {/* Edit mode */}
            <div className="flex gap-1 border border-neutral-800 rounded p-0.5">
              <button
                type="button"
                onClick={() => setEditMode("note")}
                className={`flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold tracking-wider uppercase cursor-default transition-all ${
                  editMode === "note" ? "bg-cyan-500/30 text-cyan-400" : "text-neutral-600"
                }`}
                title="Single note mode"
              >
                <Music size={10} /> NOTE
              </button>
              <button
                type="button"
                onClick={() => setEditMode("chord")}
                className={`flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold tracking-wider uppercase cursor-default transition-all ${
                  editMode === "chord" ? "bg-purple-500/30 text-purple-400" : "text-neutral-600"
                }`}
                title="Chord mode"
              >
                <Zap size={10} /> CHORD
              </button>
              <button
                type="button"
                onClick={() => setEditMode("tie")}
                className={`flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold tracking-wider uppercase cursor-default transition-all ${
                  editMode === "tie" ? "bg-amber-500/30 text-amber-400" : "text-neutral-600"
                }`}
                title="Tie mode — sustain previous note"
              >
                <Link size={10} /> TIE
              </button>
            </div>

            {/* Chord type */}
            <select
              value={chordType}
              onChange={(e) => setChordType(e.target.value as ChordType)}
              className="bg-neutral-900 border border-neutral-700 rounded px-2 py-0.5 text-[10px] font-mono"
            >
              {(Object.keys(CHORD_NAMES) as ChordType[]).map(ct => (
                <option key={ct} value={ct}>{CHORD_NAMES[ct]}</option>
              ))}
            </select>

            {/* Synth mode */}
            <div className="flex gap-0.5 border border-neutral-800 rounded p-0.5">
              {(Object.keys(SYNTH_MODE_NAMES) as SynthMode[]).map(mode => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setPattern(prev => ({ ...prev, synthMode: mode }))}
                  className={`px-2 py-0.5 rounded text-[9px] font-bold tracking-wider uppercase cursor-default transition-all ${
                    pattern.synthMode === mode ? "bg-cyan-900/40 text-cyan-400" : "text-neutral-600 hover:text-neutral-400"
                  }`}
                  title={`${SYNTH_MODE_NAMES[mode]} synthesis`}
                >
                  {SYNTH_MODE_NAMES[mode]}
                </button>
              ))}
            </div>

            {/* Divider */}
            <div className="w-px h-4 bg-neutral-800" />

            {/* Generators */}
            <div className="flex items-center gap-1">
              <select
                value={arpMode}
                onChange={(e) => setArpMode(e.target.value as ArpMode)}
                className="bg-neutral-900 border border-neutral-700 rounded px-2 py-0.5 text-[10px] font-mono"
              >
                {(Object.keys(ARP_NAMES) as ArpMode[]).map(am => (
                  <option key={am} value={am}>{ARP_NAMES[am]}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={generateArpPattern}
                className="px-2 py-0.5 rounded text-[9px] font-bold tracking-wider uppercase cursor-default transition-all bg-emerald-900/40 text-emerald-400 border border-emerald-800/50"
                title="Generate an arpeggiated melody pattern"
              >
                ARP
              </button>
            </div>

            {/* Divider */}
            <div className="w-px h-4 bg-neutral-800" />

            {/* Root note + Octave */}
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-neutral-600 font-bold tracking-wider">ROOT</span>
              <select
                value={pattern.rootNote % 12}
                onChange={(e) => {
                  const newPitchClass = parseInt(e.target.value);
                  const currentOctave = Math.floor(pattern.rootNote / 12);
                  setPattern(prev => ({ ...prev, rootNote: currentOctave * 12 + newPitchClass }));
                }}
                className="bg-neutral-800 text-[10px] text-neutral-300 rounded px-1 py-0.5 cursor-default border-none outline-none"
              >
                {NOTE_NAMES.map((name, i) => (
                  <option key={name} value={i}>{name}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setPattern(prev => ({ ...prev, rootNote: Math.max(24, prev.rootNote - 12) }))}
                className="px-1.5 py-0.5 text-[10px] bg-neutral-800 rounded cursor-default"
              >
                -
              </button>
              <span className="text-[10px] font-mono text-neutral-400 w-4 text-center">
                {Math.floor(pattern.rootNote / 12) - 1}
              </span>
              <button
                type="button"
                onClick={() => setPattern(prev => ({ ...prev, rootNote: Math.min(84, prev.rootNote + 12) }))}
                className="px-1.5 py-0.5 text-[10px] bg-neutral-800 rounded cursor-default"
              >
                +
              </button>
            </div>

            {/* Clear */}
            <button
              type="button"
              onClick={clearMelody}
              className="px-2 py-0.5 rounded text-[9px] font-bold tracking-wider uppercase cursor-default text-neutral-600 hover:text-red-400 transition-colors"
              title="Clear all melody notes"
            >
              CLR
            </button>
          </div>
        )}

        {showMelody && (
          <div className="overflow-hidden" style={{ maxWidth: "100%" }}>
            {/* Step info bar — shows note count or tie per step */}
            <div className="flex items-center gap-[1px] mb-[2px]">
              <div className="w-8 flex-shrink-0" />
              {stepNoteCount.map((info, i) => (
                <div
                  key={i}
                  className={`flex-1 text-center text-[7px] font-mono min-w-0 ${
                    i === currentStep && isPlaying ? "text-white" : info === "T" ? "text-amber-500/60" : info ? "text-cyan-500/60" : "text-neutral-800"
                  }`}
                >
                  {info || "\u00B7"}
                </div>
              ))}
            </div>

            <div
              className="melody-grid space-y-[1px] overflow-hidden rounded border border-neutral-800 p-1"
              style={{ "--current-step": isPlaying ? currentStep : -1 } as React.CSSProperties}
            >
              <style>{`.melody-grid .melody-step[data-step="${isPlaying ? currentStep : -1}"] { box-shadow: inset 0 0 0 1px rgba(103, 232, 249, 0.4); }`}</style>
              {melodyNotes.map(noteIdx => (
                <MelodyRow
                  key={noteIdx}
                  noteIndex={noteIdx}
                  noteName={noteName(noteIdx)}
                  fingerprint={melodyFingerprints.get(noteIdx) ?? ""}
                  steps={pattern.melodyTrack.steps}
                  onToggle={toggleMelodyStep}
                  isBlackKey={isBlackKey(noteIdx)}
                  editMode={editMode}
                  chordType={chordType}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      </>)}

      {/* ── Director View ── */}
      {appView === "director" && (
        <div className="px-4 py-6 max-w-lg mx-auto">
          {showHints && (
            <div className="pb-3">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] md:text-xs text-neutral-500 font-mono tracking-wide">
                <span><span className="text-neutral-400">sliders</span> each axis blends two extremes</span>
                <span><span className="text-neutral-400">center</span> = preset default</span>
              </div>
            </div>
          )}
          <div className="mb-6">
            <h2
              className="text-sm font-bold tracking-[0.3em] uppercase mb-1 font-['Share_Tech_Mono',monospace]"
              style={{ color: colorScheme.glow, textShadow: `0 0 12px ${colorScheme.glow}33` }}
            >
              DIRECTOR
            </h2>
            <p className="text-[11px] text-neutral-500 leading-relaxed">
              Shape the character of your sound. Each slider is a spectrum — find where your music lives.
            </p>
          </div>

          <div className="space-y-6">
            <DirectorSlider leftLabel="Maudlin" rightLabel="Irreverent" value={directorValues.mood}
              onChange={(v) => updateDirector("mood", v)}
              lowText="Heavy, dark, serious" midText="Balanced tone" highText="Bright, playful, light" />
            <DirectorSlider leftLabel="Pristine" rightLabel="Corroded" value={directorValues.fidelity}
              onChange={(v) => updateDirector("fidelity", v)}
              lowText="Crystal clear, digital, hi-fi" midText="Natural fidelity" highText="Worn, lo-fi, degraded" />
            <DirectorSlider leftLabel="Intimate" rightLabel="Cathedral" value={directorValues.space}
              onChange={(v) => updateDirector("space", v)}
              lowText="Close, dry, right here" midText="Natural room" highText="Vast, echoing, somewhere else" />
            <DirectorSlider leftLabel="Rigid" rightLabel="Elastic" value={directorValues.stability}
              onChange={(v) => updateDirector("stability", v)}
              lowText="Locked, precise, mechanical" midText="Steady but alive" highText="Wobbly, drifting, unpredictable" />
            <DirectorSlider leftLabel="Gentle" rightLabel="Violent" value={directorValues.intensity}
              onChange={(v) => updateDirector("intensity", v)}
              lowText="Soft, smooth, rounded" midText="Even-tempered" highText="Sharp, aggressive, biting" />
          </div>

          {/* Reset button */}
          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={() => {
                const reset = { mood: 0, fidelity: 0, space: 0, stability: 0, intensity: 0 };
                setDirectorValues(reset);
                applyDirectorValues(reset);
              }}
              className="px-4 py-2 rounded text-[10px] font-bold tracking-widest uppercase cursor-default text-neutral-600 border border-neutral-800 hover:text-neutral-400 hover:border-neutral-700 transition-all"
            >
              Reset sliders
            </button>
          </div>

          {/* Current surreal values readout */}
          <div className="mt-6 border-t border-neutral-800/50 pt-4">
            <div className="flex gap-3 justify-center flex-wrap">
              {(Object.entries(pattern.surreal) as [keyof SurrealParams, number][]).map(([key, val]) => (
                <div key={key} className="text-center">
                  <div className="text-[8px] text-neutral-700 tracking-wider uppercase">{key.replace(/([A-Z])/g, " $1").trim()}</div>
                  <div className="text-[10px] font-mono" style={{ color: `${colorScheme.glow}88` }}>{(val * 100).toFixed(0)}%</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Footer ── */}
      <div className="px-4 py-3 border-t border-neutral-800/30 flex items-center justify-between gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setShowGuide(true)}
          className="text-[9px] text-neutral-600 hover:text-neutral-400 cursor-default tracking-wider uppercase transition-colors"
        >
          How to play
        </button>
        <span className="text-[9px] text-neutral-700 tracking-wider">space = play/stop &nbsp; ctrl+z = undo</span>
      </div>

      {/* ── Welcome Guide ── */}
      {showGuide && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) { setShowGuide(false); try { localStorage.setItem("symphonia-guided", "1"); } catch {} } }}
        >
          <div className="bg-neutral-900 border border-neutral-700 rounded-lg p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto relative">
            <button
              type="button"
              onClick={() => { setShowGuide(false); try { localStorage.setItem("symphonia-guided", "1"); } catch {} }}
              className="absolute top-3 right-3 w-7 h-7 rounded-full bg-neutral-800 text-neutral-500 hover:text-white text-sm font-bold cursor-default transition-colors flex items-center justify-center"
            >
              &times;
            </button>
            <h2 className="text-xl font-bold tracking-[0.3em] uppercase mb-4 font-['Share_Tech_Mono',monospace]" style={{ color: colorScheme.glow }}>
              How to Play
            </h2>
            <div className="space-y-4 text-base text-neutral-400 leading-relaxed">
              <div>
                <span className="text-sm font-bold tracking-wider uppercase" style={{ color: colorScheme.accent }}>1. Pick a preset </span>
                Each preset sets the mood — tempo, scale, rhythm, and effects. Tap one to start.
              </div>
              <div>
                <span className="text-sm font-bold tracking-wider uppercase" style={{ color: colorScheme.accent }}>2. Hit play </span>
                Press the play button or spacebar. The pattern loops and the visuals come alive.
              </div>
              <div>
                <span className="text-sm font-bold tracking-wider uppercase" style={{ color: colorScheme.accent }}>3. Shape the sound </span>
                <strong className="text-neutral-300">Radial:</strong> Drag the center blob to warp effects. Tap flower petals for drums. Tap/drag the outer ring for melody.
              </div>
              <div>
                <span className="text-sm font-bold tracking-wider uppercase" style={{ color: colorScheme.accent }}>4. Go deeper </span>
                <strong className="text-neutral-300">Classic</strong> gives you a grid sequencer. <strong className="text-neutral-300">Director</strong> lets you shape the sound with personality sliders.
              </div>
              <div className="border-t border-neutral-800 pt-2 text-sm text-neutral-500">
                <span className="text-neutral-300">Space</span> play/stop &nbsp; <span className="text-neutral-300">?</span> hints &nbsp; <span className="text-neutral-300">Ctrl+Z</span> undo &nbsp; <span className="text-neutral-300">Long-press</span> accent
              </div>
            </div>
            <button
              type="button"
              onClick={() => { setShowGuide(false); try { localStorage.setItem("symphonia-guided", "1"); } catch {} }}
              className="w-full mt-5 py-3 rounded font-bold text-base tracking-wider uppercase cursor-default transition-all"
              style={{ backgroundColor: colorScheme.accent }}
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* ── Save Dialog ── */}
      {showSaveDialog && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) { setShowSaveDialog(false); setSaveName(""); } }}
        >
          <div className="bg-neutral-900 border border-neutral-700 rounded-lg p-6 w-full max-w-sm">
            <h2 className="text-sm font-bold tracking-wider uppercase mb-4" style={{ color: colorScheme.glow }}>
              Save Pattern
            </h2>
            <div className="relative mb-4">
              <input
                type="text"
                value={saveName}
                onChange={(e) => { if (e.target.value.length <= 40) setSaveName(e.target.value); }}
                placeholder="Name your creation..."
                className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm placeholder:text-neutral-600"
                maxLength={40}
                autoFocus
              />
              <span className="absolute right-2 bottom-[-18px] text-[9px] text-neutral-600">{saveName.length}/40</span>
            </div>
            {currentPatternId && (
              <p className="text-[10px] text-amber-500/70 mt-1">This will overwrite your current saved pattern.</p>
            )}
            <div className="flex gap-2 mt-4">
              <button
                type="button"
                onClick={() => {
                  if (saveName.trim()) {
                    saveMutation.mutate({ name: saveName.trim(), id: currentPatternId ?? undefined });
                  }
                }}
                disabled={!saveName.trim() || saveMutation.isPending}
                className="flex-1 py-2 rounded font-bold text-sm tracking-wider uppercase disabled:opacity-40 cursor-default"
                style={{ backgroundColor: colorScheme.accent }}
              >
                {saveMutation.isPending ? "Saving..." : currentPatternId ? "Overwrite" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => { setShowSaveDialog(false); setSaveName(""); }}
                className="flex-1 py-2 rounded bg-neutral-800 text-neutral-400 text-sm cursor-default"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Load Dialog ── */}
      {showLoadDialog && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) { setShowLoadDialog(false); setConfirmDeleteId(null); } }}
        >
          <div className="bg-neutral-900 border border-neutral-700 rounded-lg p-6 w-full max-w-sm max-h-[80vh] overflow-y-auto">
            <h2 className="text-sm font-bold tracking-wider uppercase mb-4" style={{ color: colorScheme.glow }}>
              Load Pattern
            </h2>
            {savedPatterns?.patterns && savedPatterns.patterns.length > 0 ? (
              <div className="space-y-2 mb-4">
                {savedPatterns.patterns.map(p => (
                  <div
                    key={p.id}
                    className="flex items-center gap-2 p-2 rounded bg-neutral-800 border border-neutral-700"
                  >
                    {confirmDeleteId === p.id ? (
                      <div className="flex-1 flex items-center gap-2">
                        <span className="text-[11px] text-red-400">Delete?</span>
                        <button
                          type="button"
                          onClick={() => { deleteMutation.mutate(p.id); setConfirmDeleteId(null); }}
                          className="px-2 py-0.5 rounded bg-red-900/50 text-red-400 text-[10px] font-bold cursor-default"
                        >
                          YES
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="px-2 py-0.5 rounded bg-neutral-700 text-neutral-400 text-[10px] font-bold cursor-default"
                        >
                          NO
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => loadMutation.mutate(p.id)}
                          className="flex-1 text-left text-sm font-medium cursor-default hover:text-white transition-colors truncate"
                        >
                          <span className="truncate block max-w-[180px]">{p.name}</span>
                          <span className="text-[10px] text-neutral-500 ml-2">{p.preset}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(p.id)}
                          className="p-1 text-neutral-600 hover:text-red-400 transition-colors cursor-default flex-shrink-0"
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-neutral-600 text-sm text-center py-8 mb-4">
                No saved patterns yet.
              </div>
            )}
            <button
              type="button"
              onClick={() => { setShowLoadDialog(false); setConfirmDeleteId(null); }}
              className="w-full py-2 rounded bg-neutral-800 text-neutral-400 text-sm cursor-default"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// App entry point (WidgetView removed — standalone app only)
// ──────────────────────────────────────────────
function _WidgetView_removed() {
  // Pick a random non-blank preset on mount
  const interestingPresets = PRESETS.filter(p => p.name !== "Blank Canvas");
  const [presetIdx, setPresetIdx] = useState(() => Math.floor(Math.random() * interestingPresets.length));
  const preset = interestingPresets[presetIdx] ?? interestingPresets[0]!;
  const [pattern, setPattern] = useState<PatternState>(() => applyPreset(preset.name));

  // Sequencer (shared hook)
  const { isPlaying, isPlayingRef, currentStep, handlePlay, handleStop } = useSequencer(pattern);

  // XY pad state (0-1 range)
  const [padX, setPadX] = useState(0.5);
  const [padY, setPadY] = useState(0.5);
  const padRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  // Map XY to surreal params
  const mapXYToSurreal = useCallback((x: number, y: number): SurrealParams => {
    const base = preset.defaultState?.surreal ?? createDefaultPattern().surreal;
    return {
      grotesqueness: Math.min(1, base.grotesqueness + x * 0.5),
      digitalCorruption: Math.min(1, base.digitalCorruption + x * 0.35),
      cosmicDread: Math.min(1, base.cosmicDread + y * 0.5),
      institutionalDecay: Math.min(1, base.institutionalDecay + y * 0.4),
      visceralTension: Math.min(1, base.visceralTension + Math.sqrt(x * x + y * y) * 0.3),
    };
  }, [preset]);

  const handleToggle = useCallback(async () => {
    if (isPlaying) handleStop();
    else await handlePlay();
  }, [isPlaying, handlePlay, handleStop]);

  // Shuffle preset
  const handleShuffle = useCallback(() => {
    const wasPlaying = isPlayingRef.current;
    if (wasPlaying) handleStop();
    const newIdx = (presetIdx + 1 + Math.floor(Math.random() * (interestingPresets.length - 1))) % interestingPresets.length;
    setPresetIdx(newIdx);
    const newPreset = interestingPresets[newIdx]!;
    const newPattern = applyPreset(newPreset.name);
    setPattern(newPattern);
    setPadX(0.5);
    setPadY(0.5);
    console.log("Widget: shuffled to preset:", newPreset.name);
  }, [presetIdx, interestingPresets, handleStop, isPlayingRef]);

  // XY pad touch/mouse handling
  const updatePad = useCallback((clientX: number, clientY: number) => {
    const el = padRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    setPadX(x);
    setPadY(y);
    const surreal = mapXYToSurreal(x, y);
    setPattern(prev => ({ ...prev, surreal }));
    if (engine.isReady) engine.updateSurrealParams(surreal);
  }, [mapXYToSurreal]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    isDragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    updatePad(e.clientX, e.clientY);
  }, [updatePad]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    if (!isDragging.current) return;
    updatePad(e.clientX, e.clientY);
  }, [updatePad]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    isDragging.current = false;
  }, []);

  // Step indicator dots
  const stepDots = useMemo(() => {
    const dots = [];
    for (let i = 0; i < 8; i++) {
      const isActive = currentStep >= 0 && (currentStep % 8) === i;
      dots.push(
        <div
          key={i}
          className="rounded-full transition-all duration-75"
          style={{
            width: 6, height: 6,
            backgroundColor: isActive ? preset.colorScheme.glow : `${preset.colorScheme.accent}44`,
            boxShadow: isActive ? `0 0 6px ${preset.colorScheme.glow}` : "none",
          }}
        />
      );
    }
    return dots;
  }, [currentStep, preset.colorScheme]);

  return (
    <div
      className="flex flex-col w-full h-full p-3 select-none overflow-hidden"
      style={{ backgroundColor: preset.colorScheme.bg }}
    >
      {/* Fonts loaded via document.head link in Groovebox */}

      {/* Header: title + shuffle */}
      <div className="flex items-center justify-between mb-2">
        <div
          className="text-[10px] font-bold tracking-[0.2em] uppercase font-['Share_Tech_Mono',monospace]"
          style={{ color: preset.colorScheme.glow, textShadow: `0 0 10px ${preset.colorScheme.glow}44` }}
        >
          SYMPHONIA
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); handleShuffle(); }}
          className="p-1 rounded cursor-default opacity-60 active:opacity-100 transition-opacity"
          style={{ color: preset.colorScheme.glow }}
          title="Random preset"
        >
          <Shuffle size={14} />
        </button>
      </div>

      {/* Preset name */}
      <div
        className="text-[9px] tracking-widest uppercase mb-2 font-['Share_Tech_Mono',monospace] opacity-50"
        style={{ color: preset.colorScheme.glow }}
      >
        {preset.name}
      </div>

      {/* XY Pad — main interaction area */}
      <div
        ref={padRef}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onTouchStart={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
        onTouchEnd={(e) => e.stopPropagation()}
        className="relative flex-1 rounded border cursor-default touch-none"
        style={{
          borderColor: `${preset.colorScheme.accent}55`,
          background: `radial-gradient(circle at ${padX * 100}% ${padY * 100}%, ${preset.colorScheme.accent}22 0%, transparent 60%)`,
          minHeight: 80,
        }}
      >
        {/* Axis labels */}
        <div className="absolute bottom-1 right-1 text-[7px] font-['Share_Tech_Mono',monospace] opacity-30" style={{ color: preset.colorScheme.glow }}>
          chaos →
        </div>
        <div className="absolute bottom-1 left-1 text-[7px] font-['Share_Tech_Mono',monospace] opacity-30 rotate-[-90deg] origin-bottom-left translate-y-[-10px]" style={{ color: preset.colorScheme.glow }}>
          dread →
        </div>
        {/* Crosshairs */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden rounded">
          <div
            className="absolute top-0 bottom-0 w-px opacity-15"
            style={{ left: `${padX * 100}%`, backgroundColor: preset.colorScheme.glow }}
          />
          <div
            className="absolute left-0 right-0 h-px opacity-15"
            style={{ top: `${padY * 100}%`, backgroundColor: preset.colorScheme.glow }}
          />
        </div>
        {/* Draggable dot */}
        <div
          className="absolute rounded-full pointer-events-none transition-shadow"
          style={{
            width: 20, height: 20,
            left: `calc(${padX * 100}% - 10px)`,
            top: `calc(${padY * 100}% - 10px)`,
            backgroundColor: preset.colorScheme.accent,
            boxShadow: `0 0 12px ${preset.colorScheme.glow}, 0 0 24px ${preset.colorScheme.accent}66`,
            border: `1px solid ${preset.colorScheme.glow}88`,
          }}
        />
      </div>

      {/* Step indicator + transport */}
      <div className="flex items-center gap-2 mt-2 min-w-0">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); handleToggle(); }}
          className="flex items-center justify-center rounded cursor-default transition-colors"
          style={{
            width: 28, height: 28,
            backgroundColor: isPlaying ? "#ff2200" : preset.colorScheme.accent,
            boxShadow: `0 0 8px ${isPlaying ? "#ff220044" : preset.colorScheme.glow}44`,
            color: "#fff",
          }}
        >
          {isPlaying ? <Square size={12} /> : <Play size={12} />}
        </button>
        <div className="flex gap-1 items-center flex-1 justify-center min-w-0 overflow-hidden">
          {stepDots}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// App entry point
// ──────────────────────────────────────────────
// Load fonts once at the app level so both Groovebox and WidgetView get them
function FontLoader() {
  useEffect(() => {
    const fontUrl = "https://fonts.googleapis.com/css2?family=Rajdhani:wght@300;400;500;600;700&family=Share+Tech+Mono&display=swap";
    if (!document.querySelector(`link[href="${fontUrl}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = fontUrl;
      document.head.appendChild(link);
    }
  }, []);
  return null;
}

const appQueryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={appQueryClient}>
      <FontLoader />
      <Groovebox />
    </QueryClientProvider>
  );
}
