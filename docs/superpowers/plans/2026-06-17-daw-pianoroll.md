# DAW Piano-Roll Editor (Stage 2B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bottom-panel piano-roll to draw/move/resize/delete/select MIDI notes with velocity + audible preview, opened from a MIDI lane, edits reflected on the timeline and persisted.

**Architecture:** A new `daw-pianoroll.js` renders a scrollable pitch×time grid for the active MIDI track, mutating `track.notes` in place via small project mutations; drags update the dragged element directly (full re-render only on add/delete/drop) to stay smooth and preserve scroll. A short synth preview reuses the Stage-2A engine helpers.

**Tech Stack:** vanilla JS, Web Audio (reuse 2A synth), Playwright.

**Spec:** `docs/superpowers/specs/2026-06-17-daw-pianoroll-design.md`

**Conventions:** repo `/home/legion/legionprojects/nyx-step`, branch `master`. `node --check`. Restart `sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health`. Bump `?v=` in `templates/index.html`. Tests `python3 -m pytest tests/ -q` (baseline **95**, no backend change). Commit per task (`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`); don't push.

**Anchors:** `track.notes:[{start,dur,pitch,vel}]`; `_dawAfterMutate` (daw-project.js) calls renderTimeline + mixer/session re-renders + `dawMarkDirty`; engine has `_dawEnsureCtx`, `_dawSyncChains`, `_dawTrackChains`, `_dawMaster`, `_dawApplyAdsr`; `_dawNoteFreq` in daw-midi.js; `_dawSnapSec`/`_dawSnapDiv`/`_dawPxPerSec`/`dawArrangementLength`; timeline MIDI lane built in `renderTimeline` (the `if (track.kind === "midi")` branch) and `dawRenderTrackHeaders` (MIDI block with a `mk(label,on,fn,title)` button helper); panels mirror `#daw-session-panel`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `static/daw-project.js` | modify | `dawAddNote`/`dawRemoveNote`/`dawNoteEdited`; `dawRenderPianoRollIfOpen` in `_dawAfterMutate` |
| `static/daw-engine.js` | modify | `dawPreviewNote(trackId, pitch, vel)` |
| `static/daw-pianoroll.js` | **create** | panel/grid render + note interactions + open/close |
| `static/daw-timeline.js` | modify | MIDI lane `dblclick` + header **🎹** edit button |
| `templates/index.html` | modify | `#daw-pianoroll-panel` + script + cache-busts |

Script order: `daw-pianoroll.js` after `daw-midi.js`, before `daw.js`.

---

### Task 1: Project note mutations + render hook

**Files:** Modify `static/daw-project.js`

- [ ] **Step 1: Add mutations** at the end of the file:
```javascript
function dawAddNote(trackId, note) {
  const t = dawState.tracks.find(t => t.id === trackId); if (!t) return null;
  (t.notes = t.notes || []).push(note); _dawAfterMutate(); return note;
}
function dawRemoveNote(trackId, note) {
  const t = dawState.tracks.find(t => t.id === trackId); if (!t || !t.notes) return;
  t.notes = t.notes.filter(n => n !== note); _dawAfterMutate();
}
function dawNoteEdited(trackId) { _dawAfterMutate(); }
```

- [ ] **Step 2: Add the re-render hook** in `_dawAfterMutate`, after the session line:
```javascript
  if (typeof dawRenderPianoRollIfOpen === "function") dawRenderPianoRollIfOpen();
```

- [ ] **Step 3:** `node --check static/daw-project.js`; commit:
```bash
git add static/daw-project.js
git commit -m "feat(daw): note mutations (add/remove/edited) + piano-roll re-render hook

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Engine — preview note

**Files:** Modify `static/daw-engine.js`

- [ ] **Step 1: Add `dawPreviewNote`** (after `_dawScheduleMidiTrack`):
```javascript
function dawPreviewNote(trackId, pitch, vel) {
  const ctx = _dawEnsureCtx();
  if (ctx.state === "suspended") { try { ctx.resume(); } catch (_) {} }
  const track = dawState.tracks.find(t => t.id === trackId);
  const synth = (track && track.synth) || { wave: "sawtooth", env: "pluck" };
  try { _dawSyncChains(); } catch (_) {}
  const chain = _dawTrackChains.get(trackId);
  const dest = chain ? chain.gain : _dawMaster;
  if (!dest) return;
  const now = ctx.currentTime + 0.01;
  const osc = ctx.createOscillator(); osc.type = synth.wave || "sawtooth";
  osc.frequency.value = (typeof _dawNoteFreq === "function") ? _dawNoteFreq(pitch) : 440 * Math.pow(2, (pitch - 69) / 12);
  const g = ctx.createGain();
  const peak = Math.max(0.001, ((vel || 100) / 127) * 0.3);
  _dawApplyAdsr(g.gain, now, 0.22, peak, synth.env || "pluck");
  osc.connect(g); g.connect(dest);
  osc.start(now); osc.stop(now + 0.4);
}
```

- [ ] **Step 2:** `node --check static/daw-engine.js`; commit:
```bash
git add static/daw-engine.js
git commit -m "feat(daw): dawPreviewNote — short synth blip through the track chain

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Piano-roll editor module

