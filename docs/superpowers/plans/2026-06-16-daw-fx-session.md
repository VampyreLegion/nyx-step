# DAW Phase 6 — FX + Session Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-track insert FX (EQ/Reverb/Delay) on the mixer chains, and a session/looper grid where library clips dropped into per-track cells launch as free-running loops through those same chains.

**Architecture:** Splice EQ→Reverb→Delay nodes into each persistent track chain (after `gain`, before `pan`), controlled live via `dawEngineSetTrackFx`. The session looper reuses the track chains: launching a cell connects a looping BufferSource to `chain.gain`, so volume/pan/mute/FX apply. New `fx`/`cells` track fields and `scenes` ride in the project JSON.

**Tech Stack:** vanilla JS, Web Audio (BiquadFilter/Convolver/Delay/GainNode, looping BufferSource), Playwright, pytest.

**Spec:** `docs/superpowers/specs/2026-06-16-daw-fx-session-design.md`

**Conventions:**
- Work from `/home/legion/legionprojects/nyx-step` on `master`. `node --check <file>` for JS. After JS/HTML change, bump `?v=N` in `templates/index.html`.
- Service: `sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health` (passwordless sudo; 3.10.0). Tests: `python3 -m pytest tests/ -q` (baseline 88).
- Commit per task; end messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do not push (controller finishes).
- Existing globals: `dawState`, `_dawTrackChains`, `_dawEnsureCtx`, `_dawCtx`, `_dawMaster`, `_dawSyncChains`, `_dawApplyMixState`, `dawGetBuffer`, `_dawFindClip`, `dawAddTrack`, `dawMarkDirty`, `renderTimeline`, `dawRenderMixerIfOpen`, `dawRenderMixer`, `_dawSetSaveStatus`. Mixer strip builder `_dawStrip(track)` with `mk(label,on,fn)` helper. Library drag payload MIME: `application/x-daw-clip` (JSON `{file,name,source_duration}`).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `static/daw-engine.js` | modify | FX node builders + chain splice + `dawEngineSetTrackFx`; session looper (`dawLaunchCell`/`dawStopCell`/`dawStopAllCells`/`dawCellActive`, `_dawGridActive`) |
| `static/daw-project.js` | modify | `fx`/`cells` defaults + `scenes`; `dawSetTrackFx`, `dawSetCell`, `dawAddScene`; load/save; session re-render hook |
| `static/daw-mixer.js` | modify | per-strip **FX** button + `openFxPanel` |
| `static/daw-session.js` | **create** | session grid panel render + drag-to-cell + launch/stop |
| `static/daw.js` | modify | 🎛 Session transport toggle |
| `templates/index.html` | modify | Session button + `#daw-session-panel` + `daw-session.js` script + cache-busts |
| `tests/test_daw.py` | modify | fx/cells/scenes persistence test |

---

### Task 1: Backend persistence contract test

**Files:** Modify `tests/test_daw.py`

- [ ] **Step 1: Append** (uses existing `client` for dev@local):
```python
def test_project_persists_fx_and_session():
    pid = client.post("/daw/projects", json={"name": "P6"}).json()["id"]
    data = {"version": 1, "tempo": 120, "master_volume": 1.0, "scenes": 4,
            "tracks": [{"id": "t1", "name": "V", "mute": False, "solo": False, "color": "#fff",
                        "volume": 1.0, "pan": 0.0,
                        "fx": {"eq": {"on": True, "low": 3, "mid": -2, "high": 5},
                               "reverb": {"on": True, "wet": 0.4},
                               "delay": {"on": False, "time": 0.3, "feedback": 0.3, "wet": 0.3}},
                        "cells": [{"file": "a.mp3", "name": "a"}, None, None, None],
                        "clips": []}]}
    client.put(f"/daw/projects/{pid}", json={"data": data})
    d = client.get(f"/daw/projects/{pid}").json()["data"]
    assert d["scenes"] == 4
    t = d["tracks"][0]
    assert t["fx"]["eq"]["on"] is True and t["fx"]["eq"]["low"] == 3
    assert t["fx"]["reverb"]["wet"] == 0.4
    assert t["cells"][0]["file"] == "a.mp3" and t["cells"][1] is None
```

