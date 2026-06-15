# DAW Phase 5a — Generate onto Track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-track 🎵 button that opens a Tags+Duration dialog, submits `/generate`, waits for the async job to finish, and drops the new clip onto that track at the playhead — with live "Generating…" status and no blocking.

**Architecture:** A new `GET /daw/job/{prompt_id}` status endpoint exposes the shared job tracker to the DAW. A new `static/daw-ai.js` provides `dawRunJob` (poll-to-completion) plus the generate dialog and place-on-track flow, reusing the existing `/generate` pipeline. This is Phase 5a — the `dawRunJob` + status endpoint are the foundation 5b (repaint) and 5c (demucs) will reuse.

**Tech Stack:** FastAPI (tracker-backed status route), vanilla JS (fetch polling, popup dialog), Web Audio (existing), pytest, Playwright.

**Spec:** `docs/superpowers/specs/2026-06-15-daw-ai-generate-onto-track-design.md`

**Conventions:**
- Work from `/home/legion/legionprojects/nyx-step` on `master`. Tests: `python3 -m pytest tests/ -q` (no venv; baseline 87).
- `node --check <file>` for JS. After JS/HTML change, bump that file's `?v=N` in `templates/index.html`.
- Service: `sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health` (passwordless sudo; version 3.10.0).
- Commit per task; end messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do not push (controller finishes).
- `routes/daw.py` currently imports `from nyx_step import get_user_email`. The shared `tracker`
  (a `JobTracker`) is importable as `from nyx_step import tracker` (pattern used by `routes/queue.py`).
- `JobInfo` (from `tracker.get`) has `.status` (`queued|running|done|error`), `.output_files` (list), `.error_msg`.
- `daw-project.js` already defines a global `_dawSetSaveStatus(text)` writing to `#daw-save-status` — reuse it (don't add another).
- Frontend globals available: `dawState`, `dawAddClip`, `dawGetPlayhead`, `dawGetBuffer`, `dawMarkDirty`, `renderTimeline`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `routes/daw.py` | modify | `GET /daw/job/{prompt_id}` — tracker-backed, user-scoped job status |
| `static/daw-ai.js` | **create** | `_dawGenTracks`, `dawRunJob`, `openGenerateDialog`, `dawGenerateOntoTrack` |
| `static/daw-timeline.js` | modify | per-track 🎵 / ⏳ button in track headers |
| `templates/index.html` | modify | `daw-ai.js` script tag + cache-busts (timeline) |
| `tests/test_daw.py` | modify | `/daw/job` status endpoint test |

`daw-ai.js` loads after `daw-engine.js`/`daw-project.js` and before `daw.js`.

---

### Task 1: Backend — `GET /daw/job/{prompt_id}` status endpoint

**Files:** Modify `routes/daw.py`, `tests/test_daw.py`

- [ ] **Step 1: Write the failing test.** Append to `tests/test_daw.py` (uses the existing `client` for dev@local and `import nyx_step`):

```python
def test_daw_job_status_endpoint():
    nyx_step.tracker.register("dawjob1", "dev@local", "gen")
    nyx_step.tracker.update("dawjob1", status="done", output_files=["g.mp3"])
    r = client.get("/daw/job/dawjob1")
    assert r.status_code == 200
    d = r.json()
    assert d["status"] == "done"
    assert d["files"] == ["g.mp3"]

    # unknown prompt_id → 404
    assert client.get("/daw/job/nope-xyz").status_code == 404

    # job owned by another user → 404 (not readable as dev@local)
    nyx_step.tracker.register("dawjob2", "other@x.com", "gen")
    assert client.get("/daw/job/dawjob2").status_code == 404
```

- [ ] **Step 2: Run to verify failure.** `python3 -m pytest tests/test_daw.py -q -k job_status` → FAIL (404 on dawjob1; route missing).

- [ ] **Step 3: Implement the route.** In `routes/daw.py`, change the import line
  `from nyx_step import get_user_email` to:
```python
from nyx_step import get_user_email, tracker
```
  and add the route (e.g. after the existing `/audio` route):
```python
@router.get("/job/{prompt_id}")
async def job_status(prompt_id: str, request: Request):
    user = get_user_email(request)
    if not tracker.user_owns(user, prompt_id):
        return JSONResponse({"error": "Not found"}, status_code=404)
    job = tracker.get(prompt_id)
    if not job:
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"status": job.status, "files": job.output_files, "error": job.error_msg}
```

- [ ] **Step 4: Run tests.** `python3 -m pytest tests/test_daw.py -q` then full `python3 -m pytest tests/ -q` → all pass (88 total).

- [ ] **Step 5: Commit.**
```bash
git add routes/daw.py tests/test_daw.py
git commit -m "feat(daw): GET /daw/job/{prompt_id} single-job status endpoint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Frontend — `daw-ai.js` (poller + dialog + generate flow)

**Files:** Create `static/daw-ai.js`

- [ ] **Step 1: Create the module** with exactly this content:

```javascript
// ── DAW AI: generate onto track ───────────────────────────────────────────────
const _dawGenTracks = new Set();   // track ids with a generation in flight
let _dawGenDialogEl = null;

// Poll a single job to completion; resolves with the first output filename.
async function dawRunJob(promptId, onProgress) {
  const MAX_POLLS = 90;            // ~3 min at 2s
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, 2000));
    let d;
    try { d = await fetch("/daw/job/" + encodeURIComponent(promptId)).then(r => r.json()); }
    catch (_) { continue; }        // transient blip — keep polling
    if (onProgress) onProgress(d.status || "…");
    if (d.status === "done") {
      if (d.files && d.files.length) return d.files[0];
      throw new Error("job finished but produced no file");
    }
    if (d.status === "error") throw new Error(d.error || "generation error");
    if (d.error && !d.status) throw new Error(d.error);   // 404 / not found
  }
  throw new Error("timed out");
}

