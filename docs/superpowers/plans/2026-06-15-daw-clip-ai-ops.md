# DAW Phase 5b+5c — Clip AI Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two clip ⋯-menu AI actions — **🤖 AI Remix…** (Variation/Extend a clip via `/remix`, add the result as a new clip after the source) and **🎛 Split to Stems** (Demucs a clip into vocals/drums/bass/other tracks, mute the source) — both non-destructive.

**Architecture:** Pure frontend. `daw-ai.js` gains `openRemixDialog` + `dawRemixClip` (reusing the 5a `dawRunJob` poller against `/remix`) and `dawSplitToStems` (consuming the `/stems/demucs/stream` SSE, then adding stem tracks). `daw-waveedit.js` adds the two menu items to the existing `openClipMenu`. No backend changes.

**Tech Stack:** vanilla JS (fetch + EventSource), existing `/remix` and `/stems/demucs/stream` backends, Web Audio (existing), Playwright.

**Spec:** `docs/superpowers/specs/2026-06-15-daw-clip-ai-ops-design.md`

**Conventions:**
- Work from `/home/legion/legionprojects/nyx-step` on `master`. `node --check <file>` for JS. After JS/HTML change, bump `?v=N` in `templates/index.html`.
- Service: `sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health` (passwordless sudo; version 3.10.0). Tests: `python3 -m pytest tests/ -q` (no backend change; baseline 88 must stay green).
- Commit per task; end messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do not push (controller finishes).
- Existing globals reused: `dawState`, `_dawFindClip`, `dawAddClip`, `dawAddTrack`, `dawToggleMute`, `dawGetBuffer`, `dawMarkDirty`, `renderTimeline`, `_dawSetSaveStatus`, `_dawGenTracks`, `dawRunJob`, and the dialog helpers `_dawGenDialogEl`/`_dawCloseGenDialog`/`_dawGenOutside`/`_dawGenEsc` (all in `daw-ai.js` from 5a). `openClipMenu(clip, anchor)` in `daw-waveedit.js` has `anchor` in scope and `mkBtn(label, fn)` closes the menu after `fn`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `static/daw-ai.js` | modify | `openRemixDialog`, `dawRemixClip`, `dawSplitToStems` |
| `static/daw-waveedit.js` | modify | "🤖 AI Remix…" + "🎛 Split to Stems" menu items |
| `templates/index.html` | modify | cache-busts: `daw-ai.js` v1→v2, `daw-waveedit.js` v1→v2 |

---

### Task 1: `daw-ai.js` — remix + split-to-stems flows

**Files:** Modify `static/daw-ai.js`

- [ ] **Step 1: Append the three functions** to the end of `static/daw-ai.js`:

```javascript

// ── 5b: AI Remix (variation / extend) ─────────────────────────────────────────
async function dawRemixClip(clip, mode, tags, duration) {
  const found = (typeof _dawFindClip === "function") ? _dawFindClip(clip.id) : null;
  if (!found) return;
  const track = found.track;
  _dawGenTracks.add(track.id); renderTimeline();
  _dawSetSaveStatus("Remixing… queued");
  try {
    const resp = await fetch("/remix", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_file: clip.file, mode, tags, duration,
                             bpm: dawState.tempo ?? 120, song_name: "DAW remix" }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || ("HTTP " + resp.status));
    const file = await dawRunJob(data.prompt_id, s => _dawSetSaveStatus("Remixing… " + s));
    const at = clip.start + clip.duration;
    const nc = dawAddClip(track.id, { file, name: mode + ": " + (tags || clip.name).slice(0, 20), source_duration: duration }, at);
    const buf = await dawGetBuffer(file);
    if (buf && nc) { nc.source_duration = nc.duration = buf.duration; dawMarkDirty(); }
    renderTimeline();
    _dawSetSaveStatus("Remixed ✓");
  } catch (e) {
    _dawSetSaveStatus("Remix failed: " + e.message);
  } finally {
    _dawGenTracks.delete(track.id); renderTimeline();
  }
}

function openRemixDialog(clip, anchor) {
  _dawCloseGenDialog();
  const m = document.createElement("div");
  _dawGenDialogEl = m;
  m.style.cssText = "position:fixed;z-index:1000;background:#15171f;border:1px solid #2d3041;border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:6px;min-width:230px;box-shadow:0 4px 16px rgba(0,0,0,0.5)";
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 250) + "px";
  m.style.top = (r.bottom + 4) + "px";

  const title = document.createElement("div");
  title.textContent = "🤖 AI Remix";
  title.style.cssText = "font-size:11px;color:#00d4b6;font-weight:bold";

  const modeRow = document.createElement("label");
  modeRow.style.cssText = "font-size:11px;color:#e2e4ed;display:flex;align-items:center;gap:6px";
  modeRow.textContent = "Mode";
  const modeSel = document.createElement("select");
  modeSel.style.cssText = "font-size:11px";
  for (const v of ["variation", "extend"]) {
    const o = document.createElement("option"); o.value = v; o.textContent = v; modeSel.appendChild(o);
  }
  modeRow.appendChild(modeSel);

  const tagsIn = document.createElement("input");
  tagsIn.type = "text"; tagsIn.placeholder = "tags (optional)";
  tagsIn.style.cssText = "font-size:11px;width:100%";

  const durRow = document.createElement("label");
  durRow.style.cssText = "font-size:11px;color:#e2e4ed;display:flex;align-items:center;gap:6px";
  durRow.textContent = "Duration s";
  const durIn = document.createElement("input");
  durIn.type = "number"; durIn.min = "5"; durIn.max = "300"; durIn.step = "1";
  durIn.value = String(Math.max(5, Math.round(clip.duration || 15)));
  durIn.style.cssText = "width:60px;font-size:11px";
  durRow.appendChild(durIn);

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:6px;justify-content:flex-end";
  const go = document.createElement("button");
  go.className = "secondary small"; go.textContent = "Remix"; go.style.cssText = "font-size:11px";
  const cancel = document.createElement("button");
  cancel.className = "secondary small"; cancel.textContent = "Cancel"; cancel.style.cssText = "font-size:11px";
  go.addEventListener("click", () => {
    const dur = Math.min(300, Math.max(5, parseFloat(durIn.value) || 15));
    _dawCloseGenDialog();
    dawRemixClip(clip, modeSel.value, tagsIn.value.trim(), dur);
  });
  cancel.addEventListener("click", _dawCloseGenDialog);
  btnRow.appendChild(go); btnRow.appendChild(cancel);

  m.appendChild(title); m.appendChild(modeRow); m.appendChild(tagsIn); m.appendChild(durRow); m.appendChild(btnRow);
  document.body.appendChild(m);
  tagsIn.focus();
  setTimeout(() => {
    document.addEventListener("mousedown", _dawGenOutside);
    document.addEventListener("keydown", _dawGenEsc);
  }, 0);
}

// ── 5c: Split to Stems (demucs → tracks) ──────────────────────────────────────
async function dawSplitToStems(clip) {
  if (clip.file.startsWith("separated/")) { _dawSetSaveStatus("Already a stem"); return; }
  const found = (typeof _dawFindClip === "function") ? _dawFindClip(clip.id) : null;
  if (!found) return;
  const track = found.track;
  const base = clip.file.replace(/\.[^.]+$/, "");
  _dawGenTracks.add(track.id); renderTimeline();
  _dawSetSaveStatus("Splitting to stems…");

  let failed = false, settled = false;
  const es = new EventSource("/stems/demucs/stream?filename=" + encodeURIComponent(clip.file) + "&model=htdemucs");

  const finish = async (errored) => {
    if (settled) return;
    settled = true;
    es.close();
    try {
      if (errored || failed) { _dawSetSaveStatus("Stem split failed"); return; }
      for (const t of ["vocals", "drums", "bass", "other"]) {
        const f = "separated/htdemucs/" + base + "/" + t + ".wav";
        const buf = await dawGetBuffer(f);
        if (!buf) continue;
        dawAddTrack(clip.name.slice(0, 14) + " — " + t);
        const newId = dawState.tracks[dawState.tracks.length - 1].id;
        dawAddClip(newId, { file: f, name: t, source_duration: buf.duration }, clip.start);
      }
      if (!track.mute) dawToggleMute(track.id);   // mute the source track (re-renders + reschedules)
      _dawSetSaveStatus("Stems ready ✓");
    } catch (e) {
      _dawSetSaveStatus("Stem split failed: " + e.message);
    } finally {
      _dawGenTracks.delete(track.id); renderTimeline(); dawMarkDirty();
    }
  };

  es.addEventListener("log", e => {
    try {
      const l = JSON.parse(e.data).line;
      if (l.includes("[error]")) failed = true;
      _dawSetSaveStatus("Stems: " + l.slice(0, 40));
    } catch (_) {}
  });
  es.addEventListener("done", () => finish(false));
  es.onerror = () => finish(true);   // no-op if already settled (e.g. fires after normal close)
}
```

