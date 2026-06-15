# DAW Phase 4 — Export (Bounce to WAV) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click **⬇ Export WAV** to the DAW that renders the whole arrangement (clip trims, per-clip gain/fades, track volume/pan, mute/solo, master) to a 16-bit PCM WAV and downloads it.

**Architecture:** Pure client. A new `static/daw-export.js` rebuilds the exact playback graph on an `OfflineAudioContext` at the live context's sample rate (reusing `_dawScheduleClipEnvelope`), renders to an AudioBuffer, encodes it to a WAV Blob in-browser, and triggers a download. No backend.

**Tech Stack:** vanilla JS, Web Audio `OfflineAudioContext`, DataView WAV encoding, Playwright.

**Spec:** `docs/superpowers/specs/2026-06-15-daw-export-design.md`

**Conventions:**
- Work from `/home/legion/legionprojects/nyx-step` on `master`. JS validity: `node --check <file>`.
- After JS/HTML change, bump that file's `?v=N` in `templates/index.html`.
- Service: `sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health` (passwordless sudo; version 3.10.0).
- Commit per task; end messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do not push (controller finishes).
- Existing globals: `dawState`, `dawArrangementLength`, `_dawEnsureCtx`, `_dawCtx`, `_dawBufferCache`, `dawGetBuffer`, `_dawScheduleClipEnvelope`. No pytest (no backend change); baseline 87 tests must stay green.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `static/daw-export.js` | **create** | `dawRenderArrangement` (offline render), `_dawAudioBufferToWav` (encode), `dawExportWav` (glue) |
| `static/daw.js` | modify | wire `#daw-export` button → `dawExportWav` |
| `templates/index.html` | modify | Export button in transport + `daw-export.js` script tag + cache-bust |

`daw-export.js` loads after `daw-engine.js`/`daw-project.js` and before `daw.js`.

---

### Task 1: Export module (render + encode + glue)

**Files:** Create `static/daw-export.js`

- [ ] **Step 1: Create the module** with exactly this content:

```javascript
// ── DAW export (bounce arrangement to WAV) ────────────────────────────────────

// Render the whole arrangement offline through the same graph as playback.
// Returns an AudioBuffer, or null if there's nothing to export.
async function dawRenderArrangement() {
  const len = dawArrangementLength();
  if (len <= 0) return null;
  _dawEnsureCtx();
  const sr = _dawCtx.sampleRate;                 // match decoded buffers' rate exactly

  // Preload every referenced clip buffer.
  const files = new Set();
  for (const t of dawState.tracks) for (const c of t.clips) files.add(c.file);
  await Promise.all([...files].map(dawGetBuffer));

  const off = new OfflineAudioContext(2, Math.ceil(len * sr), sr);
  const master = off.createGain();
  master.gain.value = dawState.master_volume ?? 1;
  master.connect(off.destination);

  const anySolo = dawState.tracks.some(t => t.solo);
  for (const track of dawState.tracks) {
    const audible = anySolo ? track.solo : !track.mute;
    const tg = off.createGain();
    tg.gain.value = audible ? (track.volume ?? 1) : 0;
    const pan = off.createStereoPanner();
    pan.pan.value = track.pan ?? 0;
    tg.connect(pan); pan.connect(master);
    for (const clip of track.clips) {
      const buf = _dawBufferCache.get(clip.file);
      if (!buf || buf === "error") continue;
      const src = off.createBufferSource();
      src.buffer = buf;
      const cg = off.createGain();
      src.connect(cg); cg.connect(tg);
      _dawScheduleClipEnvelope(cg, clip.start, 0, clip.duration,
                               clip.gain ?? 1, clip.fade_in ?? 0, clip.fade_out ?? 0);
      src.start(clip.start, clip.offset, clip.duration);
    }
  }
  return await off.startRendering();
}

// Encode an AudioBuffer to a 16-bit PCM WAV Blob.
function _dawAudioBufferToWav(buf) {
  const numCh = buf.numberOfChannels;
  const sr = buf.sampleRate;
  const numFrames = buf.length;
  const blockAlign = numCh * 2;                  // 2 bytes/sample (16-bit)
  const dataSize = numFrames * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);                  // fmt chunk size
  view.setUint16(20, 1, true);                   // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true);     // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);                  // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(buf.getChannelData(c));
  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = Math.max(-1, Math.min(1, chans[c][i]));
      s = s < 0 ? s * 0x8000 : s * 0x7FFF;
      view.setInt16(off, s, true); off += 2;
    }
  }
  return new Blob([view], { type: "audio/wav" });
}

// Glue: render → encode → download, with status on #daw-save-status.
async function dawExportWav() {
  const btn = document.getElementById("daw-export");
  const status = document.getElementById("daw-save-status");
  if (btn) { btn.disabled = true; btn.textContent = "Rendering…"; }
  try {
    const rendered = await dawRenderArrangement();
    if (!rendered) {
      if (status) status.textContent = "Nothing to export — add clips first";
      return;
    }
    const blob = _dawAudioBufferToWav(rendered);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (dawState.name || "mix").replace(/[^\w.\- ]/g, "_") + ".wav";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    if (status) status.textContent = "Exported ✓";
  } catch (e) {
    if (status) status.textContent = "Export failed: " + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "⬇ Export WAV"; }
  }
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check static/daw-export.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add static/daw-export.js
git commit -m "feat(daw): export module — offline render + WAV encode + download

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Wire the Export button (markup + glue)

**Files:** Modify `templates/index.html`, `static/daw.js`

- [ ] **Step 1: Add the Export button to the transport.** In `templates/index.html`, find:
```html
        <button class="secondary small" id="daw-mixer-toggle" title="Show/hide mixer">🎚 Mixer</button>