- [ ] **Step 2: Run** `python3 -m pytest tests/test_daw.py -q -k fx_and_session` → PASS (opaque JSON). Then `python3 -m pytest tests/ -q` → 89 passed.

- [ ] **Step 3: Commit**
```bash
git add tests/test_daw.py
git commit -m "test(daw): fx/cells/scenes persist in project data

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Engine — FX inserts on track chains

**Files:** Modify `static/daw-engine.js`

- [ ] **Step 1: Add FX node builders** (place above `_dawSyncChains`):
```javascript
function _dawImpulse(ctx, seconds = 2, decay = 2.5) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}
function _dawMakeEq(ctx) {
  const low = ctx.createBiquadFilter(); low.type = "lowshelf"; low.frequency.value = 320;
  const mid = ctx.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 1000; mid.Q.value = 1;
  const high = ctx.createBiquadFilter(); high.type = "highshelf"; high.frequency.value = 3200;
  low.connect(mid); mid.connect(high);
  return { input: low, output: high, low, mid, high };
}
function _dawMakeReverb(ctx) {
  const input = ctx.createGain(), output = ctx.createGain();
  const dry = ctx.createGain(); dry.gain.value = 1;
  const conv = ctx.createConvolver(); conv.buffer = _dawImpulse(ctx);
  const wet = ctx.createGain(); wet.gain.value = 0;
  input.connect(dry); dry.connect(output);
  input.connect(conv); conv.connect(wet); wet.connect(output);
  return { input, output, wet, dry, conv };
}
function _dawMakeDelay(ctx) {
  const input = ctx.createGain(), output = ctx.createGain();
  const dry = ctx.createGain(); dry.gain.value = 1;
  const delay = ctx.createDelay(2.0); delay.delayTime.value = 0.3;
  const fb = ctx.createGain(); fb.gain.value = 0;
  const wet = ctx.createGain(); wet.gain.value = 0;
  input.connect(dry); dry.connect(output);
  input.connect(delay); delay.connect(wet); wet.connect(output);
  delay.connect(fb); fb.connect(delay);
  return { input, output, delay, fb, wet, dry };
}

function dawEngineSetTrackFx(trackId, fx) {
  const chain = _dawTrackChains.get(trackId);
  if (!chain || !chain.eq) return;
  fx = fx || {};
  const eq = fx.eq || {}, rv = fx.reverb || {}, dl = fx.delay || {};
  chain.eq.low.gain.value  = eq.on ? (eq.low ?? 0) : 0;
  chain.eq.mid.gain.value  = eq.on ? (eq.mid ?? 0) : 0;
  chain.eq.high.gain.value = eq.on ? (eq.high ?? 0) : 0;
  chain.reverb.wet.gain.value = rv.on ? (rv.wet ?? 0.3) : 0;
  chain.delay.delay.delayTime.value = dl.time ?? 0.3;
  chain.delay.fb.gain.value  = dl.on ? (dl.feedback ?? 0.3) : 0;
  chain.delay.wet.gain.value = dl.on ? (dl.wet ?? 0.3) : 0;
}
```

- [ ] **Step 2: Splice FX into `_dawSyncChains`.** Replace the whole function with:
```javascript
function _dawSyncChains() {
  const ctx = _dawEnsureCtx();
  const ids = new Set(dawState.tracks.map(t => t.id));
  for (const [id, chain] of _dawTrackChains) {
    if (!ids.has(id)) {
      try {
        chain.gain.disconnect(); chain.pan.disconnect(); chain.analyser.disconnect();
        if (chain.eq) { chain.eq.low.disconnect(); chain.eq.mid.disconnect(); chain.eq.high.disconnect(); }
        if (chain.reverb) { chain.reverb.input.disconnect(); chain.reverb.dry.disconnect(); chain.reverb.conv.disconnect(); chain.reverb.wet.disconnect(); chain.reverb.output.disconnect(); }
        if (chain.delay) { chain.delay.input.disconnect(); chain.delay.dry.disconnect(); chain.delay.delay.disconnect(); chain.delay.fb.disconnect(); chain.delay.wet.disconnect(); chain.delay.output.disconnect(); }
      } catch (_) {}
      _dawTrackChains.delete(id);
    }
  }
  for (const t of dawState.tracks) {
    let chain = _dawTrackChains.get(t.id);
    if (!chain) {
      const gain = ctx.createGain();
      const eq = _dawMakeEq(ctx);
      const reverb = _dawMakeReverb(ctx);
      const delay = _dawMakeDelay(ctx);
      const pan = ctx.createStereoPanner();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      gain.connect(eq.input);
      eq.output.connect(reverb.input);
      reverb.output.connect(delay.input);
      delay.output.connect(pan);
      pan.connect(analyser); analyser.connect(_dawMaster);
      chain = { gain, pan, analyser, eq, reverb, delay };
      _dawTrackChains.set(t.id, chain);
    }
    chain.pan.pan.value = t.pan ?? 0;
    dawEngineSetTrackFx(t.id, t.fx);
  }
}
```

- [ ] **Step 3: Syntax check + commit**
```bash
node --check static/daw-engine.js
git add static/daw-engine.js
git commit -m "feat(daw): per-track EQ/Reverb/Delay FX inserts on mixer chains

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Engine — session looper