- [ ] **Step 2: Syntax check.** `node --check static/daw-ai.js` → no output.

- [ ] **Step 3: Commit.**
```bash
git add static/daw-ai.js
git commit -m "feat(daw): clip AI remix (variation/extend) + split-to-stems flows

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Menu items + wiring

**Files:** Modify `static/daw-waveedit.js`, `templates/index.html`

- [ ] **Step 1: Add the two menu items.** In `static/daw-waveedit.js`, find the last menu item in `openClipMenu`:
```javascript
  m.appendChild(mkBtn("Reset fades", () => { dawSetClipFadeIn(clip.id, 0); dawSetClipFadeOut(clip.id, 0); }));
```
and add immediately after it:
```javascript
  m.appendChild(mkBtn("🤖 AI Remix…", () => { if (typeof openRemixDialog === "function") openRemixDialog(clip, anchor); }));
  m.appendChild(mkBtn("🎛 Split to Stems", () => { if (typeof dawSplitToStems === "function") dawSplitToStems(clip); }));
```

- [ ] **Step 2: Bump cache-busts** in `templates/index.html`: `daw-ai.js?v=1` → `daw-ai.js?v=2`, and `daw-waveedit.js?v=1` → `daw-waveedit.js?v=2`.

- [ ] **Step 3: Verify + restart.**
```bash
node --check static/daw-waveedit.js
sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health
curl -s http://127.0.0.1:8001/ | grep -o 'daw-ai.js?v=2' | head -1          # daw-ai.js?v=2
curl -s http://127.0.0.1:8001/ | grep -o 'daw-waveedit.js?v=2' | head -1     # daw-waveedit.js?v=2
```
Expected: health 3.10.0; both bumped versions present.

- [ ] **Step 4: Commit.**
```bash
git add static/daw-waveedit.js templates/index.html
git commit -m "feat(daw): clip menu — AI Remix + Split to Stems items

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: End-to-end live verification

**Files:** Create `/tmp/daw_clipai_verify.py` (throwaway)

Real `/remix` (ComfyUI) and real demucs — both available on Nyx. Generous waits.

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

    # Fresh project + one library clip on track 0
    page.evaluate("async()=>{ await dawNewProject('ClipAICheck'); }"); page.wait_for_timeout(1000)
    page.evaluate("""()=>{ const t=dawState.tracks[0];
        dawAddClip(t.id, {file:_dawLibItems[0].file, name:_dawLibItems[0].name, source_duration:_dawLibItems[0].duration||12}, 0);}""")
    page.wait_for_timeout(500)
    tid = page.evaluate("dawState.tracks[0].id")
    clip = page.evaluate("dawState.tracks[0].clips[0]")
    print("source clip:", {"start": clip["start"], "dur": round(clip["duration"], 1), "file": clip["file"]})

    # Menu has the new items (open via openClipMenu)
    page.evaluate("()=>openClipMenu(dawState.tracks[0].clips[0], document.querySelector('#daw-tracks-head'))")
    page.wait_for_timeout(300)
    has = page.evaluate("""()=>{ const t=[...document.querySelectorAll('button')].map(b=>b.textContent);
        return {remix: t.some(x=>x.includes('AI Remix')), stems: t.some(x=>x.includes('Split to Stems'))}; }""")
    print("menu items:", has)
    page.keyboard.press("Escape"); page.wait_for_timeout(200)

    # ── 5b: AI Remix (variation) directly ──
    page.evaluate(f"dawRemixClip(dawState.tracks[0].clips[0], 'variation', 'mellow', 12)")
    print("remix status:", page.evaluate("document.getElementById('daw-save-status').textContent"))
    remixed = False
    for _ in range(60):  # ~120s
        page.wait_for_timeout(2000)
        n = page.evaluate(f"(dawState.tracks.find(t=>t.id==='{tid}')||{{clips:[]}}).clips.length")
        if n >= 2: remixed = True; break
    info = page.evaluate(f"""()=>{{ const t=dawState.tracks.find(t=>t.id==='{tid}'); const c=t&&t.clips[1];
        return c?{{start:+c.start.toFixed(1), dur:+c.duration.toFixed(1), file:c.file}}:null; }}""")
    print("5b remixed:", remixed, "| 2nd clip:", info, "| status:", page.evaluate("document.getElementById('daw-save-status').textContent"))

    # ── 5c: Split to Stems on the source clip ──
    tracks_before = page.evaluate("dawState.tracks.length")
    page.evaluate(f"dawSplitToStems(dawState.tracks.find(t=>t.id==='{tid}').clips[0])")
    print("stems status:", page.evaluate("document.getElementById('daw-save-status').textContent"))
    stemmed = False
    for _ in range(70):  # ~140s (demucs)
        page.wait_for_timeout(2000)
        n = page.evaluate("dawState.tracks.length")
        if n >= tracks_before + 4: stemmed = True; break
    names = page.evaluate("dawState.tracks.map(t=>t.name)")
    src_muted = page.evaluate(f"(dawState.tracks.find(t=>t.id==='{tid}')||{{}}).mute")
    print("5c stemmed:", stemmed, "| tracks:", names, "| source muted:", src_muted)
    print("final status:", page.evaluate("document.getElementById('daw-save-status').textContent"))
    print("PAGE ERRORS:", errs)
    page.screenshot(path="/tmp/daw_clipai_verify.png", full_page=True)
    ctx.close(); b.close()
