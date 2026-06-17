# DAW Snap-to-Grid + Time-Stretch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Snap clip placement/edges to a tempo grid, and let clips be time-stretched (varispeed by default, optional per-clip pitch-preserving) with playback and WAV export honoring both.

**Architecture:** A `_dawSnapSec` helper snaps drop/move/trim/stretch at the timeline interaction layer; a CSS gradient draws the grid. Clips gain `src_len` (source seconds used) so stretch ratio `r = duration/src_len` drives `playbackRate` in the engine. Pitch-lock pre-renders a stretched buffer via vendored SoundTouch.js, cached, with graceful varispeed fallback.

**Tech Stack:** vanilla JS, Web Audio (`playbackRate`, OfflineAudioContext), SoundTouch.js (vendored UMD), Playwright, pytest.

**Spec:** `docs/superpowers/specs/2026-06-17-daw-snap-stretch-design.md`

**Conventions:**
- Repo `/home/legion/legionprojects/nyx-step`, branch `master`. `node --check <file>` for JS. After JS/HTML change bump `?v=N` in `templates/index.html`.
- Restart: `sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health` (passwordless sudo). Tests: `python3 -m pytest tests/ -q` (baseline **89**).
- Commit per task; end messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do NOT push (controller finishes).
- Existing globals: `dawState`, `_dawFindClip`, `_dawAfterMutate`, `dawMarkDirty`, `renderTimeline`, `_dawPxPerSec`, `dawGetBuffer`, `_dawBufferCache`, `_dawEnsureCtx`, `_dawCtx`, `_dawScheduleClipEnvelope`, `dawRescheduleClips`, `_dawActiveSources`, `_dawStartCtxTime`, `_dawPlayhead`. Clip fields today: `id,file,name,start,offset,duration,source_duration,gain,fade_in,fade_out`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `tests/test_daw.py` | modify | persistence of snap/snap_res/src_len/pitch_lock |
| `static/daw-project.js` | modify | snap state + `_dawSnapSec`/`_dawSnapDiv`; clip defaults; `dawStretchClip`/`dawSetClipPitchLock`/`dawResetStretch`; `dawTrimClip` keeps `r` |
| `static/vendor/soundtouch.js` | create | vendored SoundTouch UMD (globals) |
| `static/daw-stretch.js` | create | `dawRenderStretch`/`dawStretchGet`/`dawInvalidateStretch` + cache |
| `static/daw-engine.js` | modify | scheduling `r`/`rate`, varispeed + pitch-lock buffer |
| `static/daw-timeline.js` | modify | grid background; snap drop/move; Alt-drag stretch vs trim |
| `static/daw-waveedit.js` | modify | clip-menu items |
| `static/daw-export.js` | modify | offline render honors `r` + pitch-lock |
| `static/daw.js` | modify | snap controls wiring |
| `templates/index.html` | modify | snap controls + scripts + cache-busts |

---

### Task 1: Backend persistence test

**Files:** Modify `tests/test_daw.py`

- [ ] **Step 1:** Append (uses existing module-level `client`):
```python
def test_project_persists_snap_and_stretch():
    pid = client.post("/daw/projects", json={"name": "SS"}).json()["id"]
    data = {"version": 1, "tempo": 120, "master_volume": 1.0, "scenes": 4,
            "snap": True, "snap_res": "beat",
            "tracks": [{"id": "t1", "name": "A", "mute": False, "solo": False, "color": "#fff",
                        "volume": 1.0, "pan": 0.0,
                        "clips": [{"id": "c1", "file": "a.mp3", "name": "a", "start": 2.0, "offset": 0.0,
                                   "duration": 8.0, "source_duration": 4.0, "src_len": 4.0,
                                   "pitch_lock": True, "gain": 1.0, "fade_in": 0.0, "fade_out": 0.0}]}]}
    client.put(f"/daw/projects/{pid}", json={"data": data})
    d = client.get(f"/daw/projects/{pid}").json()["data"]
    assert d["snap"] is True and d["snap_res"] == "beat"
    c = d["tracks"][0]["clips"][0]
    assert c["src_len"] == 4.0 and c["duration"] == 8.0 and c["pitch_lock"] is True
```
If the file's project create/read pattern differs, adapt to it but keep these assertions.

- [ ] **Step 2:** `python3 -m pytest tests/test_daw.py -q -k snap_and_stretch` → PASS. `python3 -m pytest tests/ -q` → 90 passed.

