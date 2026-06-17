# Nyx-Step DAW — Single-Instrument Generate-onto-Track — Design

**Date:** 2026-06-17
**Status:** Approved (design)
**Component:** "Generate onto track" in the 🎚 DAW tab
**Builds on:** DAW phases 1–6 + snap/stretch; `/generate` (accepts `negative_tags`), `/stems/demucs/stream` (Demucs).

---

## Problem

Generating onto a DAW track currently posts only the raw `tags` to `/generate`
(`dawGenerateOntoTrack` in `static/daw-ai.js`). ACE-Step responds with a full arrangement, so
asking for "Analog warm lead" yields a track with drums, bass, and more. The user wants a
single-instrument (or single-voice) result: only the requested source on that track.

## Approach (chosen: C — both, with a checkbox)

1. **Always (strategy A):** augment the positive tags with isolation cues and set `negative_tags`
   to suppress the other instrument/voice families, per a **Type** the user selects. Same speed,
   one generation. `/generate` already wires `negative_tags` into KSampler negative conditioning
   (`_apply_negative_tags` in `core/comfyui.py`).
2. **Optional (strategy C):** an **Isolate (stem-split after)** checkbox. When on, after the
   generated file returns, run Demucs on it and place **only the matching stem** on the track —
   guaranteed single-source. Falls back to the full clip if the stem is absent.

### Out of scope
Changing the main Generate tab; new backend endpoints; arbitrary-instrument stem separation beyond
Demucs's four stems; multi-stem placement (isolate keeps exactly one).

---

## UI — Generate-onto-track dialog (`openGenerateDialog`)

Add to the existing dialog (tags input + duration):
- **Type** `<select>`: `instrument` (default) / `vocals` / `drums` / `bass`.
- **🔪 Isolate (stem-split after)** checkbox, default **off**.
- **Vocal auto-detect:** on tags `input`, if the (lowercased) tags match
  `/\b(vocal|vocals|voice|sing|singer|sung|choir|vox|rap|rapping|a ?cappella|soprano|alto|tenor|falsetto)\b/`
  and the user hasn't manually changed Type, set Type to `vocals`. (Track a `userPickedType` flag so
  auto-detect never overrides a manual choice.)

The **Generate** button calls `dawGenerateOntoTrack(trackId, tags, duration, type, isolate)`.

---

## Conditioning maps (`daw-ai.js` constant)

```javascript
const _DAW_GEN_ISOLATION = {
  instrument: { add: "solo, single instrument, isolated, no accompaniment, dry",
                neg: "drums, percussion, bass, vocals, choir, full band, ensemble", stem: "other" },
  vocals:     { add: "a cappella, solo vocal, isolated vocal, dry vocal, no instruments",
                neg: "instruments, drums, bass, guitar, piano, synth, music", stem: "vocals" },
  drums:      { add: "solo drums, drum solo, drums only, isolated",
                neg: "vocals, bass, guitar, piano, synth, melody, harmony", stem: "drums" },
  bass:       { add: "solo bass, bass only, isolated bassline",
                neg: "drums, percussion, vocals, guitar, piano, synth, melody", stem: "bass" },
};
```

`dawGenerateOntoTrack` builds:
- `fullTags = tags + ", " + iso.add`
- POST `/generate` body adds `negative_tags: iso.neg` (alongside existing `tags: fullTags, duration,
  bpm, song_name`).

---

## Isolate flow (`daw-ai.js`)

When `isolate` is true, after `dawRunJob` returns the generated `file`:
1. Run the Demucs stream: `new EventSource("/stems/demucs/stream?filename=" +
   encodeURIComponent(file) + "&model=htdemucs")` (same pattern as `dawSplitToStems`).
2. On `done`: build `stemFile = "separated/htdemucs/" + file.replace(/\.[^.]+$/, "") + "/" + iso.stem + ".mp3"`.
   If `dawGetBuffer(stemFile)` resolves, place that as the clip; else place the full `file`.
3. On error / no stem: fall back to the full generated `file` (never leave the track empty).

When `isolate` is false, place the generated `file` directly (current behaviour) — now already
mostly-isolated by the conditioning.

Status messages via `_dawSetSaveStatus` ("Generating…", "Isolating…", "Track ready ✓" / failure).
The track shows the busy indicator (`_dawGenTracks`) during the whole flow, as today.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `static/daw-ai.js` | modify | dialog Type/isolate + vocal auto-detect; `_DAW_GEN_ISOLATION`; augmented `dawGenerateOntoTrack`; post-gen single-stem isolate |
| `templates/index.html` | modify | cache-bust `daw-ai.js` |

No backend changes.

---

## Edge Cases

| Case | Handling |
|---|---|
| Tags already contain a vocal word | Type auto-selects Vocals (unless user picked another) |
| User manually sets Type | `userPickedType` flag stops auto-detect from overriding |
| Isolate on, stem missing/Demucs fails | Fall back to the full generated clip; status notes it |
| Generation fails | Existing failure handling; track indicator cleared |
| Generated file already a stem path | N/A (always a fresh generation) |
| Empty tags | Generate button stays disabled (existing behaviour) |

---

## Testing

**Live Playwright:** stub `window.fetch` for `/generate` to capture the outgoing body, then drive the
dialog:
- Type Instrument + "analog warm lead" → captured body `tags` ends with the instrument `add` cues and
  `negative_tags` equals the instrument `neg` set.
- Type-in "female vocals" → Type auto-flips to `vocals`; captured `negative_tags` is the vocal set and
  `tags` carries the vocal `add` cues.
- Manually pick Drums then type a vocal word → Type stays Drums (no override).
- Isolate checkbox present and its state reaches `dawGenerateOntoTrack` (assert via a captured call).
- One real end-to-end generate (Instrument, isolate off) to confirm a clip lands and plays; no
  `pageerror`s. `python3 -m pytest tests/ -q` stays green (unchanged).

---

## Success Criteria

Generating onto a track produces only the requested instrument or voice: tags are augmented with
isolation cues and the model is negatively conditioned against the other families every time, with an
optional one-stem Demucs isolation for a hard guarantee. A vocals request yields vocals only; an
instrument request never comes back as a full multi-part mix.