**Files:** Create `static/daw-pianoroll.js`

- [ ] **Step 1: Create `static/daw-pianoroll.js`** with exactly:
```javascript
// ── DAW piano-roll editor ─────────────────────────────────────────────────────
const _DAW_PR_ROW_H = 12;     // px per semitone
const _DAW_PR_LO = 24;        // C1
const _DAW_PR_HI = 96;        // C7
let _dawPROpen = false;
let _dawPRTrackId = null;
let _dawPRSelected = null;
let _dawPRLastDur = 0;

function _dawPRTrack() { return dawState.tracks.find(t => t.id === _dawPRTrackId) || null; }
function _dawPRSnapStep() { return (typeof _dawSnapDiv === "function" && dawState.snap) ? _dawSnapDiv() : 0.25; }

function openPianoRoll(trackId) {
  const t = dawState.tracks.find(x => x.id === trackId);
  if (!t || t.kind !== "midi") return;
  _dawPRTrackId = trackId; _dawPROpen = true; _dawPRSelected = null;
  const panel = document.getElementById("daw-pianoroll-panel");
  if (panel) panel.style.display = "block";
  dawRenderPianoRoll();
  const body = document.getElementById("daw-pr-body");
  if (body) {
    const notes = t.notes || [];
    const ref = notes.length ? Math.round(notes.reduce((a, n) => a + n.pitch, 0) / notes.length) : 60;
    body.scrollTop = Math.max(0, (_DAW_PR_HI - ref) * _DAW_PR_ROW_H - body.clientHeight / 2);
  }
}
function dawClosePianoRoll() {
  _dawPROpen = false; _dawPRSelected = null;
  const panel = document.getElementById("daw-pianoroll-panel");
  if (panel) panel.style.display = "none";
}
function dawRenderPianoRollIfOpen() {
  if (!_dawPROpen) return;
  if (!_dawPRTrack()) { dawClosePianoRoll(); return; }
  dawRenderPianoRoll();
}

function _dawPRRefreshSelection() {
  const vel = document.querySelector("#daw-pianoroll-panel input[type=range]");
  if (vel) { vel.disabled = !_dawPRSelected; if (_dawPRSelected) vel.value = _dawPRSelected.vel; }
  const grid = document.getElementById("daw-pr-grid");
  if (!grid) return;
  for (const el of grid.children) {
    if (!el._note) continue;
    el.style.outline = (el._note === _dawPRSelected) ? "2px solid #00d4b6" : "none";
    el.style.zIndex = (el._note === _dawPRSelected) ? "2" : "1";
  }
}

function dawRenderPianoRoll() {
  const panel = document.getElementById("daw-pianoroll-panel");
  const t = _dawPRTrack();
  if (!panel || !t) return;
  const prev = document.getElementById("daw-pr-body");
  const sTop = prev ? prev.scrollTop : -1, sLeft = prev ? prev.scrollLeft : 0;
  panel.innerHTML = "";

  // toolbar
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:6px";
  const title = document.createElement("strong");
  title.textContent = "🎹 " + t.name; title.style.cssText = "font-size:12px;color:#00d4b6";
  const velLab = document.createElement("label");
  velLab.style.cssText = "font-size:11px;color:#e2e4ed;display:flex;align-items:center;gap:4px";
  velLab.textContent = "Vel";
  const vel = document.createElement("input");
  vel.type = "range"; vel.min = "0"; vel.max = "127"; vel.step = "1";
  vel.value = _dawPRSelected ? _dawPRSelected.vel : 100; vel.disabled = !_dawPRSelected;
  vel.style.cssText = "width:120px";
  vel.addEventListener("input", () => {
    if (!_dawPRSelected) return;
    _dawPRSelected.vel = parseInt(vel.value, 10);
    const grid = document.getElementById("daw-pr-grid");
    if (grid) for (const el of grid.children) if (el._note === _dawPRSelected)
      el.style.opacity = (0.35 + 0.5 * (_dawPRSelected.vel / 127));
    dawMarkDirty();
  });
  velLab.appendChild(vel);
  const count = document.createElement("span");
  count.style.cssText = "font-size:11px;color:#5a5f6e"; count.textContent = (t.notes || []).length + " notes";
  const close = document.createElement("button");
  close.className = "secondary small"; close.textContent = "✕ Close";
  close.style.cssText = "font-size:11px;margin-left:auto"; close.addEventListener("click", dawClosePianoRoll);
  bar.appendChild(title); bar.appendChild(velLab); bar.appendChild(count); bar.appendChild(close);
  panel.appendChild(bar);

  // body
  const rows = _DAW_PR_HI - _DAW_PR_LO + 1;
  const totalH = rows * _DAW_PR_ROW_H;
  const body = document.createElement("div");
  body.id = "daw-pr-body";
  body.style.cssText = "display:flex;height:240px;overflow:auto;border:1px solid #2d3041;border-radius:4px;background:#0b0c10";

  // keyboard gutter
  const keys = document.createElement("div");
  keys.style.cssText = `position:sticky;left:0;z-index:3;width:42px;flex:0 0 42px;height:${totalH}px;background:#15171f;border-right:1px solid #2d3041`;
  const black = new Set([1, 3, 6, 8, 10]);
  for (let p = _DAW_PR_HI; p >= _DAW_PR_LO; p--) {
    const k = document.createElement("div");
    const isBlack = black.has(((p % 12) + 12) % 12);
    k.style.cssText = `height:${_DAW_PR_ROW_H}px;font-size:8px;color:${isBlack ? "#888" : "#cfd3df"};` +
      `background:${isBlack ? "#1a1c26" : "#22252f"};border-bottom:1px solid #14151c;padding-left:3px;cursor:pointer;box-sizing:border-box`;
    if (p % 12 === 0) k.textContent = "C" + (p / 12 - 1);
    k.addEventListener("mousedown", () => { if (typeof dawPreviewNote === "function") dawPreviewNote(_dawPRTrackId, p, 100); });
    keys.appendChild(k);
  }
  body.appendChild(keys);

  // grid
  const arr = (typeof dawArrangementLength === "function") ? dawArrangementLength() : 16;
  const gridW = Math.max(panel.clientWidth || 600, Math.max(16, arr) * _dawPxPerSec);
  const grid = document.createElement("div");
  grid.id = "daw-pr-grid";
  const stepPx = Math.max(2, _dawPRSnapStep() * _dawPxPerSec);
  grid.style.cssText = `position:relative;height:${totalH}px;width:${gridW}px;` +
    `background-image:repeating-linear-gradient(0deg, rgba(255,255,255,0.04) 0 1px, transparent 1px ${_DAW_PR_ROW_H}px),` +
    `repeating-linear-gradient(90deg, rgba(255,255,255,0.05) 0 1px, transparent 1px ${stepPx}px)`;
  for (const n of (t.notes || [])) {
    const el = document.createElement("div");
    el._note = n;
    const top = (_DAW_PR_HI - n.pitch) * _DAW_PR_ROW_H;
    el.style.cssText = `position:absolute;left:${n.start * _dawPxPerSec}px;top:${top}px;` +
      `width:${Math.max(4, n.dur * _dawPxPerSec)}px;height:${_DAW_PR_ROW_H - 2}px;` +
      `background:${t.color};opacity:${0.35 + 0.5 * (n.vel / 127)};border-radius:2px;cursor:grab;` +
      (n === _dawPRSelected ? "outline:2px solid #00d4b6;z-index:2" : "z-index:1");
    const handle = document.createElement("div");
    handle.style.cssText = "position:absolute;right:0;top:0;width:5px;height:100%;cursor:ew-resize";
    el.appendChild(handle);
    _dawPRWireNote(el, handle, n, grid);
    grid.appendChild(el);
  }
  _dawPRWireGrid(grid);
  body.appendChild(grid);
  panel.appendChild(body);
  if (sTop >= 0) { body.scrollTop = sTop; body.scrollLeft = sLeft; }
}