```
and add immediately after it:
```html
        <button class="secondary small" id="daw-export" title="Render the arrangement to a WAV file">⬇ Export WAV</button>
```

- [ ] **Step 2: Add the script tag.** In `templates/index.html`, add `<script src="/static/daw-export.js?v=1"></script>` immediately after the `daw-waveedit.js` script tag and before the `daw.js` script tag.

- [ ] **Step 3: Bump daw.js cache-bust.** In `templates/index.html`, change `daw.js?v=5` → `daw.js?v=6` (daw.js is modified in Step 4).

- [ ] **Step 4: Wire the button in `daw.js`.** In `static/daw.js`, inside `_dawWireTransport()`, find the mixer-toggle listener block (`document.getElementById("daw-mixer-toggle").addEventListener(...)`). Immediately after that block's closing `});`, add:
```javascript
  document.getElementById("daw-export").addEventListener("click", () => dawExportWav());
```

- [ ] **Step 5: Syntax check, restart, smoke**

```bash
node --check static/daw.js
sudo systemctl restart nyx-step && sleep 2 && curl -s http://127.0.0.1:8001/health
curl -s http://127.0.0.1:8001/ | grep -c 'id="daw-export"'                              # expect 1
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8001/static/daw-export.js?v=1"  # expect 200
curl -s http://127.0.0.1:8001/ | grep -o 'daw-export.js?v=1' | head -1                   # expect daw-export.js?v=1
```
Expected: health 3.10.0; export button present (1); script 200.

- [ ] **Step 6: Commit**

```bash
git add templates/index.html static/daw.js
git commit -m "feat(daw): Export WAV button in transport, wired to dawExportWav

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: End-to-end live verification

**Files:** Create `/tmp/daw_export_verify.py` (throwaway)

- [ ] **Step 1: Write the driver**

