# Nyx-Step DAW — Phase 4: Export (Bounce to WAV) — Design

**Date:** 2026-06-15
**Status:** Approved (design)
**Component:** Arrangement export in the 🎚 DAW tab (music-ai.nyxstudios.net)
**Builds on:** Phases 1–3 (Arranger, Mixer, Wave Editor)

---

## Context

The DAW plays a multi-track arrangement through a Web Audio graph: per clip
`BufferSource → clipGain (gain + fade envelope) → trackChain.gain → pan → analyser → master →
masterAnalyser → destination`, with mute/solo applied as track gains and a master volume. Everything
needed to reproduce a mix already lives in `dawState` and in `_dawScheduleClipEnvelope`.

Phase 4 adds **Export**: render the whole arrangement to a single mixed audio file the user can
download. It re-runs the same graph on an `OfflineAudioContext` so the bounce is sample-for-sample
what playback produces.

### Locked decisions (brainstorming)
1. **Render engine:** client-side `OfflineAudioContext` (exact parity, reuses the live graph logic) —
   not a server-side ffmpeg re-mix (which would duplicate the engine and risk drift).
2. **Output format:** WAV only (16-bit PCM), encoded in the browser. No backend.
3. **Destination:** download to the browser (blob). No save-to-library.
4. **Scope:** the whole arrangement (`0 → dawArrangementLength()`). No region/loop-range selection
   (there is no selection UI).

### Out of scope (future)
MP3/FLAC transcode (a later "send rendered bytes to a server ffmpeg endpoint" add), save-to-library
(pairs with that endpoint), region/selection export, stem export (per-track bounce), normalize-on-export.

---

## Architecture

All client-side. New module `static/daw-export.js` with three functions; one button wired in
`static/daw.js`; markup in `templates/index.html`. No backend, no API, no new server tests.

```
dawExportWav()              (glue: render → encode → download, with status)
  → dawRenderArrangement()  (async → AudioBuffer; offline render of the whole graph)
  → _dawAudioBufferToWav()  (AudioBuffer → 16-bit PCM WAV Blob)
```

### `dawRenderArrangement()` → `AudioBuffer | null`
1. `const len = dawArrangementLength();` if `len <= 0` return `null` (nothing to export).
2. `_dawEnsureCtx();` then `const sr = _dawCtx.sampleRate;` — use the live context's rate so the
   already-decoded clip buffers play without resampling (AudioBuffers are not context-bound; matching
   the rate guarantees exact reproduction).
3. Preload buffers: gather the unique `clip.file` set across all tracks/clips and
   `await Promise.all([...files].map(dawGetBuffer))`. Clips whose buffer is missing/errored are
   skipped during scheduling (same as live).