- [ ] **Step 3:** Commit:
```bash
git add tests/test_daw.py
git commit -m "test(daw): snap/snap_res/src_len/pitch_lock persist

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Project state — snap helpers, clip defaults, stretch mutations

**Files:** Modify `static/daw-project.js`. READ the file first; the snippets below show intended results — adapt to the real code, ADD without dropping existing behavior.

- [ ] **Step 1: Add `snap`/`snap_res` to the default `dawState` initializer** (the `let dawState = {...}` line) — add `snap: true, snap_res: "bar"` beside the existing fields. Do the same in `dawNewProject`'s reset object.

- [ ] **Step 2: Add snap helpers** near the top (after the `dawState` declaration):
```javascript
function _dawSnapDiv() {
  const beat = 60 / (dawState.tempo || 120);
  return { bar: beat * 4, half: beat * 2, beat: beat, quarter: beat / 4 }[dawState.snap_res] || beat * 4;
}
function _dawSnapSec(sec, bypass) {
  if (bypass || !dawState.snap) return sec;
  const div = _dawSnapDiv();
  return Math.round(sec / div) * div;
}
```

- [ ] **Step 3: Default `src_len`/`pitch_lock` on new clips.** In `dawAddClip`, the clip object literal — add `src_len: dur, pitch_lock: false` (keep all existing fields incl. `duration: dur, source_duration: dur`).

- [ ] **Step 4: Persist + load.**
  - `dawSaveNow`: add `snap: dawState.snap, snap_res: dawState.snap_res` to the serialized `data` object (keep existing fields).
  - `dawLoadProject`: add `snap: d.snap ?? true, snap_res: d.snap_res ?? "bar"` to the `dawState` it builds; in the tracks/clips mapping ensure each loaded clip gets `src_len` and `pitch_lock` defaults. If clips are spread as `...c` somewhere, after the spread set `c.src_len = c.src_len ?? c.duration; c.pitch_lock = c.pitch_lock ?? false;` (or fold into the map). If `dawLoadProject` doesn't currently iterate clips, add a normalization pass:
```javascript
for (const t of dawState.tracks) for (const c of (t.clips || [])) {
  c.src_len = c.src_len ?? c.duration;
  c.pitch_lock = c.pitch_lock ?? false;
}
```
  Place this right after `dawState` is assigned in `dawLoadProject`.

- [ ] **Step 5: Update `dawTrimClip` to keep the stretch ratio.** Replace the current function:
```javascript
function dawTrimClip(clipId, offset, srcLen) {
  const found = _dawFindClip(clipId);
  if (!found) return;
  const c = found.clip;
  const sd = c.source_duration || srcLen;
  const prevSrc = c.src_len ?? c.duration;
  const r = (prevSrc > 0) ? (c.duration / prevSrc) : 1;
  c.offset = Math.min(Math.max(0, offset), sd);
  c.src_len = Math.min(Math.max(0.05, srcLen), sd - c.offset);
  c.duration = c.src_len * r;
  if (typeof dawInvalidateStretch === "function") dawInvalidateStretch(c);
  _dawAfterMutate();
}
```
(Note: the third parameter is now the new **src_len**. The timeline trim handler in Task 6 passes `src_len`.)

- [ ] **Step 6: Add stretch mutations** at the end of the file:
```javascript
function dawStretchClip(clipId, newDuration) {
  const found = _dawFindClip(clipId);
  if (!found) return;
  const c = found.clip;
  const srcLen = c.src_len ?? c.duration;
  const r = Math.min(4, Math.max(0.25, newDuration / srcLen));
  c.src_len = srcLen;
  c.duration = srcLen * r;
  if (typeof dawInvalidateStretch === "function") dawInvalidateStretch(c);
  _dawAfterMutate();
}
function dawSetClipPitchLock(clipId, on) {
  const found = _dawFindClip(clipId);
  if (!found) return;
  found.clip.pitch_lock = !!on;
  if (typeof dawInvalidateStretch === "function") dawInvalidateStretch(found.clip);
  _dawAfterMutate();
}
function dawResetStretch(clipId) {
  const found = _dawFindClip(clipId);
  if (!found) return;
  const c = found.clip;
  c.duration = c.src_len ?? c.duration;
  if (typeof dawInvalidateStretch === "function") dawInvalidateStretch(c);
  _dawAfterMutate();
}
```
(Confirm `_dawFindClip` returns `{ clip, track }` — match its actual shape; adjust `found.clip` if the property differs.)

- [ ] **Step 7:** `node --check static/daw-project.js`. Commit:
```bash
git add static/daw-project.js
git commit -m "feat(daw): snap helpers + clip src_len/pitch_lock + stretch mutations

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
In your report, show BEFORE/AFTER of the `dawState` initializer, `dawAddClip` clip literal, `dawLoadProject` state build, `dawSaveNow` data object, and `dawTrimClip`.