function _dawPRPitchFromY(grid, clientY) {
  const r = grid.getBoundingClientRect();
  const p = _DAW_PR_HI - Math.floor((clientY - r.top) / _DAW_PR_ROW_H);
  return Math.max(_DAW_PR_LO, Math.min(_DAW_PR_HI, p));
}

function _dawPRWireGrid(grid) {
  grid.addEventListener("mousedown", e => {
    if (e.target !== grid) return;            // empty grid only
    const r = grid.getBoundingClientRect();
    const rawStart = (e.clientX - r.left) / _dawPxPerSec;
    const start = Math.max(0, (typeof _dawSnapSec === "function") ? _dawSnapSec(rawStart, e.ctrlKey) : rawStart);
    const pitch = _dawPRPitchFromY(grid, e.clientY);
    const dur = _dawPRLastDur || _dawPRSnapStep();
    const velEl = document.querySelector("#daw-pianoroll-panel input[type=range]");
    const vel = (velEl && !velEl.disabled) ? parseInt(velEl.value, 10) : 100;
    const note = { start, dur, pitch, vel };
    dawAddNote(_dawPRTrackId, note);          // full re-render
    _dawPRSelected = note; _dawPRRefreshSelection();
    if (typeof dawPreviewNote === "function") dawPreviewNote(_dawPRTrackId, pitch, vel);
  });
}