```python
import struct
from playwright.sync_api import sync_playwright
BASE = "http://127.0.0.1:8001"
HDR = {"Cf-Access-Authenticated-User-Email": "steve.j.petry@gmail.com"}

def wav_info(path):
    with open(path, "rb") as fh:
        b = fh.read()
    assert b[0:4] == b"RIFF" and b[8:12] == b"WAVE", "not a WAV"
    numCh = struct.unpack_from("<H", b, 22)[0]
    sr = struct.unpack_from("<I", b, 24)[0]
    bits = struct.unpack_from("<H", b, 34)[0]
    dataSize = struct.unpack_from("<I", b, 40)[0]
    frames = dataSize // (numCh * (bits // 8))
    dur = frames / sr
    # max abs sample over the 16-bit data
    peak = 0
    for i in range(44, 44 + dataSize, 2):
        v = struct.unpack_from("<h", b, i)[0]
        a = abs(v)
        if a > peak: peak = a
    return {"size": len(b), "ch": numCh, "sr": sr, "bits": bits, "dur": dur, "peak": peak / 32768.0}

with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={"width": 1400, "height": 950}, extra_http_headers=HDR, accept_downloads=True)
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(BASE, wait_until="domcontentloaded")
    page.wait_for_selector("#btn-generate", timeout=15000)
    try: page.wait_for_load_state("networkidle", timeout=20000)
    except Exception: pass
    page.click('[data-tab="daw"]'); page.wait_for_timeout(2500)

    # Fresh project, one track, one clip at start 0
    page.evaluate("async()=>{ await dawNewProject('ExportCheck'); }"); page.wait_for_timeout(1000)
    page.evaluate("""()=>{ const t=dawState.tracks[0];
        dawAddClip(t.id,{file:_dawLibItems[0].file,name:_dawLibItems[0].name,source_duration:_dawLibItems[0].duration||10},0);}""")
    page.wait_for_timeout(400)
    arr_len = page.evaluate("dawArrangementLength()")
    print("arrangement length:", round(arr_len, 2))

    # Export → capture download
    with page.expect_download() as dl:
        page.click("#daw-export")
    path = "/tmp/export_check.wav"
    dl.value.save_as(path)
    info = wav_info(path)
    print("WAV:", info)
    print("valid header + size>1KB:", info["size"] > 1024)
    print("duration matches:", abs(info["dur"] - arr_len) < 0.2)
    print("has audio (peak>0):", info["peak"] > 0.001)

    # Mute the only track → export → near-silent render
    tid = page.evaluate("dawState.tracks[0].id")
    page.evaluate(f"() => {{ dawToggleMute('{tid}'); }}")
    page.wait_for_timeout(300)
    with page.expect_download() as dl2:
        page.click("#daw-export")
    dl2.value.save_as("/tmp/export_muted.wav")
    minfo = wav_info("/tmp/export_muted.wav")
    print("muted export peak (≈0):", round(minfo["peak"], 5), "SILENT:", minfo["peak"] < 0.001)

    # Empty project → no download, status message
    page.evaluate("async()=>{ await dawNewProject('Empty'); }"); page.wait_for_timeout(800)
    page.evaluate(f"() => {{ dawState.tracks[0].clips = []; }}")
    no_dl = False
    try:
        with page.expect_download(timeout=3000):
            page.click("#daw-export")
    except Exception:
        no_dl = True
    print("empty → no download:", no_dl, "| status:", page.evaluate("document.getElementById('daw-save-status').textContent"))

    print("PAGE ERRORS:", errs)
    page.screenshot(path="/tmp/daw_export_verify.png", full_page=True)
    ctx.close(); b.close()
print("EXPORT VERIFY DONE")
```

- [ ] **Step 2: Run** `cd /tmp && python3 daw_export_verify.py`
Expected: `WAV` info shows ch=2, 16 bits; `valid header + size>1KB: True`; `duration matches: True`; `has audio (peak>0): True`; `muted export … SILENT: True`; `empty → no download: True` with status "Nothing to export…"; `PAGE ERRORS: []`.

- [ ] **Step 3: Inspect** `/tmp/daw_export_verify.png` — the transport shows the **⬇ Export WAV** button; status reads "Exported ✓" after a successful export.

- [ ] **Step 4: Regression** `python3 -m pytest tests/ -q` (87 passed) and `node --check static/daw-export.js static/daw.js`.

No commit (driver is throwaway). If a fix was needed, commit with `fix(daw):` and re-run.

---

## Self-Review

**Spec coverage:**
- Client `OfflineAudioContext` render reproducing the live graph (clip env, track gain/pan, mute/solo, master) at live sample rate → Task 1 `dawRenderArrangement` ✓
- Reuse `_dawScheduleClipEnvelope` for gain/fades → Task 1 ✓ (called with `when=clip.start, localStart=0`)
- Buffer preload; skip missing/errored clips → Task 1 ✓
- 16-bit PCM WAV encode in browser → Task 1 `_dawAudioBufferToWav` ✓
- Download blob named `<project>.wav`; "Rendering…/Exported/Nothing to export/failed" status → Task 1 `dawExportWav` ✓
- Whole arrangement (0 → length), empty → no-op → Task 1 ✓
- Export button in transport, wired → Task 2 ✓
- Edge cases (empty, missing buffer, muted track, never-played ctx, mono up-mix, export-while-playing on separate context) → covered by Task 1 logic; verified Task 3 ✓
- Testing: live Playwright (valid WAV header, size, duration, has-audio, muted-silent, empty-no-download) → Task 3 ✓

**Placeholder scan:** none — full code and exact commands in every step.

**Type/name consistency:** `dawRenderArrangement`, `_dawAudioBufferToWav`, `dawExportWav` defined in Task 1 and referenced in Tasks 2 (button → `dawExportWav`) and 3. Reuses existing globals verbatim (`dawArrangementLength`, `_dawEnsureCtx`, `_dawCtx`, `_dawBufferCache`, `dawGetBuffer`, `_dawScheduleClipEnvelope`, `dawState`, `dawToggleMute`, `dawNewProject`, `dawAddClip`, `_dawLibItems`). Element ids `daw-export` / `daw-save-status` consistent across Tasks 1–3. Status uses the existing `#daw-save-status` element (no new element needed).