---

### Task 3: Vendor SoundTouch + stretch render module

**Files:** Create `static/vendor/soundtouch.js`, `static/daw-stretch.js`

- [ ] **Step 1: Vendor SoundTouch.** Fetch a build that exposes `SoundTouch`, `SimpleFilter`, and `WebAudioBufferSource` as **globals** (non-module). Try, in order:
```bash
cd /home/legion/legionprojects/nyx-step && mkdir -p static/vendor
curl -fsSL https://cdn.jsdelivr.net/gh/cutterbl/SoundTouchJS@gh-pages/dist/soundtouch.js -o static/vendor/soundtouch.js \
 || curl -fsSL https://cdn.jsdelivr.net/npm/soundtouchjs@0.1.30/dist/soundtouch.js -o static/vendor/soundtouch.js
wc -l static/vendor/soundtouch.js
grep -c -E "SoundTouch|SimpleFilter|WebAudioBufferSource" static/vendor/soundtouch.js
```
Then VERIFY it exposes the three names as usable globals in a browser-like context. If the downloaded file is an **ES module** (contains top-level `export`/`import`), it will NOT define globals via a plain `<script>`. In that case, append a global-exposure shim is NOT possible for ESM via classic script — instead fetch the classic UMD build from the `also/soundtouch-js` lineage, or convert: wrap by replacing `export {…}` with assignments `window.SoundTouch = SoundTouch; window.SimpleFilter = SimpleFilter; window.WebAudioBufferSource = WebAudioBufferSource;` only if the symbols are defined as top-level `class`/`function` in the file. Confirm with:
```bash
node -e "global.window={};const fs=require('fs');const s=fs.readFileSync('static/vendor/soundtouch.js','utf8'); require('vm').runInNewContext(s.replace(/export\s*\{[^}]*\};?/g,''), {window:global.window, self:global.window}); console.log(typeof window.SoundTouch, typeof window.SimpleFilter, typeof window.WebAudioBufferSource);" 2>&1 | tail -1
```
The goal: a `static/vendor/soundtouch.js` that, when loaded via `<script>`, makes `SoundTouch`, `SimpleFilter`, `WebAudioBufferSource` callable globals. If after reasonable effort the build cannot be made to expose globals, STOP and report BLOCKED with what you tried — the engine (Task 4) already falls back to varispeed when these are undefined, so the feature still ships; the controller will decide.

- [ ] **Step 2: Create `static/daw-stretch.js`** with exactly:
```javascript
// ── DAW pitch-preserving time-stretch (SoundTouch) ────────────────────────────
const _dawStretchCache = new Map();      // key → AudioBuffer
const _dawStretchPending = new Set();    // key

function _dawStretchKey(clip) {
  return clip.file + "|" + clip.offset + "|" + (clip.src_len ?? clip.duration) + "|" + clip.duration;
}
function dawStretchGet(clip) { return _dawStretchCache.get(_dawStretchKey(clip)) || null; }
function dawInvalidateStretch(clip) {
  const prefix = clip.file + "|" + clip.offset + "|";
  for (const k of [..._dawStretchCache.keys()]) if (k.startsWith(prefix)) _dawStretchCache.delete(k);
}

async function dawRenderStretch(clip) {
  const key = _dawStretchKey(clip);
  if (_dawStretchCache.has(key)) return _dawStretchCache.get(key);
  if (_dawStretchPending.has(key)) return null;
  if (typeof SoundTouch === "undefined" || typeof SimpleFilter === "undefined" || typeof WebAudioBufferSource === "undefined") return null;
  _dawStretchPending.add(key);
  try {
    const ctx = _dawEnsureCtx();
    const buf = await dawGetBuffer(clip.file);
    if (!buf) return null;
    const sr = buf.sampleRate;
    const srcLen = clip.src_len ?? clip.duration;
    const o = Math.max(0, Math.floor(clip.offset * sr));
    const n = Math.min(buf.length - o, Math.floor(srcLen * sr));
    if (n <= 0 || clip.duration <= 0) return null;
    const nch = buf.numberOfChannels;
    const sub = ctx.createBuffer(nch, n, sr);
    for (let ch = 0; ch < nch; ch++) sub.getChannelData(ch).set(buf.getChannelData(ch).subarray(o, o + n));

    const st = new SoundTouch();
    st.tempo = srcLen / clip.duration;        // <1 lengthens, >1 shortens
    const source = new WebAudioBufferSource(sub);
    const filter = new SimpleFilter(source, st);

    const outLen = Math.ceil(clip.duration * sr);
    const out = ctx.createBuffer(nch, outLen, sr);
    const ch0 = out.getChannelData(0);
    const ch1 = nch > 1 ? out.getChannelData(1) : null;
    const BLOCK = 8192;
    const interleaved = new Float32Array(BLOCK * 2);
    let pos = 0, got = 0;
    do {
      got = filter.extract(interleaved, BLOCK);
      for (let i = 0; i < got && pos + i < outLen; i++) {
        ch0[pos + i] = interleaved[i * 2];
        if (ch1) ch1[pos + i] = interleaved[i * 2 + 1];
      }
      pos += got;
    } while (got > 0 && pos < outLen);

    _dawStretchCache.set(key, out);
    if (typeof dawRescheduleClips === "function") dawRescheduleClips();
    return out;
  } catch (e) {
    return null;
  } finally {
    _dawStretchPending.delete(key);
  }
}
```