**Files:** Modify `static/daw-engine.js`

- [ ] **Step 1: Append the session looper** to the end of `static/daw-engine.js`:
```javascript
// ── Session grid looper (free-launch loops through track chains) ───────────────
const _dawGridActive = new Map();   // trackId → { src, sceneIdx }

async function dawLaunchCell(trackId, sceneIdx) {
  const track = dawState.tracks.find(t => t.id === trackId);
  if (!track || !track.cells) return;
  const ref = track.cells[sceneIdx];
  if (!ref) return;
  const ctx = _dawEnsureCtx();
  if (ctx.state === "suspended") await ctx.resume();
  _dawSyncChains(); _dawApplyMixState();
  dawStopCell(trackId);                       // one active cell per column
  const buf = await dawGetBuffer(ref.file);
  if (!buf) return;
  const chain = _dawTrackChains.get(trackId);
  if (!chain) return;
  const src = ctx.createBufferSource();
  src.buffer = buf; src.loop = true;
  src.connect(chain.gain);
  src.start();
  _dawGridActive.set(trackId, { src, sceneIdx });
  if (typeof dawRenderSessionIfOpen === "function") dawRenderSessionIfOpen();
}

function dawStopCell(trackId) {
  const a = _dawGridActive.get(trackId);
  if (a) { try { a.src.stop(); } catch (_) {} _dawGridActive.delete(trackId); }
  if (typeof dawRenderSessionIfOpen === "function") dawRenderSessionIfOpen();
}

function dawStopAllCells() {
  for (const [, a] of _dawGridActive) { try { a.src.stop(); } catch (_) {} }
  _dawGridActive.clear();
  if (typeof dawRenderSessionIfOpen === "function") dawRenderSessionIfOpen();
}

function dawCellActive(trackId) {
  const a = _dawGridActive.get(trackId);
  return a ? a.sceneIdx : -1;
}
```

- [ ] **Step 2: Syntax check + commit**
```bash
node --check static/daw-engine.js
git add static/daw-engine.js
git commit -m "feat(daw): session looper — launch/stop looping cells through track chains

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Project model — fx/cells/scenes + setters

**Files:** Modify `static/daw-project.js`

- [ ] **Step 1: Add helpers + default state.** At the top, after the `dawState` declaration line, add helpers:
```javascript
function _dawDefaultFx() {
  return { eq: { on: false, low: 0, mid: 0, high: 0 },
           reverb: { on: false, wet: 0.3 },
           delay: { on: false, time: 0.3, feedback: 0.3, wet: 0.3 } };
}
function _dawNormCells(cells, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push((cells && cells[i]) || null);
  return out;
}
```
Change the default `dawState` to include `scenes: 4`:
```javascript
let dawState = { id: null, name: "Untitled Project", tempo: 120, master_volume: 1.0, scenes: 4, tracks: [] };
```

- [ ] **Step 2: Default fx/cells on new tracks.** In `dawAddTrack`, change the pushed object to add `fx` and `cells`:
```javascript
  dawState.tracks.push({
    id: _dawUid("t"), name: name || ("Track " + (i + 1)),
    mute: false, solo: false, color: _TRACK_COLORS[i % _TRACK_COLORS.length],
    volume: 1.0, pan: 0.0, fx: _dawDefaultFx(), cells: _dawNormCells([], dawState.scenes ?? 4), clips: [],
  });