4. `const off = new OfflineAudioContext(2, Math.ceil(len * sr), sr);`
5. Master: `const master = off.createGain(); master.gain.value = dawState.master_volume ?? 1;
   master.connect(off.destination);` (no analyser — metering isn't needed offline).
6. Mute/solo rule (identical to `_dawApplyMixState`): `const anySolo = dawState.tracks.some(t => t.solo);`
   a track is audible if `anySolo ? track.solo : !track.mute`.
7. Per track: `const tg = off.createGain(); tg.gain.value = audible ? (track.volume ?? 1) : 0;
   const pan = off.createStereoPanner(); pan.pan.value = track.pan ?? 0; tg.connect(pan); pan.connect(master);`
8. Per clip (skip if buffer missing/errored):
   ```
   const src = off.createBufferSource(); src.buffer = buf;
   const cg = off.createGain(); src.connect(cg); cg.connect(tg);
   _dawScheduleClipEnvelope(cg, clip.start, 0, clip.duration, clip.gain ?? 1, clip.fade_in ?? 0, clip.fade_out ?? 0);
   src.start(clip.start, clip.offset, clip.duration);
   ```
   (Offline render plays from time 0, so `when = clip.start` and `localStart = 0` — no straddle case.)
9. `return await off.startRendering();`

`_dawScheduleClipEnvelope` is reused verbatim — it only schedules ramps on the passed GainNode at
numeric times, so it works on offline-context nodes unchanged.

### `_dawAudioBufferToWav(buf)` → `Blob`
Standard 16-bit PCM WAV. Interleave the (up to 2) channels, clamp samples to [−1, 1], scale to
int16, write the 44-byte RIFF/WAVE/fmt /data header (PCM, numChannels from `buf.numberOfChannels`,
sampleRate from `buf.sampleRate`, 16 bits), return `new Blob([headerAndData], { type: "audio/wav" })`.

### `dawExportWav()` (glue)
- Set the export button disabled + label "Rendering…".
- `const rendered = await dawRenderArrangement();`
- If `null` → toast/status "Nothing to export — add some clips first"; restore button; return.
- `const blob = _dawAudioBufferToWav(rendered);`
- Download: create an `<a>` with `href = URL.createObjectURL(blob)`, `download = (dawState.name || "mix") + ".wav"`, click it, revoke the URL.
- Status "Exported ✓"; restore the button.
- Wrap in try/catch → on error, status "Export failed: <message>", restore button.

---

## UI

A single **⬇ Export WAV** button in the DAW transport bar (`#daw-transport`), placed next to the
🎚 Mixer toggle. `id="daw-export"`. While rendering: `disabled = true`, text "Rendering…"; restored
to "⬇ Export WAV" when done. Status/result piggybacks on the existing `#daw-save-status` text area
(or the button label) — no new status element required.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `static/daw-export.js` | **create** | `dawRenderArrangement`, `_dawAudioBufferToWav`, `dawExportWav` |
| `static/daw.js` | modify | wire the `#daw-export` button to `dawExportWav` |
| `templates/index.html` | modify | Export button in transport + `daw-export.js` script tag + cache-bust |

`daw-export.js` loads after `daw-engine.js` (uses `_dawEnsureCtx`, `_dawCtx`, `dawGetBuffer`,
`_dawScheduleClipEnvelope`) and after `daw-project.js` (uses `dawState`, `dawArrangementLength`),
and before `daw.js` (which wires the button).

---

## Edge Cases

| Case | Handling |
|---|---|
| Empty arrangement (`len <= 0`) | `dawRenderArrangement` returns null; `dawExportWav` toasts "Nothing to export"; no download |
| Clip buffer missing/errored | Skipped in scheduling (same as live); render still completes |
| Muted / not-soloed track | Track gain 0 in the offline graph → excluded from the mix |
| Very long arrangement | `OfflineAudioContext` renders faster than real-time; button disabled meanwhile; within browser memory limits for typical songs |
| Mono vs stereo source clips | Web Audio up-mixes mono sources to the 2-channel offline context automatically |
| Export while playing | Offline render is independent of the live context; live playback is unaffected (separate context) |
| Loaded clip without gain/fade fields | `?? ` defaults (gain 1, fades 0) — same as engine |
| Project never played (no `_dawCtx`) | `_dawEnsureCtx()` creates it first so `sr` and decoded buffers are consistent |

---

## Testing

No backend changes → no new pytest. Frontend verified live with Playwright on Nyx:
- Build an arrangement (≥1 track, ≥1 clip), click **⬇ Export WAV**, capture the browser download.
- Assert the downloaded file: starts with `RIFF`…`WAVE` (valid WAV header), non-trivial size
  (> 1 KB), and decoded duration ≈ `dawArrangementLength()` (± a small tolerance).
- Mute a track, export again → render still completes and produces a valid WAV (content-level muting
  is asserted structurally: the render succeeds and duration matches; a fully-muted single-track
  project yields near-silent samples — assert max abs sample ≈ 0).
- Empty project → clicking Export produces no download and shows the "Nothing to export" status.
- No `pageerror`s throughout.

---

## Success Criteria

From the DAW tab, a user clicks one button and downloads a WAV that is the exact mixdown of their
arrangement — clip trims, per-clip gain and fades, track volume/pan, mute/solo, and master volume all
applied — because it is rendered through the same Web Audio graph as playback, offline. The export
path is self-contained (one module, one button, no backend), leaving room for a later MP3/FLAC +
save-to-library follow-up that reuses the rendered buffer.