function _dawPRWireNote(el, handle, note, grid) {
  handle.addEventListener("mousedown", e => {
    e.stopPropagation();
    const startX = e.clientX, origDur = note.dur, step = _dawPRSnapStep();
    const onMove = m => {
      const dx = (m.clientX - startX) / _dawPxPerSec;
      const rawEnd = note.start + Math.max(0.02, origDur + dx);
      const snapped = (typeof _dawSnapSec === "function") ? _dawSnapSec(rawEnd, m.ctrlKey) : rawEnd;
      note.dur = Math.max(step, snapped - note.start);
      _dawPRLastDur = note.dur;
      el.style.width = Math.max(4, note.dur * _dawPxPerSec) + "px";
      dawMarkDirty();
    };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); dawNoteEdited(_dawPRTrackId); };
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
  });
  el.addEventListener("mousedown", e => {
    if (e.target === handle) return;
    e.stopPropagation();
    _dawPRSelected = note; _dawPRRefreshSelection();
    const startX = e.clientX, origStart = note.start;
    let moved = false;
    const onMove = m => {
      moved = true;
      const dx = (m.clientX - startX) / _dawPxPerSec;
      note.start = Math.max(0, (typeof _dawSnapSec === "function") ? _dawSnapSec(Math.max(0, origStart + dx), m.ctrlKey) : Math.max(0, origStart + dx));
      note.pitch = _dawPRPitchFromY(grid, m.clientY);
      el.style.left = (note.start * _dawPxPerSec) + "px";
      el.style.top = ((_DAW_PR_HI - note.pitch) * _DAW_PR_ROW_H) + "px";
      dawMarkDirty();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp);
      if (moved && typeof dawPreviewNote === "function") dawPreviewNote(_dawPRTrackId, note.pitch, note.vel);
      dawNoteEdited(_dawPRTrackId);
    };
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
  });
  el.addEventListener("dblclick", e => {
    e.stopPropagation();
    dawRemoveNote(_dawPRTrackId, note);
    if (_dawPRSelected === note) _dawPRSelected = null;
  });
}

document.addEventListener("keydown", e => {
  if (!_dawPROpen || !_dawPRSelected) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  if (e.key === "Delete" || e.key === "Backspace") {
    dawRemoveNote(_dawPRTrackId, _dawPRSelected); _dawPRSelected = null; e.preventDefault();
  }
});
```

- [ ] **Step 2:** `node --check static/daw-pianoroll.js`; commit:
```bash
git add static/daw-pianoroll.js
git commit -m "feat(daw): piano-roll editor — grid, draw/move/resize/delete/velocity, preview

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Timeline hooks — open the editor

**Files:** Modify `static/daw-timeline.js`. READ the MIDI lane branch in `renderTimeline` and the MIDI block in `dawRenderTrackHeaders`.

- [ ] **Step 1: Double-click a MIDI lane.** In `renderTimeline`'s `if (track.kind === "midi") {` branch, after the lane's note blocks are appended and before `lanes.appendChild(lane); continue;`, add:
```javascript
      lane.addEventListener("dblclick", () => { if (typeof openPianoRoll === "function") openPianoRoll(track.id); });
```