```

- [ ] **Step 3: Carry scenes/fx/cells through new/load/save.**
In `dawNewProject`, change the state init:
```javascript
  dawState = { id: r.id, name: r.name, tempo: 120, master_volume: 1.0, scenes: 4, tracks: [] };
```
In `dawLoadProject`, change the explicit-field extraction:
```javascript
  const d = p.data || {};
  const scenes = d.scenes ?? 4;
  dawState = { id: p.id, name: p.name, version: d.version || 1,
               tempo: d.tempo ?? 120, master_volume: d.master_volume ?? 1.0, scenes,
               tracks: (d.tracks || []).map(t => {
                 const tt = { volume: 1.0, pan: 0.0, ...t };
                 tt.fx = t.fx || _dawDefaultFx();
                 tt.cells = _dawNormCells(t.cells, scenes);
                 return tt;
               }) };
```
In `dawSaveNow`, change the `data` object:
```javascript
  const data = { version: 1, tempo: dawState.tempo, master_volume: dawState.master_volume,
                 scenes: dawState.scenes, tracks: dawState.tracks };
```

- [ ] **Step 4: Re-render the session grid on track add/remove.** In `_dawAfterMutate`, add the session hook:
```javascript
function _dawAfterMutate() {
  if (typeof renderTimeline === "function") renderTimeline();
  if (typeof dawRenderMixerIfOpen === "function") dawRenderMixerIfOpen();
  if (typeof dawRenderSessionIfOpen === "function") dawRenderSessionIfOpen();
  dawMarkDirty();
}
```

- [ ] **Step 5: Add the mutations** at the end of `static/daw-project.js`:
```javascript
// ── FX + session mutations ──────────────────────────────────────────────────────
function dawSetTrackFx(trackId, fx) {
  const t = dawState.tracks.find(t => t.id === trackId);
  if (!t) return;
  t.fx = fx;
  if (typeof dawEngineSetTrackFx === "function") dawEngineSetTrackFx(trackId, fx);
  if (typeof dawRenderMixerIfOpen === "function") dawRenderMixerIfOpen();
  dawMarkDirty();
}

function dawSetCell(trackId, sceneIdx, ref) {
  const t = dawState.tracks.find(t => t.id === trackId);
  if (!t || !t.cells) return;
  t.cells[sceneIdx] = ref;
  if (typeof dawRenderSessionIfOpen === "function") dawRenderSessionIfOpen();
  dawMarkDirty();
}

function dawAddScene() {
  dawState.scenes = (dawState.scenes ?? 4) + 1;
  for (const t of dawState.tracks) { (t.cells = t.cells || []).push(null); }
  if (typeof dawRenderSessionIfOpen === "function") dawRenderSessionIfOpen();
  dawMarkDirty();
}
```

- [ ] **Step 6: Syntax check + commit**
```bash
node --check static/daw-project.js
git add static/daw-project.js
git commit -m "feat(daw): fx/cells/scenes state, defaults, setters; session re-render hook

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Mixer FX button + panel

**Files:** Modify `static/daw-mixer.js`

- [ ] **Step 1: Add the FX button to each strip.** In `_dawStrip(track)`, find:
```javascript
  btns.appendChild(mk("S", track.solo, () => { dawToggleSolo(track.id); dawReschedule(); dawRenderMixer(); }));
```
and add right after it:
```javascript
  const fxOn = !!(track.fx && (track.fx.eq?.on || track.fx.reverb?.on || track.fx.delay?.on));
  const fxBtn = mk("FX", fxOn, () => openFxPanel(track.id, fxBtn));
  btns.appendChild(fxBtn);
```

