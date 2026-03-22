# Symphonia

Browser-based music groovebox at symphonia.blog. Pure static site — no server, no database.

## Stack

- **Runtime:** Bun
- **Framework:** React 19 + TypeScript (strict)
- **Build:** Vite 6
- **Styling:** Tailwind CSS v4 (via `@tailwindcss/vite` plugin)
- **State:** TanStack React Query
- **Hosting:** Vercel (auto-deploys on push to `main`)
- **Domain:** symphonia.blog (DNS managed by Vercel)

## Commands

```bash
bun run dev        # Local dev server
bun run build      # Production build → dist/
bun run typecheck  # TypeScript check only
bun run preview    # Preview production build locally
```

## Key Files

| File | Purpose |
|---|---|
| `src/App.tsx` | Entire UI (~3,900 lines). Read in sections, not all at once. |
| `src/audio-engine.ts` | Web Audio graph: drum synthesis, 3 synth modes, effects chain |
| `src/useSequencer.ts` | Playback hook: lookahead scheduler, swing, ghost notes |
| `src/pattern-store.ts` | localStorage save/load (replaces old server DB) |
| `src/presets.ts` | 6 built-in presets + color scheme helpers |
| `src/types.ts` | All shared types: PatternState, SurrealParams, DrumTrack, etc. |
| `src/helpers.ts` | Music theory: scales, chords, arpeggios, Euclidean rhythm |
| `src/url-sharing.ts` | Compact base64 URL encoding of full pattern state |
| `src/export-utils.ts` | WAV and MIDI export |
| `src/audio-context.tsx` | Singleton AudioEngine instance |

## Architecture

Everything runs client-side. No server.

```
App.tsx (UI)
  ├── useSequencer (timing/scheduling)
  │     └── AudioEngine (Web Audio graph, synthesis, effects)
  └── pattern-store (localStorage — save/load patterns)
```

## Pattern Persistence

Patterns are stored in `localStorage` under the key `symphonia_patterns` as a JSON array. No user accounts, no server. `src/pattern-store.ts` exposes `listPatterns`, `getPattern`, `savePattern`, `deletePattern`.

## Making Changes

**Adding state to PatternState:**
1. Update `src/types.ts`
2. Update `src/url-sharing.ts` (encode/decode)
3. Update `src/presets.ts` (defaults for each preset)

**Adding a preset:**
1. Add to `src/presets.ts` with full `PatternState` + color scheme
2. The preset bar in `App.tsx` picks it up automatically

**Changing audio:**
- `src/audio-engine.ts` owns the Web Audio graph
- `src/useSequencer.ts` owns timing/scheduling
- Keep these concerns separate

**App.tsx is ~3,900 lines** — read it in sections. The main component is `Groovebox`. Key internal sections: header (~2572), transport (~2778), presets (~2915), radial view (~2977), classic view, director view, footer (~3435), dialogs (~3447).

## Surreal Parameter Mapping

The 5 "emotional" parameters (0–1 range) map to real synthesis values:

| Parameter | Maps to |
|---|---|
| `grotesqueness` | detune, harmonic spread, waveform mixing |
| `institutionalDecay` | filter cutoff, bitcrusher depth |
| `digitalCorruption` | glitch probability, stutter, pitch randomization |
| `visceralTension` | envelope attack, resonance, compression ratio |
| `cosmicDread` | reverb size, delay feedback (capped 0.55), pitch shift |

## Deployment

Push to `main` → Vercel auto-deploys. No staging environment. Check the Vercel dashboard for build logs if something goes wrong.

## Gotchas

- `App.tsx` is large — read it in sections, not all at once
- `ScriptProcessorNode` (WAV export) is deprecated but has no replacement with equivalent raw PCM access
- LFO modulation must pick up current base values each cycle or it overwrites user changes
- BPM is a slider, not a text input
- `emptyMelodyStep` helper lives in `types.ts` — don't duplicate it
- Memoization comparators in `App.tsx` must include all relevant props or renders go stale
- The "Scratchpad" concept: editing Blank Canvas turns it into Scratchpad, upgrades to a named preset on save
- Tailwind v4 via Vite plugin — no `tailwind.config.js` needed, it auto-scans all files
- SVG `fontSize` attributes are in SVG coordinate units, not screen pixels — don't scale them with Tailwind