- [ ] **Step 2: Header edit button.** In `dawRenderTrackHeaders`, inside the existing `if (t.kind === "midi") {` block (where `wave`/`outSel` are built), append an edit button to the buttons row `btns` (the `mk(label,on,fn,title)` helper is in scope):
```javascript
      btns.appendChild(mk("🎹", false, () => { if (typeof openPianoRoll === "function") openPianoRoll(t.id); }, "Edit notes (piano roll)"));
```
(Place this line inside the `if (t.kind === "midi")` block, before `row.appendChild(midiRow);`.)

- [ ] **Step 3:** `node --check static/daw-timeline.js`; commit:
```bash
git add static/daw-timeline.js
git commit -m "feat(daw): open piano-roll from MIDI lane dbl-click + header button

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Glue + live verification

**Files:** Modify `templates/index.html`; create `/tmp/daw_pr_verify.py`

- [ ] **Step 1: Add the panel** in `templates/index.html` immediately after the `#daw-session-panel` closing `</div>`:
```html
      <div id="daw-pianoroll-panel" style="display:none;border:1px solid #2d3041;border-top:none;border-radius:0 0 6px 6px;padding:8px;background:#101218"></div>
```

- [ ] **Step 2: Script + cache-busts.** Add `<script src="/static/daw-pianoroll.js?v=1"></script>` immediately after the `daw-midi.js` tag. Bump: `daw-project.js` v10→v11, `daw-engine.js` v9→v10, `daw-timeline.js` v9→v10.

- [ ] **Step 3: Verify serving.**
```bash
cd /home/legion/legionprojects/nyx-step
node --check static/daw-pianoroll.js
sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health
curl -s http://127.0.0.1:8001/ | grep -c 'id="daw-pianoroll-panel"'                 # 1
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8001/static/daw-pianoroll.js?v=1"   # 200
```

- [ ] **Step 4: Driver** (`/tmp/daw_pr_verify.py`):
```python
from playwright.sync_api import sync_playwright
BASE="http://127.0.0.1:8001"; HDR={"Cf-Access-Authenticated-User-Email":"steve.j.petry@gmail.com"}
with sync_playwright() as pw:
    b=pw.chromium.launch(); ctx=b.new_context(viewport={"width":1400,"height":950},extra_http_headers=HDR)
    page=ctx.new_page(); errs=[]; page.on("pageerror",lambda e:errs.append(str(e)))
    page.goto(BASE,wait_until="domcontentloaded"); page.wait_for_selector("#btn-generate",timeout=15000)
    try: page.wait_for_load_state("networkidle",timeout=20000)
    except Exception: pass
    page.click('[data-tab="daw"]'); page.wait_for_timeout(2500)
    page.evaluate("async()=>{ await dawNewProject('PRCheck'); }"); page.wait_for_timeout(800)
    page.click("#daw-add-midi-track"); page.wait_for_timeout(300)
    tid=page.evaluate("()=>dawState.tracks.find(t=>t.kind==='midi').id")
    page.evaluate(f"()=>openPianoRoll('{tid}')"); page.wait_for_timeout(300)
    print("panel visible:", page.is_visible("#daw-pianoroll-panel"))
    print("keyboard keys:", page.evaluate("()=>document.querySelectorAll('#daw-pr-body > div:first-child > div').length"))
    # Add a note via the same path the grid handler uses
    page.evaluate(f"()=>{{ dawAddNote('{tid}', {{start:0.0,dur:0.5,pitch:60,vel:100}}); _dawPRSelected=dawState.tracks.find(t=>t.id==='{tid}').notes[0]; dawRenderPianoRoll(); }}")
    page.wait_for_timeout(200)
    print("notes after add:", page.evaluate(f"()=>dawState.tracks.find(t=>t.id==='{tid}').notes.length"))
    print("note blocks in grid:", page.evaluate("()=>document.querySelectorAll('#daw-pr-grid > div').length"))
    # Velocity via slider
    page.eval_on_selector("#daw-pianoroll-panel input[type=range]", "el=>{ el.value=40; el.dispatchEvent(new Event('input')); }")
    page.wait_for_timeout(100)
    print("vel after slider:", page.evaluate(f"()=>dawState.tracks.find(t=>t.id==='{tid}').notes[0].vel"))
    # Move + resize via mutations (same as handlers do), then dawNoteEdited
    page.evaluate(f"""()=>{{ const n=dawState.tracks.find(t=>t.id==='{tid}').notes[0]; n.start=2.0; n.pitch=67; n.dur=1.0; dawNoteEdited('{tid}'); }}""")
    page.wait_for_timeout(200)
    print("after edit:", page.evaluate(f"()=>{{ const n=dawState.tracks.find(t=>t.id==='{tid}').notes[0]; return {{start:n.start,pitch:n.pitch,dur:n.dur}}; }}"))
    print("timeline lane blocks:", page.evaluate("()=>document.querySelectorAll('#daw-lanes > div:last-child > div').length"))
    # Preview audible
    page.evaluate(f"()=>{{ dawSeek(0); }}")
    page.evaluate(f"()=>dawPreviewNote('{tid}', 72, 110)"); page.wait_for_timeout(700)
    print("preview peak:", round(page.evaluate(f"()=>dawEngineTrackPeak('{tid}')"),4))
    # Delete
    page.evaluate(f"()=>{{ _dawPRSelected=dawState.tracks.find(t=>t.id==='{tid}').notes[0]; dawRemoveNote('{tid}', _dawPRSelected); }}")
    page.wait_for_timeout(200)
    print("notes after delete:", page.evaluate(f"()=>dawState.tracks.find(t=>t.id==='{tid}').notes.length"))
    # add one back + persist
    page.evaluate(f"()=>dawAddNote('{tid}', {{start:1.0,dur:0.5,pitch:64,vel:90}})")
    page.wait_for_timeout(1200); pid=page.evaluate("()=>dawState.id")
    page.reload(wait_until="domcontentloaded"); page.wait_for_selector("#btn-generate",timeout=15000); page.wait_for_timeout(800)
    page.click('[data-tab="daw"]'); page.wait_for_timeout(1500)
    per=page.evaluate(f"""async()=>{{ await dawLoadProject({pid}); const t=dawState.tracks.find(x=>x.kind==='midi'); return t.notes.length; }}""")
    print("persisted notes:", per)
    print("PAGE ERRORS:", errs)
    page.screenshot(path="/tmp/daw_pr.png", full_page=True)
    ctx.close(); b.close()
print("PR VERIFY DONE")
```