- [ ] **Step 2: Add `openFxPanel`** at the end of `static/daw-mixer.js`:
```javascript
let _dawFxPanelEl = null;
function _dawCloseFxPanel() {
  if (!_dawFxPanelEl) return;
  _dawFxPanelEl.remove(); _dawFxPanelEl = null;
  document.removeEventListener("mousedown", _dawFxOutside);
  document.removeEventListener("keydown", _dawFxEsc);
}
function _dawFxOutside(e) { if (_dawFxPanelEl && !_dawFxPanelEl.contains(e.target)) _dawCloseFxPanel(); }
function _dawFxEsc(e) { if (e.key === "Escape") _dawCloseFxPanel(); }

function openFxPanel(trackId, anchor) {
  _dawCloseFxPanel();
  const track = dawState.tracks.find(t => t.id === trackId);
  if (!track) return;
  const fx = track.fx || { eq: {}, reverb: {}, delay: {} };
  const m = document.createElement("div");
  _dawFxPanelEl = m;
  m.style.cssText = "position:fixed;z-index:1000;background:#15171f;border:1px solid #2d3041;border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:6px;min-width:210px;box-shadow:0 4px 16px rgba(0,0,0,0.5)";
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 230) + "px";
  m.style.top = (r.bottom + 4) + "px";

  const apply = () => dawSetTrackFx(trackId, fx);
  const header = (label, key) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11px;color:#00d4b6;font-weight:bold";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!fx[key].on;
    cb.addEventListener("change", () => { fx[key].on = cb.checked; apply(); });
    const sp = document.createElement("span"); sp.textContent = label;
    row.appendChild(cb); row.appendChild(sp);
    return row;
  };
  const slider = (label, key, prop, min, max, step) => {
    const row = document.createElement("label");
    row.style.cssText = "font-size:10px;color:#e2e4ed;display:flex;align-items:center;gap:6px;justify-content:space-between";
    const sp = document.createElement("span"); sp.textContent = label;
    const inp = document.createElement("input");
    inp.type = "range"; inp.min = min; inp.max = max; inp.step = step;
    inp.value = fx[key][prop] ?? 0; inp.style.cssText = "width:110px";
    inp.addEventListener("input", () => { fx[key][prop] = parseFloat(inp.value); apply(); });
    row.appendChild(sp); row.appendChild(inp);
    return row;
  };

  m.appendChild(header("EQ", "eq"));
  m.appendChild(slider("Low dB", "eq", "low", -12, 12, 0.5));
  m.appendChild(slider("Mid dB", "eq", "mid", -12, 12, 0.5));
  m.appendChild(slider("High dB", "eq", "high", -12, 12, 0.5));
  m.appendChild(header("Reverb", "reverb"));
  m.appendChild(slider("Wet", "reverb", "wet", 0, 1, 0.01));
  m.appendChild(header("Delay", "delay"));
  m.appendChild(slider("Time s", "delay", "time", 0, 1, 0.01));
  m.appendChild(slider("Feedback", "delay", "feedback", 0, 0.9, 0.01));
  m.appendChild(slider("Wet", "delay", "wet", 0, 1, 0.01));

  document.body.appendChild(m);
  setTimeout(() => {
    document.addEventListener("mousedown", _dawFxOutside);
    document.addEventListener("keydown", _dawFxEsc);
  }, 0);
}
```

- [ ] **Step 3: Syntax check + commit**
```bash
node --check static/daw-mixer.js
git add static/daw-mixer.js
git commit -m "feat(daw): mixer FX button + EQ/Reverb/Delay panel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Session grid panel

**Files:** Create `static/daw-session.js`

- [ ] **Step 1: Create the module** with exactly this content:
```javascript
// ── DAW session grid (clip-launch looper) ─────────────────────────────────────
let _dawSessionOpen = false;

function dawRenderSessionIfOpen() { if (_dawSessionOpen) dawRenderSession(); }

