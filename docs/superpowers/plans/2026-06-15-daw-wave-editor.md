# DAW Phase 3 — Wave Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-clip wave editing on the DAW timeline — fade-in/fade-out (corner-drag handles with a drawn curve), per-clip gain, split at the playhead, and normalize — all non-destructive and heard live.

**Architecture:** Insert a per-clip GainNode (`BufferSource → clipGain → trackChain.gain`) and schedule a clip-local linear fade/gain envelope on it. Split partitions one clip into two (same file, adjusted offset/duration); normalize sets clip gain from the buffer peak. New clip fields (`gain`/`fade_in`/`fade_out`) ride in the existing project JSON; edits reschedule playback so they're audible immediately.

**Tech Stack:** vanilla JS, Web Audio API (GainNode envelopes via setValueAtTime/linearRampToValueAtTime), Canvas 2D, FastAPI/SQLite (persistence only), pytest, Playwright.

**Spec:** `docs/superpowers/specs/2026-06-15-daw-wave-editor-design.md`

**Conventions:**
- Work from `/home/legion/legionprojects/nyx-step` on `master`. Tests: `python3 -m pytest tests/ -q` (no venv; baseline 86 pass).
- `node --check <file>` for JS. After JS/HTML change, bump that file's `?v=N` in `templates/index.html`.
- Service: `sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health` (passwordless sudo; version 3.10.0).
- Commit per task; end messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do not push (controller finishes).
- Existing globals: `dawState`, `_dawFindClip`, `_dawUid`, `_dawAfterMutate`, `dawGetPlayhead`, `dawGetBuffer`, `_dawBufferCache`, `_dawIsPlaying`, `_dawPlayhead`, `_dawStartPlayhead`, `_dawStartCtxTime`, `_dawCtx`, `_dawStopSources`, `_dawScheduleAll`, `_dawPxPerSec`, `_DAW_LANE_H`, `_dawSelectedClip`, `_dawDrawClipWave`, `gainToDb`, `dbToGain` (daw-mixer.js).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `static/daw-engine.js` | modify | per-clip `clipGain` + `_dawScheduleClipEnvelope`; `dawEngineClipPeak`; `dawRescheduleClips` |
| `static/daw-project.js` | modify | clip defaults; `dawSetClipGain/FadeIn/FadeOut`, `dawSplitClipAtPlayhead`, `dawNormalizeClip` |
| `static/daw-timeline.js` | modify | fade corner handles, fade-curve drawing, ⋯ button + contextmenu; move trim handle down |
| `static/daw-waveedit.js` | **create** | `openClipMenu` popup (Split/Normalize/Gain/Reset) |
| `templates/index.html` | modify | `daw-waveedit.js` script tag + cache-busts |
| `tests/test_daw.py` | modify | clip wave-field persistence test |

---

### Task 1: Backend persistence contract test

**Files:** Modify `tests/test_daw.py`

- [ ] **Step 1: Append the test** (`client` for dev@local + `import core.db as db` already exist):

```python
def test_project_persists_clip_wave_fields():
    pid = client.post("/daw/projects", json={"name": "WaveProj"}).json()["id"]
    data = {"version": 1, "tempo": 120, "master_volume": 1.0,
            "tracks": [{"id": "t1", "name": "V", "mute": False, "solo": False, "color": "#fff",
                        "volume": 1.0, "pan": 0.0,
                        "clips": [{"id": "c1", "file": "x.mp3", "name": "x", "start": 0, "offset": 0,
                                   "duration": 10, "source_duration": 10,
                                   "gain": 0.5, "fade_in": 1.5, "fade_out": 2.0}]}]}
    client.put(f"/daw/projects/{pid}", json={"data": data})
    c = client.get(f"/daw/projects/{pid}").json()["data"]["tracks"][0]["clips"][0]
    assert c["gain"] == 0.5 and c["fade_in"] == 1.5 and c["fade_out"] == 2.0
```

- [ ] **Step 2: Run** `python3 -m pytest tests/test_daw.py -q -k wave_fields` → PASS (opaque JSON; no backend change). Then `python3 -m pytest tests/ -q` → 87 passed.