- [ ] **Step 5:** Run `cd /tmp && python3 daw_pr_verify.py`. Expected: panel visible True; keyboard keys 73; notes after add 1; note blocks 1; vel after slider 40; after edit start 2.0/pitch 67/dur 1.0; timeline lane blocks 1; preview peak > 0; notes after delete 0; persisted notes 1; `PAGE ERRORS: []`. Inspect `/tmp/daw_pr.png` (grid + keyboard + note + velocity slider).

- [ ] **Step 6: Regression** `python3 -m pytest tests/ -q` (95) and `for f in daw-project daw-engine daw-pianoroll daw-timeline daw; do node --check static/$f.js; done`. Commit:
```bash
git add templates/index.html
git commit -m "feat(daw): wire piano-roll panel + cache-busts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Bottom panel + open via dbl-click / header button + close → Tasks 3 (open/close) + 4 (hooks) + 5 (panel) ✓
- Grid: keyboard gutter (clickable preview), pitch rows C1–C7, snap grid lines, note blocks with velocity brightness, selected outline → Task 3 ✓
- Add / select / move / resize / delete / velocity, snap reuse + Ctrl bypass, last-used duration → Task 3 ✓
- Note mutations + `_dawAfterMutate` hook → Task 1 ✓
- `dawPreviewNote` through track chain reusing 2A helpers → Task 2 ✓
- Timeline lane re-renders on edit (via `_dawAfterMutate`) → Tasks 1/3; verified Task 5 ✓
- Persistence (no backend change) → verified Task 5; pytest stays 95 ✓
- Edge cases (audio track guarded, track deleted→close, pitch clamp, snap off, resize min step, hit-test note vs empty, delete-key focus guard, preview ensures ctx, scroll preserved across re-render) → Tasks 3/4; verified Task 5 ✓

**Placeholder scan:** none — full code + commands.

**Type/name consistency:** `dawAddNote/dawRemoveNote/dawNoteEdited` (Task 1) used by Task 3; `dawPreviewNote` (Task 2) used by Task 3; `openPianoRoll/dawClosePianoRoll/dawRenderPianoRoll/dawRenderPianoRollIfOpen`, `_dawPR*` state, `_DAW_PR_ROW_H/_LO/_HI`, `el._note` consistent within Task 3 and called from Tasks 1 (hook) + 4 (hooks). Element ids `daw-pianoroll-panel`/`daw-pr-body`/`daw-pr-grid` consistent across Tasks 3 + 5. Reuses `_dawSnapSec/_dawSnapDiv/_dawPxPerSec/dawArrangementLength/dawMarkDirty` and `dawEngineTrackPeak` (verify).