- [ ] **Step 3:** `node --check static/daw-stretch.js`. Confirm `dawRescheduleClips` is safe to call when playback is stopped (READ its body in `static/daw-engine.js`; it should early-return if not playing). If it is NOT safe when stopped, wrap the call: replace `if (typeof dawRescheduleClips === "function") dawRescheduleClips();` with a guard using the engine's actual play-state flag (grep for `_dawPlaying`/`_dawIsPlaying` and use it). Note what you found.

- [ ] **Step 4:** Commit:
```bash
git add static/vendor/soundtouch.js static/daw-stretch.js
git commit -m "feat(daw): vendor SoundTouch + pitch-lock stretch render cache

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Report whether the SoundTouch globals verified, and the `dawRescheduleClips`-when-stopped finding.

---

### Task 4: Engine scheduling honors stretch

**Files:** Modify `static/daw-engine.js`. READ `_dawScheduleAll` first.

- [ ] **Step 1:** In `_dawScheduleAll`, locate the per-clip block that computes `when/bufOffset/playDur`, creates the `BufferSource`, sets `src.buffer = buf`, schedules the envelope, and calls `src.start(when, bufOffset, playDur)`. Replace that block (from the `let when, bufOffset, playDur;` line through `src.start(...)` and the push) with:
```javascript
      const srcLen = clip.src_len ?? clip.duration;
      const r = (srcLen > 0) ? (clip.duration / srcLen) : 1;
      const rate = 1 / r;
      let when, srcStart, srcConsume, timelineDur;
      if (clip.start >= _dawPlayhead) {
        when = _dawStartCtxTime + (clip.start - _dawPlayhead);
        srcStart = clip.offset; srcConsume = srcLen; timelineDur = clip.duration;
      } else {
        const into = _dawPlayhead - clip.start;          // timeline seconds
        when = _dawStartCtxTime;
        srcStart = clip.offset + into / r; srcConsume = srcLen - into / r; timelineDur = clip.duration - into;
      }
      const clipLocalStart = (clip.start >= _dawPlayhead) ? 0 : (_dawPlayhead - clip.start);
      const src = ctx.createBufferSource();
      const cg = ctx.createGain();
      src.connect(cg); cg.connect(chain.gain);
      const stretched = (clip.pitch_lock && Math.abs(r - 1) > 1e-3 && typeof dawStretchGet === "function") ? dawStretchGet(clip) : null;
      if (stretched) {
        src.buffer = stretched;
        src.playbackRate.value = 1;
        _dawScheduleClipEnvelope(cg, when, clipLocalStart, timelineDur, clip.gain ?? 1, clip.fade_in ?? 0, clip.fade_out ?? 0);
        src.start(when, clipLocalStart, timelineDur);
      } else {
        if (clip.pitch_lock && Math.abs(r - 1) > 1e-3 && typeof dawRenderStretch === "function") dawRenderStretch(clip);
        src.buffer = buf;
        src.playbackRate.value = rate;
        _dawScheduleClipEnvelope(cg, when, clipLocalStart, timelineDur, clip.gain ?? 1, clip.fade_in ?? 0, clip.fade_out ?? 0);
        src.start(when, srcStart, srcConsume);
      }
      _dawActiveSources.push(src);
```
Keep the surrounding loop, the `buf`/`chain` lookups, and the `clipEnd <= _dawPlayhead` skip exactly as they are. (For the pitch-lock buffer, `clipLocalStart` indexes into the already-stretched buffer — correct since that buffer is in timeline seconds.)

- [ ] **Step 2:** `node --check static/daw-engine.js`. Commit:
```bash
git add static/daw-engine.js
git commit -m "feat(daw): schedule clips with stretch ratio (varispeed + pitch-lock)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Report BEFORE/AFTER of the replaced block.

