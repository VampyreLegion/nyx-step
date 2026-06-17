# Single-Instrument Generate-onto-Track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DAW "Generate onto track" produce only the requested instrument/voice via isolation tags + negative conditioning, with an optional Demucs single-stem guarantee.

**Architecture:** Frontend-only. A per-type isolation map augments the positive tags and sets `negative_tags` on the `/generate` POST (the model already wires negative conditioning). An optional checkbox runs the existing `/stems/demucs/stream` on the result and keeps only the matching stem.

**Tech Stack:** vanilla JS, existing `/generate` + `/stems/demucs/stream` endpoints, Playwright.

**Spec:** `docs/superpowers/specs/2026-06-17-daw-single-instrument-generate-design.md`

**Conventions:** repo `/home/legion/legionprojects/nyx-step`, branch `master`. `node --check static/daw-ai.js`. Restart `sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health`. Bump `daw-ai.js?v=` in `templates/index.html`. Commit per task (`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`). Don't push (controller finishes).

---

### Task 1: Conditioning map + augmented generate function

**Files:** Modify `static/daw-ai.js`

- [ ] **Step 1: Add the isolation map** immediately above `async function dawGenerateOntoTrack`:
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
const _DAW_VOCAL_RE = /\b(vocal|vocals|voice|sing|singer|sung|choir|vox|rap|rapping|a ?cappella|soprano|alto|tenor|falsetto)\b/;
```

- [ ] **Step 2: Replace `dawGenerateOntoTrack`** (lines 24–49) with a version taking `type`/`isolate`, augmenting tags + negative_tags, and isolating when requested:
```javascript
async function dawGenerateOntoTrack(trackId, tags, duration, type, isolate) {
  const iso = _DAW_GEN_ISOLATION[type] || _DAW_GEN_ISOLATION.instrument;
  const at = dawGetPlayhead();     // capture playhead at submit time
  _dawGenTracks.add(trackId);
  renderTimeline();
  _dawSetSaveStatus("Generating… queued");
  try {
    const fullTags = tags + ", " + iso.add;
    const resp = await fetch("/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: fullTags, negative_tags: iso.neg, duration,
                             bpm: dawState.tempo ?? 120, song_name: "DAW: " + tags.slice(0, 40) }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || ("HTTP " + resp.status));
    let file = await dawRunJob(data.prompt_id, s => _dawSetSaveStatus("Generating… " + s));
    if (isolate) {
      _dawSetSaveStatus("Isolating…");
      const stem = await _dawIsolateStem(file, iso.stem);
      if (stem) file = stem;
    }
    const clip = dawAddClip(trackId, { file, name: "gen: " + tags.slice(0, 24), source_duration: duration }, at);
    const buf = await dawGetBuffer(file);
    if (buf && clip) { clip.source_duration = clip.duration = clip.src_len = buf.duration; dawMarkDirty(); }
    renderTimeline();
    _dawSetSaveStatus("Generated ✓");
  } catch (e) {
    _dawSetSaveStatus("Generation failed: " + e.message);
  } finally {
    _dawGenTracks.delete(trackId);
    renderTimeline();
  }
}

// Run Demucs on a generated file and return the path to one stem, or null on failure.
function _dawIsolateStem(file, stem) {
  return new Promise(resolve => {
    let settled = false;
    const done = async (ok) => {
      if (settled) return; settled = true; es.close();
      if (!ok) return resolve(null);
      const base = file.replace(/\.[^.]+$/, "");
      const f = "separated/htdemucs/" + base + "/" + stem + ".mp3";
      const buf = await dawGetBuffer(f);
      resolve(buf ? f : null);
    };
    const es = new EventSource("/stems/demucs/stream?filename=" + encodeURIComponent(file) + "&model=htdemucs");
    let errored = false;
    es.addEventListener("log", e => {
      try { const l = JSON.parse(e.data).line; if (l.includes("[error]")) errored = true;
            _dawSetSaveStatus("Isolating: " + l.slice(0, 36)); } catch (_) {}
    });
    es.addEventListener("done", () => done(!errored));
    es.onerror = () => done(false);
  });
}
```
(Note: also sets `clip.src_len` so the new stretch-aware model stays consistent.)

- [ ] **Step 3:** `node --check static/daw-ai.js`. Commit:
```bash
git add static/daw-ai.js
git commit -m "feat(daw): isolation tags + negative conditioning + optional stem isolate for track generate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Dialog — Type select, isolate checkbox, vocal auto-detect