async function dawGenerateOntoTrack(trackId, tags, duration) {
  const at = dawGetPlayhead();     // capture playhead at submit time
  _dawGenTracks.add(trackId);
  renderTimeline();
  _dawSetSaveStatus("Generating… queued");
  try {
    const resp = await fetch("/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags, duration, bpm: dawState.tempo ?? 120,
                             song_name: "DAW: " + tags.slice(0, 40) }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || ("HTTP " + resp.status));
    const file = await dawRunJob(data.prompt_id, s => _dawSetSaveStatus("Generating… " + s));
    const clip = dawAddClip(trackId, { file, name: "gen: " + tags.slice(0, 24), source_duration: duration }, at);
    const buf = await dawGetBuffer(file);
    if (buf && clip) { clip.source_duration = clip.duration = buf.duration; dawMarkDirty(); }
    renderTimeline();
    _dawSetSaveStatus("Generated ✓");
  } catch (e) {
    _dawSetSaveStatus("Generation failed: " + e.message);
  } finally {
    _dawGenTracks.delete(trackId);
    renderTimeline();
  }
}

function _dawCloseGenDialog() {
  if (!_dawGenDialogEl) return;
  _dawGenDialogEl.remove(); _dawGenDialogEl = null;
  document.removeEventListener("mousedown", _dawGenOutside);
  document.removeEventListener("keydown", _dawGenEsc);
}
function _dawGenOutside(e) { if (_dawGenDialogEl && !_dawGenDialogEl.contains(e.target)) _dawCloseGenDialog(); }
function _dawGenEsc(e) { if (e.key === "Escape") _dawCloseGenDialog(); }

function openGenerateDialog(trackId, anchor) {
  _dawCloseGenDialog();
  const m = document.createElement("div");
  _dawGenDialogEl = m;
  m.style.cssText = "position:fixed;z-index:1000;background:#15171f;border:1px solid #2d3041;border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:6px;min-width:230px;box-shadow:0 4px 16px rgba(0,0,0,0.5)";
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 250) + "px";
  m.style.top = (r.bottom + 4) + "px";

  const title = document.createElement("div");
  title.textContent = "🎵 Generate onto track";
  title.style.cssText = "font-size:11px;color:#00d4b6;font-weight:bold";

  const tagsIn = document.createElement("input");
  tagsIn.type = "text"; tagsIn.placeholder = "tags, e.g. warm analog lead";
  tagsIn.style.cssText = "font-size:11px;width:100%";

  const durRow = document.createElement("label");
  durRow.style.cssText = "font-size:11px;color:#e2e4ed;display:flex;align-items:center;gap:6px";
  durRow.textContent = "Duration s";
  const durIn = document.createElement("input");
  durIn.type = "number"; durIn.min = "5"; durIn.max = "300"; durIn.step = "1"; durIn.value = "15";
  durIn.style.cssText = "width:60px;font-size:11px";
  durRow.appendChild(durIn);

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:6px;justify-content:flex-end";
  const gen = document.createElement("button");
  gen.className = "secondary small"; gen.textContent = "Generate"; gen.disabled = true;
  gen.style.cssText = "font-size:11px";
  const cancel = document.createElement("button");
  cancel.className = "secondary small"; cancel.textContent = "Cancel"; cancel.style.cssText = "font-size:11px";
  tagsIn.addEventListener("input", () => { gen.disabled = !tagsIn.value.trim(); });
  gen.addEventListener("click", () => {
    const tags = tagsIn.value.trim();
    if (!tags) return;
    const dur = Math.min(300, Math.max(5, parseFloat(durIn.value) || 15));
    _dawCloseGenDialog();
    dawGenerateOntoTrack(trackId, tags, dur);
  });
  cancel.addEventListener("click", _dawCloseGenDialog);
  btnRow.appendChild(gen); btnRow.appendChild(cancel);

  m.appendChild(title); m.appendChild(tagsIn); m.appendChild(durRow); m.appendChild(btnRow);
  document.body.appendChild(m);
  tagsIn.focus();
  setTimeout(() => {
    document.addEventListener("mousedown", _dawGenOutside);
    document.addEventListener("keydown", _dawGenEsc);
  }, 0);
}
```

- [ ] **Step 2: Syntax check.** `node --check static/daw-ai.js` → no output.

- [ ] **Step 3: Commit.**
```bash
git add static/daw-ai.js
git commit -m "feat(daw): AI generate-onto-track — job poller, dialog, place flow

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Track-header 🎵 button + wiring