function dawRenderSession() {
  const host = document.getElementById("daw-session-grid");
  if (!host) return;
  const scenes = dawState.scenes ?? 4;
  host.innerHTML = "";
  host.style.cssText = "display:flex;gap:4px;overflow-x:auto;align-items:flex-start";
  for (const track of dawState.tracks) {
    const col = document.createElement("div");
    col.style.cssText = `display:flex;flex-direction:column;gap:4px;min-width:96px;border-top:2px solid ${track.color}`;
    const hdr = document.createElement("div");
    hdr.textContent = track.name;
    hdr.style.cssText = "font-size:10px;color:#e2e4ed;padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    col.appendChild(hdr);
    const active = (typeof dawCellActive === "function") ? dawCellActive(track.id) : -1;
    for (let s = 0; s < scenes; s++) {
      const ref = (track.cells || [])[s] || null;
      const cell = document.createElement("div");
      const isActive = active === s;
      cell.style.cssText = "height:34px;border-radius:3px;font-size:9px;padding:3px;overflow:hidden;cursor:pointer;display:flex;align-items:center;" +
        (ref ? ("background:" + track.color + "22;border:1px solid " + track.color + ";color:#e2e4ed")
             : "background:#0b0c10;border:1px dashed #2d3041;color:#5a5f6e;justify-content:center");
      if (isActive) cell.style.boxShadow = "0 0 0 2px #00d4b6";
      cell.textContent = ref ? ((isActive ? "▶ " : "") + ref.name) : "drop clip";
      cell.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
      cell.addEventListener("drop", e => {
        e.preventDefault();
        const raw = e.dataTransfer.getData("application/x-daw-clip");
        if (!raw) return;
        const src = JSON.parse(raw);
        dawSetCell(track.id, s, { file: src.file, name: src.name || src.file });
      });
      cell.addEventListener("click", () => {
        if (!(track.cells || [])[s]) return;
        if ((typeof dawCellActive === "function" ? dawCellActive(track.id) : -1) === s) dawStopCell(track.id);
        else dawLaunchCell(track.id, s);
      });
      col.appendChild(cell);
    }
    host.appendChild(col);
  }
}
```

- [ ] **Step 2: Syntax check + commit**
```bash
node --check static/daw-session.js
git add static/daw-session.js
git commit -m "feat(daw): session grid panel — drop clips into cells, click to loop

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Glue — Session toggle + markup + cache-busts

**Files:** Modify `static/daw.js`, `templates/index.html`

- [ ] **Step 1: Wire the Session toggle in `daw.js`.** In `_dawWireTransport()`, after the mixer-toggle listener block's closing `});`, add:
```javascript
  document.getElementById("daw-session-toggle").addEventListener("click", () => {
    const panel = document.getElementById("daw-session-panel");
    const show = panel.style.display === "none" || !panel.style.display;
    panel.style.display = show ? "block" : "none";
    if (show) { _dawSessionOpen = true; dawRenderSession(); }
    else { _dawSessionOpen = false; }
  });
  document.getElementById("daw-session-stopall").addEventListener("click", () => dawStopAllCells());
  document.getElementById("daw-session-addscene").addEventListener("click", () => dawAddScene());
```

- [ ] **Step 2: Add the Session button to the transport** in `templates/index.html`. After:
```html
        <button class="secondary small" id="daw-export" title="Render the arrangement to a WAV file">⬇ Export WAV</button>
```
add:
```html
        <button class="secondary small" id="daw-session-toggle" title="Show/hide session looper grid">🎛 Session</button>
```

- [ ] **Step 3: Add the session panel** in `templates/index.html`. After the `#daw-mixer-panel` closing `</div>` (find `id="daw-mixer-panel"` and its matching close), add:
```html
      <div id="daw-session-panel" style="display:none;border:1px solid #2d3041;border-top:none;border-radius:0 0 6px 6px;padding:8px;background:#101218">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <strong style="font-size:12px;color:#00d4b6">🎛 Session</strong>
          <button class="secondary small" id="daw-session-stopall" style="font-size:11px">⏹ Stop All</button>
          <button class="secondary small" id="daw-session-addscene" style="font-size:11px">+ Scene</button>
        </div>
        <div id="daw-session-grid"></div>
      </div>
```