print("CLIPAI VERIFY DONE")
```

- [ ] **Step 2: Run.** `cd /tmp && python3 daw_clipai_verify.py`
Expected: `menu items: {remix: True, stems: True}`; `5b remixed: True` with a 2nd clip at `start ≈ source.dur` and a real file; `5c stemmed: True` with 4 new tracks named `… — vocals/drums/bass/other` and `source muted: True`; final status "Stems ready ✓"; `PAGE ERRORS: []`.

- [ ] **Step 3: Inspect** `/tmp/daw_clipai_verify.png` — the arrangement shows the remix clip alongside the source and four stem tracks below, with the source track dimmed/muted.

- [ ] **Step 4: Regression.** `python3 -m pytest tests/ -q` (88 passed) and `node --check static/daw-ai.js static/daw-waveedit.js`.

No commit (driver is throwaway). If a fix was needed, commit with `fix(daw):` and re-run.

---

## Self-Review

**Spec coverage:**
- 5b `dawRemixClip`: `/remix` with source_file/mode/tags/duration, `dawRunJob`, add new clip at `source.start+source.duration`, duration corrected, ⏳ + status, non-destructive → Task 1 ✓
- 5b `openRemixDialog`: Mode (variation/extend) + Tags (optional) + Duration (default round(clip.duration)); reuses the shared dialog slot/close/Esc helpers → Task 1 ✓
- 5c `dawSplitToStems`: skip stems; demucs SSE; on done add 4 stem tracks at `clip.start` (skip 404 stems); mute source track; settled-guard against double-finish; ⏳ + status; non-destructive → Task 1 ✓
- Menu items "🤖 AI Remix…" + "🎛 Split to Stems" → Task 2 ✓
- Cache-busts → Task 2 ✓
- Edge cases (remix/demucs failure, already-a-stem, 404 stem skipped, clip/track removed → `_dawFindClip` null abort, source already muted, duration correction, concurrent ⏳, double-finish guard) → covered in Task 1; verified Task 3 ✓
- No backend change → suite stays 88 → Task 3 ✓

**Placeholder scan:** none — complete code and exact commands.

**Type/name consistency:** `dawRemixClip`, `openRemixDialog`, `dawSplitToStems` defined in Task 1, referenced by the menu items in Task 2. Reuses verbatim: `_dawFindClip`, `dawAddClip` (returns the clip), `dawAddTrack`, `dawToggleMute`, `dawGetBuffer`, `dawMarkDirty`, `renderTimeline`, `_dawSetSaveStatus`, `_dawGenTracks`, `dawRunJob`, `_dawGenDialogEl`/`_dawCloseGenDialog`/`_dawGenOutside`/`_dawGenEsc`, `dawState`. Stem path `separated/htdemucs/<base>/<type>.wav` matches `/daw/library` + `/daw/audio` conventions. `openClipMenu`'s `anchor` and `mkBtn` used as they exist.