**Files:** Modify `static/daw-timeline.js`, `templates/index.html`

- [ ] **Step 1: Add the 🎵 / ⏳ button to track headers.** In `static/daw-timeline.js`, in `dawRenderTrackHeaders`, find the three button appends:
```javascript
    btns.appendChild(mk("M", t.mute, () => { dawToggleMute(t.id); dawReschedule(); }, "Mute"));
    btns.appendChild(mk("S", t.solo, () => { dawToggleSolo(t.id); dawReschedule(); }, "Solo"));
    btns.appendChild(mk("✕", false, () => { if (confirm("Remove track?")) dawRemoveTrack(t.id); }, "Remove"));
```
and add immediately after the ✕ append:
```javascript
    const genActive = (typeof _dawGenTracks !== "undefined") && _dawGenTracks.has(t.id);
    const genBtn = document.createElement("button");
    genBtn.className = "secondary small";
    genBtn.textContent = genActive ? "⏳" : "🎵";
    genBtn.title = "Generate onto this track";
    genBtn.disabled = genActive;
    genBtn.style.cssText = "font-size:10px;padding:1px 6px;";
    if (!genActive) genBtn.addEventListener("click", () => { if (typeof openGenerateDialog === "function") openGenerateDialog(t.id, genBtn); });
    btns.appendChild(genBtn);
```

- [ ] **Step 2: Add the script tag.** In `templates/index.html`, add `<script src="/static/daw-ai.js?v=1"></script>` immediately after the `daw-export.js` script tag and before `daw.js`.

- [ ] **Step 3: Bump cache-bust.** In `templates/index.html`, change `daw-timeline.js?v=5` → `daw-timeline.js?v=6`.

- [ ] **Step 4: Verify + restart.**
```bash
node --check static/daw-timeline.js
sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8001/static/daw-ai.js?v=1"   # 200
curl -s http://127.0.0.1:8001/ | grep -o 'daw-ai.js?v=1' | head -1                       # daw-ai.js?v=1
curl -s http://127.0.0.1:8001/ | grep -o 'daw-timeline.js?v=6' | head -1                 # daw-timeline.js?v=6
```