---

### Task 5: Timeline grid background

**Files:** Modify `static/daw-timeline.js`. READ `renderTimeline` first.

- [ ] **Step 1:** In `renderTimeline`, right after the line that sets `lanes.style.width = w + "px";`, add:
```javascript
  if (dawState.snap) {
    const period = Math.max(2, _dawSnapDiv() * _dawPxPerSec);
    lanes.style.backgroundImage = `repeating-linear-gradient(90deg, rgba(255,255,255,0.05) 0 1px, transparent 1px ${period}px)`;
  } else {
    lanes.style.backgroundImage = "none";
  }
```

- [ ] **Step 2:** `node --check static/daw-timeline.js`. Commit:
```bash
git add static/daw-timeline.js
git commit -m "feat(daw): draw tempo grid lines on lanes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Timeline snap + stretch gestures

**Files:** Modify `static/daw-timeline.js`. READ the drop handler (~line 138), the clip move `mousedown` (~line 193), and the resize `handle` `mousedown` (~line 213).

- [ ] **Step 1: Snap the drop.** In the lane `drop` handler, change the start computation to snap:
```javascript
      const start = Math.max(0, _dawSnapSec((e.clientX - rect.left) / _dawPxPerSec, e.ctrlKey));
```
(Keep the rest of the handler; `rect` is already computed there.)

- [ ] **Step 2: Snap the move.** In the clip-body `mousedown` → `onMove`, change `newStart`:
```javascript
      let newStart = Math.max(0, _dawSnapSec(origStart + dx, m.ctrlKey));
```
(Keep the dest-track detection and `dawMoveClip` call.)

- [ ] **Step 3: Trim vs stretch on the edge handle.** Replace the `handle.addEventListener("mousedown", …)` body with:
```javascript
  handle.addEventListener("mousedown", e => {
    const stretchMode = e.altKey;
    const startX = e.clientX, origDur = clip.duration;
    const srcLen0 = clip.src_len ?? clip.duration;
    const r0 = (srcLen0 > 0) ? (clip.duration / srcLen0) : 1;
    const onMove = m => {
      const dx = (m.clientX - startX) / _dawPxPerSec;
      const rawLen = Math.max(0.1, origDur + dx);
      const edge = _dawSnapSec(clip.start + rawLen, m.ctrlKey);
      const newLen = Math.max(0.1, edge - clip.start);     // snapped timeline length
      if (stretchMode) dawStretchClip(clip.id, newLen);
      else dawTrimClip(clip.id, clip.offset, newLen / r0); // convert timeline len → src_len
    };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
    e.stopPropagation(); e.preventDefault();
  });
```

- [ ] **Step 4:** `node --check static/daw-timeline.js`. Commit:
```bash
git add static/daw-timeline.js
git commit -m "feat(daw): snap drop/move/edge; Alt-drag time-stretch, Ctrl bypass

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Clip menu — stretch controls

**Files:** Modify `static/daw-waveedit.js`. READ `openClipMenu` and the `mkBtn(label, fn)` helper.

