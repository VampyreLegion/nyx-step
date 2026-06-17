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
    let settled = false, errored = false;
    const es = new EventSource("/stems/demucs/stream?filename=" + encodeURIComponent(file) + "&model=htdemucs");
    const done = async (ok) => {
      if (settled) return; settled = true; es.close();
      if (!ok) return resolve(null);
      const base = file.replace(/\.[^.]+$/, "");
      const f = "separated/htdemucs/" + base + "/" + stem + ".mp3";
      const buf = await dawGetBuffer(f);
      resolve(buf ? f : null);
    };
    es.addEventListener("log", e => {
      try { const l = JSON.parse(e.data).line; if (l.includes("[error]")) errored = true;
            _dawSetSaveStatus("Isolating: " + l.slice(0, 36)); } catch (_) {}
    });
    es.addEventListener("done", () => done(!errored));
    es.onerror = () => done(false);
  });
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

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:6px;justify-content:flex-end";
  const gen = document.createElement("button");
  gen.className = "secondary small"; gen.textContent = "Generate"; gen.disabled = true;
  gen.style.cssText = "font-size:11px";
  const cancel = document.createElement("button");
  cancel.className = "secondary small"; cancel.textContent = "Cancel"; cancel.style.cssText = "font-size:11px";
  tagsIn.addEventListener("input", () => {
    gen.disabled = !tagsIn.value.trim();
    if (!_userPickedType && _DAW_VOCAL_RE.test(tagsIn.value.toLowerCase())) typeSel.value = "vocals";
  });
  gen.addEventListener("click", () => {
    const tags = tagsIn.value.trim();
    if (!tags) return;
    const dur = Math.min(300, Math.max(5, parseFloat(durIn.value) || 15));
    const type = typeSel.value;
    const isolate = isoCb.checked;
    _dawCloseGenDialog();
    dawGenerateOntoTrack(trackId, tags, dur, type, isolate);
  });
  cancel.addEventListener("click", _dawCloseGenDialog);
  btnRow.appendChild(gen); btnRow.appendChild(cancel);

  m.appendChild(title); m.appendChild(tagsIn); m.appendChild(typeRow); m.appendChild(durRow); m.appendChild(isoRow); m.appendChild(btnRow);
  document.body.appendChild(m);
  tagsIn.focus();
  setTimeout(() => {
    document.addEventListener("mousedown", _dawGenOutside);
    document.addEventListener("keydown", _dawGenEsc);
  }, 0);
}

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
      let added = 0;
      for (const t of ["vocals", "drums", "bass", "other"]) {
        const f = "separated/htdemucs/" + base + "/" + t + ".mp3";
        const buf = await dawGetBuffer(f);
        if (!buf) continue;
        dawAddTrack(clip.name.slice(0, 14) + " — " + t);
        const newId = dawState.tracks[dawState.tracks.length - 1].id;
        dawAddClip(newId, { file: f, name: t, source_duration: buf.duration }, clip.start);
        added++;
      }
      if (!added) { _dawSetSaveStatus("Stem split failed — no stems produced"); return; }
      if (!track.mute) dawToggleMute(track.id);
      dawMarkDirty();                          // autosave only on success
      _dawSetSaveStatus("Stems ready ✓");
    } catch (e) {
      _dawSetSaveStatus("Stem split failed: " + e.message);
    } finally {
      _dawGenTracks.delete(track.id); renderTimeline();   // no dawMarkDirty here — keeps failure status visible
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
  es.onerror = () => finish(true);
}
