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