- [ ] **Step 5: Commit.**
```bash
git add static/daw-timeline.js templates/index.html
git commit -m "feat(daw): per-track 🎵 generate button, load daw-ai.js

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: End-to-end live verification

**Files:** Create `/tmp/daw_aigen_verify.py` (throwaway)

This does a **real** ComfyUI generation (ComfyUI is up on Nyx). Use a short duration for speed.

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

    # Fresh project with one empty track
    page.evaluate("async()=>{ await dawNewProject('AIGenCheck'); }"); page.wait_for_timeout(1000)
    tid = page.evaluate("dawState.tracks[0].id")
    clips_before = page.evaluate("dawState.tracks[0].clips.length")
    print("track clips before:", clips_before)

    # Open the generate dialog via the public function, then drive its inputs
    page.evaluate(f"""() => {{
        const hdr = document.querySelector('#daw-tracks-head');
        openGenerateDialog('{tid}', hdr);
    }}""")
    page.wait_for_timeout(400)
    # empty tags → Generate disabled
    gen_disabled = page.evaluate("""() => {
        const b = [...document.querySelectorAll('button')].find(x => x.textContent === 'Generate');
        return b ? b.disabled : null;
    }""")
    print("Generate disabled when tags empty:", gen_disabled)
    # fill tags + duration, click Generate
    page.evaluate("""() => {
        const dlg = document.querySelector('div[style*="position:fixed"]');
        const tags = dlg.querySelector('input[type=text]'); tags.value = "lo-fi piano, mellow";
        tags.dispatchEvent(new Event('input', {bubbles:true}));
        const dur = dlg.querySelector('input[type=number]'); dur.value = "12";
        const gen = [...dlg.querySelectorAll('button')].find(x => x.textContent === 'Generate');
        gen.click();
    }""")
    print("submitted; status:", page.evaluate("document.getElementById('daw-save-status').textContent"))

    # Poll up to ~90s for the clip to land on the track
    placed = False
    for i in range(45):
        page.wait_for_timeout(2000)
        n = page.evaluate(f"(dawState.tracks.find(t=>t.id==='{tid}')||{{clips:[]}}).clips.length")
        if n > clips_before:
            placed = True
            break
    info = page.evaluate(f"""() => {{
        const t = dawState.tracks.find(t=>t.id==='{tid}');
        const c = t && t.clips[t.clips.length-1];
        return c ? {{dur: +c.duration.toFixed(1), file: c.file, start: c.start}} : null;
    }}""")
    print("placed:", placed, "| clip:", info, "| status:", page.evaluate("document.getElementById('daw-save-status').textContent"))
    print("PAGE ERRORS:", errs)
    page.screenshot(path="/tmp/daw_aigen_verify.png", full_page=True)
    ctx.close(); b.close()
print("AIGEN VERIFY DONE")
```

- [ ] **Step 2: Run.** `cd /tmp && python3 daw_aigen_verify.py`
Expected: `Generate disabled when tags empty: True`; status goes "Generating… queued/running"; within ~90s `placed: True` with a clip whose `dur` ≈ 12 (corrected from the decoded buffer), a real `file`, and `start` = the playhead at submit (0); final status "Generated ✓"; `PAGE ERRORS: []`.

- [ ] **Step 3: Inspect** `/tmp/daw_aigen_verify.png` — the track header shows the 🎵 button (or ⏳ if still rendering) and a generated clip sits on the lane.

- [ ] **Step 4: Regression.** `python3 -m pytest tests/ -q` (88 passed) and `node --check static/daw-ai.js static/daw-timeline.js`.

No commit (driver is throwaway). If a fix was needed, commit with `fix(daw):` and re-run.

---

## Self-Review

**Spec coverage:**
- `GET /daw/job/{prompt_id}` tracker-backed, user-scoped, returns status/files/error → Task 1 ✓
- `dawRunJob` poll-to-completion (2s, ~3min cap, transient-blip tolerance, error/timeout handling) → Task 2 ✓
- `dawGenerateOntoTrack`: capture playhead at submit, POST /generate with tags/duration/bpm/song_name, await, place clip, correct source_duration from decoded buffer, status + ⏳ via `_dawGenTracks` → Task 2 ✓
- Minimal Tags+Duration dialog; Generate disabled on empty tags; close on cancel/outside/Esc → Task 2 ✓
- Per-track 🎵 / ⏳ button → Task 3 ✓
- Script load order + cache-busts → Task 3 ✓
- Status endpoint test (owned/unknown/other-user) → Task 1; live generate→place e2e → Task 4 ✓
- Edge cases (empty tags, /generate error, job error, timeout, unowned 404, concurrent tracks, re-render-preserves-⏳ via Set, track removed mid-gen → dawAddClip no-ops, duration correction, playhead captured at submit) → covered across Tasks 1–2; verified Task 4 ✓

**Placeholder scan:** none — complete code and exact commands throughout.

**Type/name consistency:** `dawRunJob`, `dawGenerateOntoTrack`, `openGenerateDialog`, `_dawGenTracks` defined in Task 2 and referenced in Task 3 (button → `openGenerateDialog`; header → `_dawGenTracks`). Reuses existing globals verbatim: `_dawSetSaveStatus` (daw-project.js), `dawState`, `dawAddClip`, `dawGetPlayhead`, `dawGetBuffer`, `dawMarkDirty`, `renderTimeline`, and backend `tracker.user_owns`/`tracker.get`/`.status`/`.output_files`/`.error_msg`. Endpoint path `/daw/job/{prompt_id}` matches the poller URL `"/daw/job/" + promptId` in Tasks 1–2.