- [ ] **Step 4: Add the script tag + cache-busts.** Add `<script src="/static/daw-session.js?v=1"></script>` immediately after the `daw-ai.js` script tag and before `daw.js`. Bump: `daw-engine.js` v6→v7, `daw-project.js` v6→v7, `daw-mixer.js` v2→v3, `daw.js` v6→v7.

- [ ] **Step 5: Verify + restart**
```bash
node --check static/daw.js
sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health
curl -s http://127.0.0.1:8001/ | grep -c 'id="daw-session-panel"'        # 1
curl -s http://127.0.0.1:8001/ | grep -c 'id="daw-session-toggle"'       # 1
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8001/static/daw-session.js?v=1"  # 200
```

- [ ] **Step 6: Commit**
```bash
git add static/daw.js templates/index.html
git commit -m "feat(daw): Session transport toggle + grid panel markup + cache-busts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: End-to-end live verification

**Files:** Create `/tmp/daw_fxsession_verify.py` (throwaway)

- [ ] **Step 1: Write the driver.**
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

    # Fresh project, one track, one clip
    page.evaluate("async()=>{ await dawNewProject('P6Check'); }"); page.wait_for_timeout(1000)
    page.evaluate("""()=>{ const t=dawState.tracks[0];
        dawAddClip(t.id, {file:_dawLibItems[0].file, name:_dawLibItems[0].name, source_duration:_dawLibItems[0].duration||12}, 0);}""")
    page.wait_for_timeout(400)
    tid = page.evaluate("dawState.tracks[0].id")

    # ── FX: set reverb on + eq high, confirm state + engine nodes exist ──
    page.evaluate(f"""dawSetTrackFx('{tid}', {{eq:{{on:true,low:0,mid:0,high:6}}, reverb:{{on:true,wet:0.7}}, delay:{{on:false,time:0.3,feedback:0.3,wet:0.3}}}})""")
    fx = page.evaluate("dawState.tracks[0].fx")
    print("fx state:", {"eq_on": fx["eq"]["on"], "high": fx["eq"]["high"], "rev_on": fx["reverb"]["on"], "wet": fx["reverb"]["wet"]})
    # force chain build + confirm reverb wet gain applied on the live node
    page.evaluate("()=>{ _dawSyncChains(); }")
    wet = page.evaluate(f"""()=>{{ const c=_dawTrackChains.get('{tid}'); return c&&c.reverb? c.reverb.wet.gain.value : -1; }}""")
    high = page.evaluate(f"""()=>{{ const c=_dawTrackChains.get('{tid}'); return c&&c.eq? c.eq.high.gain.value : -999; }}""")
    print("engine reverb wet:", round(wet,2), "| eq high dB:", high, "| FX APPLIED:", abs(wet-0.7)<0.01 and abs(high-6)<0.01)

    # ── Session: put the clip in a cell, launch it, confirm active + audio ──
    page.click("#daw-session-toggle"); page.wait_for_timeout(400)
    print("session panel visible:", page.is_visible("#daw-session-panel"))
    page.evaluate(f"""dawSetCell('{tid}', 0, {{file:_dawLibItems[0].file, name:_dawLibItems[0].name}})""")
    page.wait_for_timeout(200)
    page.evaluate(f"async()=>{{ await dawLaunchCell('{tid}', 0); }}")
    page.wait_for_timeout(1500)
    active = page.evaluate(f"dawCellActive('{tid}')")
    peak = page.evaluate(f"dawEngineTrackPeak('{tid}')")
    print("cell active scene:", active, "| track peak while looping:", round(peak,3), "| LOOPING:", active==0 and peak>0.001)
    page.evaluate("dawStopAllCells()")
    page.wait_for_timeout(300)
    print("after stop all, active:", page.evaluate(f"dawCellActive('{tid}')"))

    # ── Persistence: autosave → reload → reopen ──
    page.wait_for_timeout(1200)
    pid = page.evaluate("dawState.id")
    page.reload(wait_until="domcontentloaded"); page.wait_for_selector("#btn-generate", timeout=15000); page.wait_for_timeout(800)
    page.click('[data-tab="daw"]'); page.wait_for_timeout(2000)
    persisted = page.evaluate(f"""async()=>{{ await dawLoadProject({pid});
        const t=dawState.tracks[0];
        return {{rev_on:t.fx.reverb.on, wet:t.fx.reverb.wet, cell0:!!(t.cells&&t.cells[0]), scenes:dawState.scenes}}; }}""")
    print("persisted:", persisted)
    print("PAGE ERRORS:", errs)
    page.screenshot(path="/tmp/daw_fxsession_verify.png", full_page=True)
    ctx.close(); b.close()
print("FXSESSION VERIFY DONE")
```