**Files:** Modify `static/daw-ai.js` (`openGenerateDialog`)

- [ ] **Step 1: Add the Type row + isolate checkbox** — insert after the `durRow.appendChild(durIn);` line (after the duration row is built, before `btnRow`):
```javascript
  const typeRow = document.createElement("label");
  typeRow.style.cssText = "font-size:11px;color:#e2e4ed;display:flex;align-items:center;gap:6px";
  typeRow.textContent = "Type";
  const typeSel = document.createElement("select");
  typeSel.style.cssText = "font-size:11px;width:auto;flex:0 0 auto";
  for (const [v, label] of [["instrument","Instrument"],["vocals","Vocals"],["drums","Drums"],["bass","Bass"]]) {
    const o = document.createElement("option"); o.value = v; o.textContent = label; typeSel.appendChild(o);
  }
  let _userPickedType = false;
  typeSel.addEventListener("change", () => { _userPickedType = true; });
  typeRow.appendChild(typeSel);

  const isoRow = document.createElement("label");
  isoRow.style.cssText = "font-size:11px;color:#e2e4ed;display:flex;align-items:center;gap:6px";
  const isoCb = document.createElement("input"); isoCb.type = "checkbox";
  isoRow.appendChild(isoCb);
  isoRow.appendChild(document.createTextNode("🔪 Isolate (stem-split after)"));
```

- [ ] **Step 2: Wire vocal auto-detect** — replace the existing `tagsIn` input listener:
```javascript
  tagsIn.addEventListener("input", () => {
    gen.disabled = !tagsIn.value.trim();
    if (!_userPickedType && _DAW_VOCAL_RE.test(tagsIn.value.toLowerCase())) typeSel.value = "vocals";
  });
```

- [ ] **Step 3: Pass type + isolate to generate** — replace the `gen.addEventListener("click", …)` body's call:
```javascript
  gen.addEventListener("click", () => {
    const tags = tagsIn.value.trim();
    if (!tags) return;
    const dur = Math.min(300, Math.max(5, parseFloat(durIn.value) || 15));
    const type = typeSel.value;
    const isolate = isoCb.checked;
    _dawCloseGenDialog();
    dawGenerateOntoTrack(trackId, tags, dur, type, isolate);
  });
```

- [ ] **Step 4: Append the new rows** — change the final assembly line to include `typeRow` and `isoRow`:
```javascript
  m.appendChild(title); m.appendChild(tagsIn); m.appendChild(typeRow); m.appendChild(durRow); m.appendChild(isoRow); m.appendChild(btnRow);
```