- [ ] **Step 3: Commit**
```bash
git add tests/test_daw.py
git commit -m "test(daw): clip wave fields (gain/fade_in/fade_out) persist in project data

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Engine — per-clip gain/fade envelope, clip peak, reschedule

**Files:** Modify `static/daw-engine.js`

- [ ] **Step 1: Add the envelope helper, clip-peak reader, and clip-reschedule.** Add these three functions (e.g. right after `_dawApplyMixState`):

```javascript
// Linear per-clip gain+fade envelope on a GainNode, computed in clip-local time
// so it's correct even when playback starts mid-clip.
function _dawScheduleClipEnvelope(cg, when, localStart, playDur, gain, fadeIn, fadeOut) {
  const dur = localStart + playDur;          // clip's full logical duration
  if (fadeIn + fadeOut > dur && (fadeIn + fadeOut) > 0) {
    const scale = dur / (fadeIn + fadeOut);  // shrink overlapping fades proportionally
    fadeIn *= scale; fadeOut *= scale;
  }
  const env = (u) => {
    let f = 1;
    if (fadeIn > 0 && u < fadeIn) f = u / fadeIn;
    else if (fadeOut > 0 && u > dur - fadeOut) f = (dur - u) / fadeOut;
    return gain * Math.max(0, Math.min(1, f));
  };
  cg.gain.setValueAtTime(env(localStart), when);
  const bps = [];
  if (fadeIn > 0) bps.push(fadeIn);
  if (fadeOut > 0) bps.push(dur - fadeOut);
  bps.push(dur);
  bps.sort((a, b) => a - b);
  for (const bp of bps) {
    if (bp > localStart) cg.gain.linearRampToValueAtTime(env(bp), when + (bp - localStart));
  }
}

// Peak abs sample across channels over a clip's [offset, offset+dur] window (0 if buffer absent).
function dawEngineClipPeak(file, offsetSec, durSec) {
  const buf = _dawBufferCache.get(file);
  if (!buf || buf === "error") return 0;
  const sr = buf.sampleRate;
  const start = Math.max(0, Math.floor(offsetSec * sr));
  const end = Math.min(buf.length, Math.floor((offsetSec + durSec) * sr));
  let peak = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = start; i < end; i++) { const v = Math.abs(data[i]); if (v > peak) peak = v; }
  }
  return peak;
}

// True reschedule (clip edits change envelopes scheduled at clip start).
function dawRescheduleClips() {
  if (!_dawIsPlaying) return;
  _dawPlayhead = _dawStartPlayhead + (_dawCtx.currentTime - _dawStartCtxTime);
  _dawStopSources();
  _dawScheduleAll();
}
```

- [ ] **Step 2: Route each clip through a per-clip GainNode in `_dawScheduleAll`.** Replace the per-clip source block:

```javascript
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(chain.gain);
      src.start(when, bufOffset, playDur);
      _dawActiveSources.push(src);
```

with:

```javascript
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const cg = ctx.createGain();
      src.connect(cg); cg.connect(chain.gain);
      const clipLocalStart = (clip.start >= _dawPlayhead) ? 0 : (_dawPlayhead - clip.start);
      _dawScheduleClipEnvelope(cg, when, clipLocalStart, playDur,
                               clip.gain ?? 1, clip.fade_in ?? 0, clip.fade_out ?? 0);
      src.start(when, bufOffset, playDur);
      _dawActiveSources.push(src);
```

- [ ] **Step 3: Syntax check + commit**
```bash
node --check static/daw-engine.js
git add static/daw-engine.js
git commit -m "feat(daw): per-clip gain/fade envelope, clip peak reader, clip reschedule

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Project — clip defaults + wave-edit mutations

**Files:** Modify `static/daw-project.js`

- [ ] **Step 1: Default the new fields on new clips.** In `dawAddClip`, change the `const clip = {...}` to include them:

```javascript
  const clip = {
    id: _dawUid("c"), file: src.file, name: src.name || src.file,
    start: Math.max(0, start || 0), offset: 0,
    duration: dur, source_duration: dur,
    gain: 1.0, fade_in: 0.0, fade_out: 0.0,
  };
```

- [ ] **Step 2: Append the wave-edit mutations** at the end of `static/daw-project.js`:

```javascript
// ── Wave-edit mutations ─────────────────────────────────────────────────────────
function dawSetClipGain(clipId, gain) {
  const f = _dawFindClip(clipId);
  if (!f) return;
  f.clip.gain = Math.max(0, gain);
  if (typeof dawRescheduleClips === "function") dawRescheduleClips();
  _dawAfterMutate();
}

function dawSetClipFadeIn(clipId, sec) {
  const f = _dawFindClip(clipId);
  if (!f) return;
  const c = f.clip;
  c.fade_in = Math.min(Math.max(0, sec), c.duration - (c.fade_out ?? 0));
  if (typeof dawRescheduleClips === "function") dawRescheduleClips();
  _dawAfterMutate();
}

function dawSetClipFadeOut(clipId, sec) {
  const f = _dawFindClip(clipId);
  if (!f) return;
  const c = f.clip;
  c.fade_out = Math.min(Math.max(0, sec), c.duration - (c.fade_in ?? 0));
  if (typeof dawRescheduleClips === "function") dawRescheduleClips();
  _dawAfterMutate();
}

function dawSplitClipAtPlayhead(clipId) {
  const f = _dawFindClip(clipId);
  if (!f) return;
  const { track, clip } = f;
  const p = (typeof dawGetPlayhead === "function") ? dawGetPlayhead() : 0;
  if (p <= clip.start || p >= clip.start + clip.duration) return;   // playhead not strictly inside
  const leftDur = p - clip.start;
  const rightDur = clip.duration - leftDur;
  const gain = clip.gain ?? 1;
  const left = { ...clip, id: _dawUid("c"), duration: leftDur, gain,
                 fade_in: Math.min(clip.fade_in ?? 0, leftDur), fade_out: 0 };
  const right = { ...clip, id: _dawUid("c"), start: p, offset: clip.offset + leftDur,
                  duration: rightDur, gain, fade_in: 0,
                  fade_out: Math.min(clip.fade_out ?? 0, rightDur) };
  const idx = track.clips.findIndex(c => c.id === clipId);
  track.clips.splice(idx, 1, left, right);
  if (typeof dawRescheduleClips === "function") dawRescheduleClips();
  _dawAfterMutate();
}

async function dawNormalizeClip(clipId) {
  const f = _dawFindClip(clipId);
  if (!f) return;
  const c = f.clip;
  if (typeof dawGetBuffer === "function") await dawGetBuffer(c.file);
  const peak = (typeof dawEngineClipPeak === "function") ? dawEngineClipPeak(c.file, c.offset, c.duration) : 0;
  if (peak > 0) {
    c.gain = Math.min(8, 1 / peak);   // NORM_CAP = 8 (≈ +18 dB)
    if (typeof dawRescheduleClips === "function") dawRescheduleClips();
    _dawAfterMutate();
  }
}
```