- [ ] **Step 1:** In `openClipMenu`, after the `mkBtn("Reset fades", …)` line, add:
```javascript
  m.appendChild(mkBtn("⇔ Time stretch…", () => {
    const srcLen = clip.src_len ?? clip.duration;
    const cur = Math.round((clip.duration / srcLen) * 100);
    const v = prompt("Stretch length as % of original (25–400):", String(cur));
    if (v == null) return;
    const pct = parseFloat(v);
    if (isFinite(pct) && pct > 0) dawStretchClip(clip.id, srcLen * pct / 100);
  }));
  m.appendChild(mkBtn((clip.pitch_lock ? "🔒 Pitch lock: ON" : "🔓 Pitch lock: OFF"),
    () => dawSetClipPitchLock(clip.id, !clip.pitch_lock)));
  m.appendChild(mkBtn("↺ Reset stretch", () => dawResetStretch(clip.id)));
```
(If `mkBtn` closes the menu after running `fn` — confirm by reading it — that's fine; the prompt runs before close.)

- [ ] **Step 2:** `node --check static/daw-waveedit.js`. Commit:
```bash
git add static/daw-waveedit.js
git commit -m "feat(daw): clip menu — time stretch, pitch lock, reset stretch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Export honors stretch + pitch-lock

**Files:** Modify `static/daw-export.js`. READ `dawRenderArrangement`.

- [ ] **Step 1: Pre-render pitch-locked clips before offline render.** After the existing `await Promise.all([...files].map(dawGetBuffer));` line, add:
```javascript
  // Pre-render any pitch-locked stretched clips so the offline pass can use them.
  if (typeof dawRenderStretch === "function") {
    const jobs = [];
    for (const t of dawState.tracks) for (const c of t.clips) {
      const sl = c.src_len ?? c.duration;
      const r = (sl > 0) ? (c.duration / sl) : 1;
      if (c.pitch_lock && Math.abs(r - 1) > 1e-3) jobs.push(dawRenderStretch(c));
    }
    await Promise.all(jobs);
  }
```

- [ ] **Step 2: Replace the per-clip scheduling** inside the `for (const clip of track.clips)` loop. Replace the block from `const buf = _dawBufferCache.get(clip.file);` through `src.start(clip.start, clip.offset, clip.duration);` with:
```javascript
      const buf = _dawBufferCache.get(clip.file);
      if (!buf || buf === "error") continue;
      const srcLen = clip.src_len ?? clip.duration;
      const r = (srcLen > 0) ? (clip.duration / srcLen) : 1;
      const src = off.createBufferSource();
      const cg = off.createGain();
      src.connect(cg); cg.connect(tg);
      const stretched = (clip.pitch_lock && Math.abs(r - 1) > 1e-3 && typeof dawStretchGet === "function") ? dawStretchGet(clip) : null;
      if (stretched) {
        src.buffer = stretched;
        src.playbackRate.value = 1;
        _dawScheduleClipEnvelope(cg, clip.start, 0, clip.duration, clip.gain ?? 1, clip.fade_in ?? 0, clip.fade_out ?? 0);
        src.start(clip.start, 0, clip.duration);
      } else {
        src.buffer = buf;
        src.playbackRate.value = 1 / r;
        _dawScheduleClipEnvelope(cg, clip.start, 0, clip.duration, clip.gain ?? 1, clip.fade_in ?? 0, clip.fade_out ?? 0);
        src.start(clip.start, clip.offset, srcLen);
      }
```

- [ ] **Step 3:** `node --check static/daw-export.js`. Commit:
```bash
git add static/daw-export.js
git commit -m "feat(daw): WAV export honors stretch ratio + pitch-lock

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Snap controls + script tags + cache-busts

**Files:** Modify `static/daw.js`, `templates/index.html`

- [ ] **Step 1: Wire snap controls** in `daw.js` `_dawWireTransport()`, after the export listener:
```javascript
  const snapCb = document.getElementById("daw-snap");
  if (snapCb) snapCb.addEventListener("change", () => { dawState.snap = snapCb.checked; dawMarkDirty(); renderTimeline(); });
  const snapRes = document.getElementById("daw-snap-res");
  if (snapRes) snapRes.addEventListener("change", () => { dawState.snap_res = snapRes.value; dawMarkDirty(); renderTimeline(); });
```
Also, so the controls reflect a loaded project, in the function that runs when the DAW tab opens / a project loads (e.g. `onDawTabOpen` or after `dawLoadProject` in `daw.js` — read the file to find where the transport is refreshed; if none, add to `_dawWireTransport` after wiring), set initial values:
```javascript
  const _sc = document.getElementById("daw-snap"); if (_sc) _sc.checked = dawState.snap !== false;
  const _sr = document.getElementById("daw-snap-res"); if (_sr) _sr.value = dawState.snap_res || "bar";
```

- [ ] **Step 2: Add the controls to the transport** in `templates/index.html`, after the `daw-session-toggle` button:
```html
        <label style="font-size:11px;color:var(--muted);display:flex;align-items:center;gap:3px"><input type="checkbox" id="daw-snap" checked> Snap</label>
        <select id="daw-snap-res" class="small" style="font-size:11px" title="Snap resolution">
          <option value="bar">Bar</option><option value="half">½</option><option value="beat">Beat</option><option value="quarter">¼</option>
        </select>
```

- [ ] **Step 3: Add script tags + cache-busts** in `templates/index.html`. Add before the `daw-engine.js` tag:
```html
<script src="/static/vendor/soundtouch.js"></script>
```
Add after the `daw-engine.js` tag (and before `daw.js`):
```html
<script src="/static/daw-stretch.js?v=1"></script>
```
Bump: `daw-project.js` v7→v8, `daw-engine.js` v7→v8, `daw-timeline.js` v6→v7, `daw-waveedit.js` v2→v3, `daw-export.js` v1→v2, `daw.js` v7→v8.

- [ ] **Step 4: Verify + restart:**
```bash
cd /home/legion/legionprojects/nyx-step
node --check static/daw.js
sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health
curl -s http://127.0.0.1:8001/ | grep -c 'id="daw-snap"'                          # 1
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8001/static/vendor/soundtouch.js   # 200
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8001/static/daw-stretch.js?v=1"   # 200
```

- [ ] **Step 5:** Commit:
```bash
git add static/daw.js templates/index.html
git commit -m "feat(daw): snap controls in transport + stretch script tags + cache-busts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: End-to-end live verification

**Files:** Create `/tmp/daw_snapstretch_verify.py` (throwaway)

- [ ] **Step 1:** Write the driver:
```python
from playwright.sync_api import sync_playwright
BASE="http://127.0.0.1:8001"
HDR={"Cf-Access-Authenticated-User-Email":"steve.j.petry@gmail.com"}
with sync_playwright() as pw:
    b=pw.chromium.launch(); ctx=b.new_context(viewport={"width":1400,"height":950},extra_http_headers=HDR)
    page=ctx.new_page(); errs=[]; page.on("pageerror",lambda e:errs.append(str(e)))
    page.goto(BASE,wait_until="domcontentloaded"); page.wait_for_selector("#btn-generate",timeout=15000)
    try: page.wait_for_load_state("networkidle",timeout=20000)
    except Exception: pass
    page.click('[data-tab="daw"]'); page.wait_for_timeout(2500)
    print("soundtouch globals:", page.evaluate("[typeof SoundTouch, typeof SimpleFilter, typeof WebAudioBufferSource]"))
    page.evaluate("async()=>{ await dawNewProject('SnapStretch'); }"); page.wait_for_timeout(900)
    tid=page.evaluate("dawState.tracks[0].id")
    # snap on / bar; tempo 120 => bar = 2.0s. add clip at messy start -> snaps to multiple of 2.0
    page.evaluate("()=>{ dawState.snap=true; dawState.snap_res='bar'; }")
    page.evaluate(f"""()=>{{ const s=_dawSnapSec(5.3,false); window.__snap=s; }}""")
    print("snap 5.3 -> (expect 6.0):", page.evaluate("window.__snap"))
    cid=page.evaluate(f"""()=>{{ const c=dawAddClip('{tid}', {{file:_dawLibItems[0].file,name:_dawLibItems[0].name,source_duration:_dawLibItems[0].duration||8}}, _dawSnapSec(5.3,false)); return c.id; }}""")
    page.wait_for_timeout(300)
    st=page.evaluate(f"""()=>{{ const c=_dawFindClip('{cid}').clip; return {{start:c.start, dur:c.duration, src:c.src_len}}; }}""")
    print("dropped clip:", st, "| START SNAPPED:", abs(st['start']%2.0)<1e-6)
    # stretch to 2x via dawStretchClip
    page.evaluate(f"()=>{{ const c=_dawFindClip('{cid}').clip; dawStretchClip('{cid}', (c.src_len)*2); }}")
    st2=page.evaluate(f"""()=>{{ const c=_dawFindClip('{cid}').clip; return {{dur:c.duration, src:c.src_len, r:c.duration/c.src_len}}; }}""")
    print("after 2x stretch:", st2, "| STRETCHED:", abs(st2['r']-2)<0.01 and abs(st2['src']-st['src'])<1e-6)
    # play varispeed -> peak>0
    page.evaluate("()=>{ dawSeek(dawState.tracks[0].clips[0].start+0.5); dawPlay(); }"); page.wait_for_timeout(1500)
    pk=page.evaluate(f"dawEngineTrackPeak('{tid}')"); page.evaluate("dawStop()")
    print("varispeed track peak:", round(pk,4), "| AUDIBLE:", pk>0.001)
    # pitch lock -> render -> cached buffer
    page.evaluate(f"()=>{{ dawSetClipPitchLock('{cid}', true); }}")
    page.evaluate(f"async()=>{{ await dawRenderStretch(_dawFindClip('{cid}').clip); }}"); page.wait_for_timeout(500)
    locked=page.evaluate(f"()=>{{ return !!dawStretchGet(_dawFindClip('{cid}').clip); }}")
    print("pitch-lock buffer cached:", locked)
    # reset stretch
    page.evaluate(f"()=>{{ dawResetStretch('{cid}'); }}")
    rr=page.evaluate(f"()=>{{ const c=_dawFindClip('{cid}').clip; return c.duration===c.src_len; }}")
    print("reset stretch r==1:", rr)
    # grid background present
    bg=page.evaluate("()=>getComputedStyle(document.getElementById('daw-lanes')).backgroundImage")
    print("grid bg set:", 'gradient' in (bg or ''))
    # persistence
    page.wait_for_timeout(1200); pid=page.evaluate("dawState.id")
    page.reload(wait_until="domcontentloaded"); page.wait_for_selector("#btn-generate",timeout=15000); page.wait_for_timeout(800)
    page.click('[data-tab="daw"]'); page.wait_for_timeout(1500)
    per=page.evaluate(f"""async()=>{{ await dawLoadProject({pid}); const c=dawState.tracks[0].clips[0];
        return {{snap:dawState.snap, res:dawState.snap_res, src:c.src_len, pl:c.pitch_lock}}; }}""")
    print("persisted:", per)
    print("PAGE ERRORS:", errs)
    page.screenshot(path="/tmp/daw_snapstretch.png", full_page=True)
    ctx.close(); b.close()
print("SNAPSTRETCH VERIFY DONE")
```

- [ ] **Step 2:** Run `cd /tmp && python3 daw_snapstretch_verify.py`. Expected: snap 5.3→6.0; dropped clip START SNAPPED True; after-2x STRETCHED True (r≈2, src unchanged); varispeed peak>0 AUDIBLE True; `soundtouch globals` all `"function"` AND `pitch-lock buffer cached: True` (if SoundTouch vendored OK — if globals are `"undefined"`, note it: varispeed still works and that's the documented fallback); reset r==1 True; grid bg set True; persisted shows snap/res/src/pl retained; `PAGE ERRORS: []`.

- [ ] **Step 3:** Inspect `/tmp/daw_snapstretch.png` — visible vertical grid lines on lanes; Snap checkbox + resolution select in transport.

- [ ] **Step 4: Regression:** `python3 -m pytest tests/ -q` (90 passed) and `for f in daw-project daw-engine daw-stretch daw-timeline daw-waveedit daw-export daw; do node --check static/$f.js; done`.

No commit (throwaway). If a fix was needed, commit `fix(daw):` and re-run.

---

## Self-Review

**Spec coverage:**
- `snap`/`snap_res` state + persistence + defaults → T1, T2 ✓
- `_dawSnapSec`/`_dawSnapDiv` → T2 ✓; applied to drop/move/trim/stretch + Ctrl bypass → T6 ✓
- Grid lines via repeating-linear-gradient, tracks zoom/tempo/res → T5 (+ redraw on control change in T9) ✓
- Clip `src_len`/`pitch_lock` defaults (add+load) → T2 ✓
- `dawTrimClip` keeps `r`; `dawStretchClip`/`dawSetClipPitchLock`/`dawResetStretch` → T2 ✓
- Alt-drag stretch vs plain trim → T6 ✓; clip-menu numeric + pitch-lock + reset → T7 ✓
- Engine `r`/`rate` varispeed + pitch-lock buffer + async fallback → T4 ✓
- SoundTouch vendor + `dawRenderStretch`/`dawStretchGet`/`dawInvalidateStretch` + cache → T3 ✓
- Export honors stretch + pitch-lock (awaits renders) → T8 ✓
- Snap UI controls + scripts + cache-busts → T9 ✓
- Persistence test + live verification → T1, T10 ✓
- Edge cases (snap off, Ctrl bypass, tempo change, missing defaults, r clamp [0.25,4], async fallback, SoundTouch-unavailable fallback, export pending, mid-clip playhead) → covered across T2/T3/T4/T6/T8; verified T10 ✓

**Placeholder scan:** none — complete code + exact commands. (SoundTouch vendoring is the one integration-risk step; T3 has explicit verify + BLOCKED escape, and the engine fallback keeps the feature shipping.)

**Type/name consistency:** `_dawSnapSec`/`_dawSnapDiv`, `src_len`, `pitch_lock`, `dawStretchClip`/`dawSetClipPitchLock`/`dawResetStretch`, `dawStretchGet`/`dawRenderStretch`/`dawInvalidateStretch`, `_dawStretchKey`, stretch ratio `r = duration/src_len` consistent across T2–T8. `dawTrimClip(clipId, offset, srcLen)` third-arg-as-src_len consistent between T2 (def) and T6 (caller passes `newLen / r0`). Engine + export both use the same `r`/`rate` and `dawStretchGet` pattern. Element ids `daw-snap`/`daw-snap-res` consistent T9. Uses existing `dawEngineTrackPeak`, `_dawFindClip().clip`, `_dawLibItems`, `dawSeek`/`dawPlay`/`dawStop` in T10.