- [ ] **Step 5:** `node --check static/daw-ai.js`. Commit:
```bash
git add static/daw-ai.js
git commit -m "feat(daw): generate dialog — Type select, isolate checkbox, vocal auto-detect

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Cache-bust + live verification

**Files:** Modify `templates/index.html`; create `/tmp/daw_geniso_verify.py` (throwaway)

- [ ] **Step 1: Bump cache-bust** — in `templates/index.html` change `daw-ai.js?v=3` → `daw-ai.js?v=4`. Restart:
```bash
cd /home/legion/legionprojects/nyx-step
node --check static/daw-ai.js
sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health
```

- [ ] **Step 2: Write the driver** (`/tmp/daw_geniso_verify.py`) — stubs `/generate` to capture the body, no real generation:
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
    page.evaluate("async()=>{ await dawNewProject('GenIso'); }"); page.wait_for_timeout(800)
    # Stub fetch for /generate to capture body and stop the flow
    page.evaluate("""()=>{ window.__gen=null; const of=window.fetch;
      window.fetch=(u,o)=>{ if(typeof u==='string'&&u.startsWith('/generate')){ window.__gen=JSON.parse(o.body);
        return Promise.resolve(new Response(JSON.stringify({error:'stub-stop'}),{status:200,headers:{'Content-Type':'application/json'}})); }
        return of(u,o); }; }""")
    tid=page.evaluate("dawState.tracks[0].id")
    # Instrument
    page.evaluate(f"()=>openGenerateDialog('{tid}', document.querySelector('[data-tab=\\\"daw\\\"]'))")
    page.fill(".__none", "", timeout=10) if False else None
    page.evaluate("()=>{ const i=_dawGenDialogEl.querySelector('input[type=text]'); i.value='analog warm lead'; i.dispatchEvent(new Event('input')); }")
    auto1=page.evaluate("()=>_dawGenDialogEl.querySelector('select').value")
    page.evaluate("()=>{ [..._dawGenDialogEl.querySelectorAll('button')].find(b=>b.textContent==='Generate').click(); }")
    page.wait_for_timeout(400)
    g1=page.evaluate("window.__gen")
    print("instrument type auto:", auto1, "| tags:", g1['tags'], "| neg:", g1['negative_tags'])
    print("  ISOLATION OK:", g1['tags'].endswith('no accompaniment, dry') and 'drums' in g1['negative_tags'] and 'vocals' in g1['negative_tags'])
    # Vocals auto-detect
    page.evaluate(f"()=>openGenerateDialog('{tid}', document.querySelector('[data-tab=\\\"daw\\\"]'))")
    page.evaluate("()=>{ const i=_dawGenDialogEl.querySelector('input[type=text]'); i.value='female vocals'; i.dispatchEvent(new Event('input')); }")
    auto2=page.evaluate("()=>_dawGenDialogEl.querySelector('select').value")
    page.evaluate("()=>{ [..._dawGenDialogEl.querySelectorAll('button')].find(b=>b.textContent==='Generate').click(); }")
    page.wait_for_timeout(400)
    g2=page.evaluate("window.__gen")
    print("vocals auto-detect type:", auto2, "| neg:", g2['negative_tags'])
    print("  VOCAL OK:", auto2=='vocals' and 'instruments' in g2['negative_tags'] and 'a cappella' in g2['tags'])
    # Manual override: pick drums then type a vocal word
    page.evaluate(f"()=>openGenerateDialog('{tid}', document.querySelector('[data-tab=\\\"daw\\\"]'))")
    page.evaluate("()=>{ const s=_dawGenDialogEl.querySelector('select'); s.value='drums'; s.dispatchEvent(new Event('change')); const i=_dawGenDialogEl.querySelector('input[type=text]'); i.value='vocal chops'; i.dispatchEvent(new Event('input')); }")
    auto3=page.evaluate("()=>_dawGenDialogEl.querySelector('select').value")
    print("manual override stays drums:", auto3, "| OK:", auto3=='drums')
    print("PAGE ERRORS:", errs)
    ctx.close(); b.close()
print("GENISO VERIFY DONE")
```

- [ ] **Step 3:** Run `cd /tmp && python3 daw_geniso_verify.py`. Expected: instrument tags end with the isolation cues and negative_tags include drums+vocals (ISOLATION OK True); "female vocals" auto-flips Type to vocals with the vocal negative/positive sets (VOCAL OK True); manual Drums pick survives a vocal-word type (override OK True); `PAGE ERRORS: []`.

- [ ] **Step 4: Commit + (optional) one real generate.** Commit the cache-bust:
```bash
git add templates/index.html
git commit -m "chore(daw): cache-bust daw-ai.js for generate isolation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Then `python3 -m pytest tests/ -q` (90 passed, unchanged). Optionally do one real Instrument generate in the UI to confirm a clip lands and plays.

---

## Self-Review

**Spec coverage:**
- Type select (Instrument/Vocals/Drums/Bass) + isolate checkbox + vocal auto-detect with manual-override guard → Task 2 ✓
- Per-type positive `add` + `negative_tags` posted to /generate → Task 1 ✓
- `dawGenerateOntoTrack(trackId, tags, duration, type, isolate)` signature → Tasks 1 (def) + 2 (caller) ✓
- Isolate path: Demucs stream → keep matching stem → fall back to full file → Task 1 (`_dawIsolateStem`) ✓
- No backend change → confirmed (uses existing `/generate` `negative_tags`, `/stems/demucs/stream`) ✓
- Cache-bust + live verification → Task 3 ✓
- Edge cases (manual override, missing stem fallback, empty tags disabled) → Tasks 1–2; verified Task 3 ✓

**Placeholder scan:** none — full code + commands. The verifier stubs `/generate` so no slow generation is needed for the decisive checks.

**Type/name consistency:** `_DAW_GEN_ISOLATION` (keys instrument/vocals/drums/bass; fields add/neg/stem), `_DAW_VOCAL_RE`, `_dawIsolateStem(file, stem)`, `dawGenerateOntoTrack(trackId, tags, duration, type, isolate)`, dialog `typeSel`/`isoCb`/`_userPickedType` consistent across Tasks 1–3. Reuses existing `dawRunJob`, `dawAddClip`, `dawGetBuffer`, `dawGetPlayhead`, `_dawGenTracks`, `_dawSetSaveStatus`, `_dawGenDialogEl`, and the `/stems/demucs/stream` pattern from `dawSplitToStems`.