- [ ] **Step 3: Syntax check + commit**
```bash
node --check static/daw-project.js
git add static/daw-project.js
git commit -m "feat(daw): clip gain/fade defaults + split/normalize/fade/gain mutations

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Timeline — fade handles, fade curve, ⋯ button

**Files:** Modify `static/daw-timeline.js`

- [ ] **Step 1: Add a fade-curve drawer.** Add this function (e.g. after `_dawDrawClipWave`):

```javascript
function _dawDrawClipFades(canvas, clip) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const fi = (clip.fade_in ?? 0) * _dawPxPerSec;
  const fo = (clip.fade_out ?? 0) * _dawPxPerSec;
  ctx.strokeStyle = "#e2e4ed"; ctx.fillStyle = "rgba(0,212,182,0.18)"; ctx.lineWidth = 1;
  if (fi > 0) {
    const x = Math.min(fi, w);
    ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(x, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(x, 0); ctx.lineTo(0, h); ctx.closePath(); ctx.fill();
  }
  if (fo > 0) {
    const x = Math.max(0, w - fo);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(w, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(w, 0); ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
  }
}
```

- [ ] **Step 2: Call it after the waveform draw, move the trim handle down, and add fade handles + ⋯ button.** In `_dawBuildClipEl`:

After `_dawDrawClipWave(canvas, clip, track.color);` add:
```javascript
  _dawDrawClipFades(canvas, clip);
```

Change the trim handle line so it starts below the fade-out grip:
```javascript
  const handle = document.createElement("div");
  handle.style.cssText = "position:absolute;right:0;top:10px;height:calc(100% - 10px);width:6px;cursor:ew-resize;background:linear-gradient(90deg,transparent,#00d4b6)";
  el.appendChild(handle);
```

Then, before `_dawWireClipDrag(el, handle, track, clip);`, add the fade handles, ⋯ button, and contextmenu:
```javascript
  const fiH = document.createElement("div");
  fiH.title = "Fade in";
  fiH.style.cssText = "position:absolute;left:0;top:0;width:9px;height:9px;cursor:ew-resize;background:#00d4b6;opacity:0.85;border-radius:0 0 6px 0;z-index:2";
  const foH = document.createElement("div");
  foH.title = "Fade out";
  foH.style.cssText = "position:absolute;right:0;top:0;width:9px;height:9px;cursor:ew-resize;background:#00d4b6;opacity:0.85;border-radius:0 0 0 6px;z-index:2";
  el.appendChild(fiH); el.appendChild(foH);
  _dawWireFadeHandles(fiH, foH, el, clip);

  const menuBtn = document.createElement("div");
  menuBtn.textContent = "⋯"; menuBtn.title = "Clip actions";
  menuBtn.style.cssText = "position:absolute;right:14px;top:0;font-size:11px;line-height:11px;color:#e2e4ed;cursor:pointer;padding:0 3px;z-index:2;background:rgba(0,0,0,0.35);border-radius:2px";
  menuBtn.addEventListener("mousedown", e => e.stopPropagation());
  menuBtn.addEventListener("click", e => { e.stopPropagation(); if (typeof openClipMenu === "function") openClipMenu(clip, menuBtn); });
  el.appendChild(menuBtn);
  el.addEventListener("contextmenu", e => { e.preventDefault(); if (typeof openClipMenu === "function") openClipMenu(clip, menuBtn); });
```

- [ ] **Step 3: Add the fade-handle drag wiring.** Add this function (e.g. after `_dawWireClipDrag`):

```javascript
function _dawWireFadeHandles(fiH, foH, el, clip) {
  fiH.addEventListener("mousedown", e => {
    e.stopPropagation(); e.preventDefault();
    const rect = el.getBoundingClientRect();    // left edge fixed during fade-in drag
    const onMove = m => dawSetClipFadeIn(clip.id, Math.max(0, (m.clientX - rect.left) / _dawPxPerSec));
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
  });
  foH.addEventListener("mousedown", e => {
    e.stopPropagation(); e.preventDefault();
    const rect = el.getBoundingClientRect();    // right edge fixed during fade-out drag
    const onMove = m => dawSetClipFadeOut(clip.id, Math.max(0, (rect.right - m.clientX) / _dawPxPerSec));
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
  });
}
```
(Captured `rect` stays valid mid-drag because the clip's left/right edge doesn't move while a fade grows — same pattern the trim handle already uses.)

- [ ] **Step 4: Syntax check + commit**
```bash
node --check static/daw-timeline.js
git add static/daw-timeline.js
git commit -m "feat(daw): clip fade handles, fade curve, clip-actions ⋯ button

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Clip actions menu

**Files:** Create `static/daw-waveedit.js`

- [ ] **Step 1: Create the module** with exactly this content:

```javascript
// ── DAW clip actions menu (wave editor) ───────────────────────────────────────
let _dawMenuEl = null;

function _dawCloseClipMenu() {
  if (!_dawMenuEl) return;
  _dawMenuEl.remove(); _dawMenuEl = null;
  document.removeEventListener("mousedown", _dawMenuOutside);
  document.removeEventListener("keydown", _dawMenuEsc);
}
function _dawMenuOutside(e) { if (_dawMenuEl && !_dawMenuEl.contains(e.target)) _dawCloseClipMenu(); }
function _dawMenuEsc(e) { if (e.key === "Escape") _dawCloseClipMenu(); }

function openClipMenu(clip, anchor) {
  _dawCloseClipMenu();
  const m = document.createElement("div");
  _dawMenuEl = m;
  m.style.cssText = "position:fixed;z-index:1000;background:#15171f;border:1px solid #2d3041;border-radius:6px;padding:6px;display:flex;flex-direction:column;gap:4px;min-width:160px;box-shadow:0 4px 16px rgba(0,0,0,0.5)";
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 180) + "px";
  m.style.top = (r.bottom + 4) + "px";

  const mkBtn = (label, fn) => {
    const b = document.createElement("button");
    b.className = "secondary small"; b.textContent = label;
    b.style.cssText = "font-size:11px;text-align:left";
    b.addEventListener("click", async () => { await fn(); _dawCloseClipMenu(); });
    return b;
  };
  m.appendChild(mkBtn("✂ Split at playhead", () => dawSplitClipAtPlayhead(clip.id)));
  m.appendChild(mkBtn("📊 Normalize", () => dawNormalizeClip(clip.id)));

  const gainRow = document.createElement("label");
  gainRow.style.cssText = "font-size:11px;color:#e2e4ed;display:flex;align-items:center;gap:6px";
  gainRow.textContent = "Gain dB";
  const gi = document.createElement("input");
  gi.type = "number"; gi.min = "-24"; gi.max = "12"; gi.step = "0.5";
  const curDb = (typeof gainToDb === "function") ? gainToDb(clip.gain ?? 1) : 0;
  gi.value = (curDb === -Infinity ? -24 : Number(curDb.toFixed(1)));
  gi.style.cssText = "width:58px;font-size:11px";
  gi.addEventListener("change", () => {
    const g = (typeof dbToGain === "function") ? dbToGain(parseFloat(gi.value)) : 1;
    dawSetClipGain(clip.id, g);
  });
  gainRow.appendChild(gi);
  m.appendChild(gainRow);

  m.appendChild(mkBtn("Reset fades", () => { dawSetClipFadeIn(clip.id, 0); dawSetClipFadeOut(clip.id, 0); }));

  document.body.appendChild(m);
  // Defer outside-click listener so the opening click doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener("mousedown", _dawMenuOutside);
    document.addEventListener("keydown", _dawMenuEsc);
  }, 0);
}
```

- [ ] **Step 2: Syntax check + commit**
```bash
node --check static/daw-waveedit.js
git add static/daw-waveedit.js
git commit -m "feat(daw): clip actions menu — split, normalize, gain, reset fades

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Wire script + cache-busts

**Files:** Modify `templates/index.html`

- [ ] **Step 1: Add the script tag.** Add `<script src="/static/daw-waveedit.js?v=1"></script>` immediately after the `daw-mixer.js` script tag and before `daw.js` (it uses `gainToDb`/`dbToGain` from daw-mixer.js).

- [ ] **Step 2: Bump cache-busts** for the modified files: `daw-engine.js` v5→v6, `daw-project.js` v5→v6, `daw-timeline.js` v4→v5.

- [ ] **Step 3: Verify + restart**
```bash
sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8001/static/daw-waveedit.js?v=1"   # 200
curl -s http://127.0.0.1:8001/ | grep -o 'daw-waveedit.js?v=1' | head -1                       # daw-waveedit.js?v=1
```

- [ ] **Step 4: Commit**
```bash
git add templates/index.html
git commit -m "feat(daw): load daw-waveedit.js, bump wave-editor cache-busts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end live verification

**Files:** Create `/tmp/daw_wave_verify.py` (throwaway)

- [ ] **Step 1: Write the driver**

```python
from playwright.sync_api import sync_playwright
BASE = "http://127.0.0.1:8001"
HDR = {"Cf-Access-Authenticated-User-Email": "steve.j.petry@gmail.com"}

with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={"width": 1400, "height": 950}, extra_http_headers=HDR)
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(BASE, wait_until="domcontentloaded")
    page.wait_for_selector("#btn-generate", timeout=15000)
    try: page.wait_for_load_state("networkidle", timeout=20000)
    except Exception: pass
    page.click('[data-tab="daw"]'); page.wait_for_timeout(2500)

    # one track + one clip from the library
    page.evaluate("""() => {
        if (!dawState.tracks.length) dawAddTrack();
        const t = dawState.tracks[0];
        if (_dawLibItems.length && !t.clips.length)
            dawAddClip(t.id, {file:_dawLibItems[0].file, name:_dawLibItems[0].name, source_duration:_dawLibItems[0].duration||15}, 0);
    }""")
    page.wait_for_timeout(600)
    cid = page.evaluate("dawState.tracks[0].clips[0].id")

    # Decisive fade test: early-window peak with NO fade vs with a long (10s) fade-in.
    # A long fade multiplies the clip's early samples toward 0, so earlyWithFade must be
    # clearly lower than earlyNoFade — this isolates the envelope from the clip's own intro.
    tid = page.evaluate("dawState.tracks[0].id")
    page.evaluate(f"() => dawGetBuffer(dawState.tracks[0].clips[0].file)"); page.wait_for_timeout(900)
    def early_peak():
        page.evaluate("dawSeek(0)"); page.click("#daw-play"); page.wait_for_timeout(500)
        v = max(page.evaluate(f"dawEngineTrackPeak('{tid}')") for _ in range(6))
        page.click("#daw-stop"); page.wait_for_timeout(150)
        return v
    page.evaluate(f"dawSetClipFadeIn('{cid}', 0)"); page.wait_for_timeout(150)
    early_nofade = early_peak()
    page.evaluate(f"dawSetClipFadeIn('{cid}', 10.0)"); page.wait_for_timeout(150)
    print("fade_in set:", page.evaluate("dawState.tracks[0].clips[0].fade_in"))
    early_fade = early_peak()
    print(f"fade-in: earlyNoFade={early_nofade:.4f}  earlyWithFade={early_fade:.4f}  FADE WORKS={early_fade < early_nofade * 0.6}")

    # Normalize → gain becomes peak-based (≠ 1)
    page.evaluate(f"async () => {{ await dawNormalizeClip('{cid}'); }}")
    page.wait_for_timeout(500)
    print("normalized gain:", round(page.evaluate("dawState.tracks[0].clips[0].gain"), 3))

    # Set clip gain via dB → linear
    page.evaluate(f"dawSetClipGain('{cid}', {0.5})")
    print("clip gain set 0.5:", page.evaluate("dawState.tracks[0].clips[0].gain"))

    # Split at playhead: seek to inside the clip, split → 2 clips
    page.evaluate("dawSeek(2.0)")
    page.evaluate(f"dawSplitClipAtPlayhead('{cid}')")
    page.wait_for_timeout(400)
    n = page.evaluate("dawState.tracks[0].clips.length")
    parts = page.evaluate("dawState.tracks[0].clips.map(c => ({start:c.start, offset:+c.offset.toFixed(2), dur:+c.duration.toFixed(2)}))")
    print("after split clips:", n, parts)

    # ⋯ menu opens
    page.evaluate("() => { const el=document.querySelector('.daw-clip'); openClipMenu(dawState.tracks[0].clips[0], el); }")
    page.wait_for_timeout(300)
    menu = page.evaluate("!!document.querySelector('body > div') && [...document.querySelectorAll('button')].some(b=>b.textContent.includes('Split at playhead'))")
    print("menu has Split:", menu)
    page.keyboard.press("Escape"); page.wait_for_timeout(200)

    # Persistence: autosave → reload → reopen
    page.wait_for_timeout(1300)
    pid = page.evaluate("dawState.id")
    page.reload(wait_until="domcontentloaded"); page.wait_for_selector("#btn-generate", timeout=15000); page.wait_for_timeout(800)
    page.click('[data-tab="daw"]'); page.wait_for_timeout(2000)
    persisted = page.evaluate(f"""async () => {{ await dawLoadProject({pid});
        const c = dawState.tracks[0].clips[0];
        return {{count: dawState.tracks[0].clips.length, fade_in: c.fade_in, gain: c.gain}}; }}""")
    print("persisted:", persisted)
    print("PAGE ERRORS:", errs)
    page.screenshot(path="/tmp/daw_wave_verify.png", full_page=True)
    ctx.close(); b.close()
print("WAVE VERIFY DONE")
```

- [ ] **Step 2: Run** `cd /tmp && python3 daw_wave_verify.py`
Expected: `fade_in set: 3`; fade-in `RAMPS UP=True` (early peak near 0, late peak higher — proves the envelope reaches the graph); `normalized gain` ≠ 1 and ≤ 8; `clip gain set 0.5: 0.5`; after split `clips: 2` with `left.dur + right.dur ≈ original` and `right.offset = left.dur`; `menu has Split: True`; persisted `count`/`fade_in`/`gain` survive reload; `PAGE ERRORS: []`.

- [ ] **Step 3: Inspect** `/tmp/daw_wave_verify.png` — clips show fade triangles, corner fade grips, the ⋯ button; confirm it reads like a clip-level wave editor.

- [ ] **Step 4: Full regression** `python3 -m pytest tests/ -q` (87 passed) and `for f in daw-engine daw-project daw-timeline daw-waveedit daw-mixer daw; do node --check static/$f.js; done` (no output).

No commit (driver is throwaway). If a fix was needed, commit with `fix(daw):` and re-run.

---

## Self-Review

**Spec coverage:**
- Clip `gain`/`fade_in`/`fade_out` data model + defaults → Task 3 ✓ (loaded clips use `?? ` defaults in engine/UI — Task 2 envelope, Task 4 curve)
- Per-clip GainNode + clip-local linear envelope (straddle-correct) → Task 2 ✓
- `dawEngineClipPeak` + `dawNormalizeClip` (cap 8) → Tasks 2, 3 ✓
- `dawSplitClipAtPlayhead` (partition fades, non-destructive) → Task 3 ✓
- `dawRescheduleClips` (edits heard live) → Task 2; called by all clip-edit mutations → Task 3 ✓
- Fade corner handles + fade curve + trim-handle offset → Task 4 ✓
- ⋯ button + contextmenu → Task 4; menu (Split/Normalize/Gain dB/Reset) → Task 5 ✓
- Setters `dawSetClipGain/FadeIn/FadeOut` with clamping → Task 3 ✓
- Script load order (after daw-mixer, before daw.js) + cache-busts → Task 6 ✓
- Persistence test → Task 1; live verification → Task 7 ✓
- Edge cases: missing fields (`?? `), fade overlap (clamp in setters + proportional scale in envelope), split outside clip (no-op), split at edge (`<=`/`>=` guard), near-silent normalize (peak 0 → no-op; cap 8), straddle (clip-local envelope), edit-during-play (`dawRescheduleClips`), handle vs move (`stopPropagation`) → all covered ✓

**Placeholder scan:** none — every step has complete code + exact commands.

**Type/name consistency:** `dawSetClipGain/FadeIn/FadeOut`, `dawSplitClipAtPlayhead`, `dawNormalizeClip` (project) ↔ `_dawScheduleClipEnvelope`, `dawEngineClipPeak`, `dawRescheduleClips` (engine) ↔ `openClipMenu` (waveedit) ↔ `_dawDrawClipFades`, `_dawWireFadeHandles` (timeline) — consistent across Tasks 2–6. NORM_CAP = 8 used in Task 3 and asserted (≤ 8) in Task 7. `gainToDb`/`dbToGain` reused from daw-mixer.js (load order ensures availability). Reuses existing `_dawFindClip`, `_dawUid`, `_dawAfterMutate`, `dawGetPlayhead`, `dawGetBuffer`, `dawEngineTrackPeak`.
