import { useState, useRef, useCallback, useEffect } from "react";
import type { PatternState } from "./types";
import { DRUM_VOICES } from "./types";
import { engine } from "./audio-context";
import { midiToFreq } from "./helpers";

const SCHEDULE_AHEAD_TIME = 0.1; // seconds to schedule ahead
const LOOKAHEAD_MS = 25; // how often to check (ms)

interface SequencerResult {
  isPlaying: boolean;
  isPlayingRef: React.RefObject<boolean>;
  currentStep: number;
  currentStepRef: React.RefObject<number>;
  beatPulse: number;
  handlePlay: () => Promise<void>;
  handleStop: () => void;
}

export function useSequencer(
  pattern: PatternState,
): SequencerResult {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentStep, setCurrentStep] = useState(-1);
  const [beatPulse, setBeatPulse] = useState(0);

  const patternRef = useRef(pattern);
  const isPlayingRef = useRef(false);
  const stepRef = useRef(-1);
  const nextStepTimeRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const beatPulseRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const rafScheduled = useRef(false);

  // Keep pattern ref in sync
  useEffect(() => {
    patternRef.current = pattern;
  }, [pattern]);

  const scheduleStep = useCallback((step: number, time: number) => {
    const p = patternRef.current;
    const surreal = p.surreal;

    // Surreal rhythm effects:
    // Digital Corruption → probabilistic drum ghost notes (skip hits randomly)
    const ghostProb = surreal.digitalCorruption * 0.25; // up to 25% chance to ghost a hit
    // Cosmic Dread → micro-timing drift (subtle humanization, ±ms)
    const driftRange = surreal.cosmicDread * 0.012; // up to ±12ms of drift

    // Play drum sounds at the precise scheduled time
    for (let t = 0; t < p.drumTracks.length; t++) {
      const track = p.drumTracks[t];
      if (!track || track.muted) continue;
      const drumStep = step % track.steps.length;
      const s = track.steps[drumStep];
      if (!s || !s.active) continue;
      // Digital corruption: randomly ghost (skip) drum hits
      if (ghostProb > 0 && Math.random() < ghostProb) continue;
      const voice = DRUM_VOICES[t];
      if (voice) {
        // Cosmic dread: micro-timing drift for each hit (clamped to never go negative)
        const drift = driftRange > 0 ? (Math.random() - 0.5) * driftRange : 0;
        engine.playDrum(voice.voice, s.velocity * track.volume, s.accent, Math.max(0, time + drift));
      }
    }

    // Play melody at the precise scheduled time
    if (!p.melodyTrack.muted) {
      const melStep = p.melodyTrack.steps[step];
      if (melStep && melStep.active && !melStep.tie) {
        const notesToPlay = melStep.notes;
        if (notesToPlay.length > 0) {
          let tiedSteps = 0;
          for (let j = 1; j < p.stepsPerBar; j++) {
            const idx = (step + j) % p.stepsPerBar;
            const nextStep = p.melodyTrack.steps[idx];
            if (nextStep && nextStep.active && nextStep.tie) {
              tiedSteps++;
            } else {
              break;
            }
          }
          const stepDuration = 60 / p.tempo / 4;
          const totalDuration = stepDuration * (1 + tiedSteps) * 0.9;
          const freqs = notesToPlay.map(midiToFreq);
          engine.playNotes(freqs, totalDuration, melStep.velocity * p.melodyTrack.volume, melStep.slide, time, p.synthMode);
        }
      }
    }
  }, []);

  const scheduler = useCallback(() => {
    if (!isPlayingRef.current) return;
    const p = patternRef.current;

    while (nextStepTimeRef.current < engine.currentTime + SCHEDULE_AHEAD_TIME) {
      const step = (stepRef.current + 1) % p.stepsPerBar;
      stepRef.current = step;

      scheduleStep(step, nextStepTimeRef.current);

      // Batch visual updates to animation frame rate to avoid per-step re-renders
      const pulse = step % 4 === 0 ? 1 : 0.3;
      beatPulseRef.current = pulse;
      if (!rafScheduled.current) {
        rafScheduled.current = true;
        rafRef.current = requestAnimationFrame(() => {
          rafScheduled.current = false;
          setCurrentStep(stepRef.current);
          setBeatPulse(beatPulseRef.current);
        });
      }

      // Advance to next step time with swing
      // Swing delays odd steps: lengthen the interval FROM even TO odd (step%2===0 → next is odd)
      // Visceral Tension modulates swing: high tension = tighter (less swing), low = looser
      const baseInterval = 60 / p.tempo / 4;
      const tensionSwingMod = 1 - p.surreal.visceralTension * 0.4; // 1.0 at 0 tension, 0.6 at max
      const swingOffset = step % 2 === 0 ? p.swing * baseInterval * 0.33 * tensionSwingMod : 0;
      nextStepTimeRef.current += baseInterval + swingOffset;
    }
  }, [scheduleStep]);

  const handlePlay = useCallback(async () => {
    await engine.init();
    await engine.resume();
    engine.updateSurrealParams(patternRef.current.surreal);
    engine.setMasterVolume(patternRef.current.masterVolume);
    isPlayingRef.current = true;
    stepRef.current = -1;
    nextStepTimeRef.current = engine.currentTime;
    setIsPlaying(true);
    timerRef.current = setInterval(scheduler, LOOKAHEAD_MS);
    console.log("Sequencer: playback started, tempo:", patternRef.current.tempo);
  }, [scheduler]);

  const handleStop = useCallback(() => {
    isPlayingRef.current = false;
    setIsPlaying(false);
    stepRef.current = -1;
    setCurrentStep(-1);
    setBeatPulse(0);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      rafScheduled.current = false;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return { isPlaying, isPlayingRef, currentStep, currentStepRef: stepRef, beatPulse, handlePlay, handleStop };
}