- [ ] **Step 2: Run** `cd /tmp && python3 daw_fxsession_verify.py`
Expected: `fx state` shows eq_on True/high 6/rev_on True/wet 0.7; `FX APPLIED: True` (engine reverb wet 0.7, eq high 6 dB on the live nodes); `session panel visible: True`; `cell active scene: 0` with `track peak > 0` → `LOOPING: True`; after Stop All active `-1`; `persisted` shows rev_on True, wet 0.7, cell0 True, scenes 4; `PAGE ERRORS: []`.

- [ ] **Step 3: Inspect** `/tmp/daw_fxsession_verify.png` — mixer strips show an FX button; the Session panel shows a per-track column with cells (one filled).

- [ ] **Step 4: Regression** `python3 -m pytest tests/ -q` (89 passed) and `for f in daw-engine daw-project daw-mixer daw-session daw; do node --check static/$f.js; done`.

No commit (driver is throwaway). If a fix was needed, commit with `fix(daw):` and re-run.

---

## Self-Review

**Spec coverage:**
- FX node builders (EQ 3-band, Reverb convolver+wet, Delay+feedback+wet) + impulse → Task 2 ✓
- Chain splice `gain→eq→reverb→delay→pan→analyser→master`; FX always present; disabled=neutral → Task 2 ✓
- `dawEngineSetTrackFx` live params + apply on chain build + disconnect cleanup → Task 2 ✓
- Session looper `dawLaunchCell/dawStopCell/dawStopAllCells/dawCellActive` routing loops through `chain.gain` → Task 3 ✓
- Track `fx` + `cells` defaults, `scenes`, load/save normalization → Task 4 ✓
- `dawSetTrackFx`, `dawSetCell`, `dawAddScene` + `_dawAfterMutate` session hook → Task 4 ✓
- Mixer FX button + `openFxPanel` (EQ/Reverb/Delay controls) → Task 5 ✓
- Session grid panel: columns=tracks, scene rows, drop-to-cell (`application/x-daw-clip`), click-to-launch/toggle, active highlight → Task 6 ✓
- 🎛 Session toggle, Stop All, + Scene, markup, script, cache-busts → Task 7 ✓
- Persistence test → Task 1; live FX+session+persist verification → Task 8 ✓
- Edge cases (missing fx/cells defaults, FX off=neutral, live FX change, missing cell file no-op, one-active-per-column, toggle-off, mute/solo applies via chain.gain, non-clip drop ignored) → Tasks 2–6; verified Task 8 ✓

**Placeholder scan:** none — complete code + exact commands throughout.

**Type/name consistency:** `dawEngineSetTrackFx`, `_dawMakeEq/_dawMakeReverb/_dawMakeDelay/_dawImpulse`, `_dawGridActive`, `dawLaunchCell/dawStopCell/dawStopAllCells/dawCellActive` (engine) ↔ `dawSetTrackFx`, `dawSetCell`, `dawAddScene`, `_dawDefaultFx`, `_dawNormCells` (project) ↔ `openFxPanel` (mixer) ↔ `dawRenderSession`, `dawRenderSessionIfOpen`, `_dawSessionOpen` (session) ↔ toggles in daw.js. Chain object `{gain,pan,analyser,eq,reverb,delay}` consistent across Tasks 2–3,5. `track.fx` shape consistent across Tasks 1,2,4,5,8. Element ids `daw-session-panel/-toggle/-grid/-stopall/-addscene` consistent across Tasks 6–8. Reuses `dawEngineTrackPeak` (Phase 2) in the Task 8 audio check.
