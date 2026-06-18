// ── DAW MIDI: Web-MIDI access + audio→MIDI conversion ─────────────────────────
let _dawMidiAccess = null;
function _dawNoteFreq(p) { return 440 * Math.pow(2, (p - 69) / 12); }

async function dawInitMidi() {
  if (_dawMidiAccess) return _dawMidiAccess;
  if (!navigator.requestMIDIAccess) return null;
  try { _dawMidiAccess = await navigator.requestMIDIAccess({ sysex: false }); }
  catch (_) { _dawMidiAccess = null; }
  return _dawMidiAccess;
}
function dawMidiOutputs() {
  if (!_dawMidiAccess) return [];
  return [..._dawMidiAccess.outputs.values()].map(o => ({ id: o.id, name: o.name }));
}
function dawMidiGetOutput(id) {
  if (!_dawMidiAccess || !id) return null;
  for (const o of _dawMidiAccess.outputs.values()) if (o.id === id) return o;
  return null;
}
function dawMidiAllNotesOff() {
  if (typeof _dawMidiActiveOuts === "undefined") return;
  for (const o of _dawMidiActiveOuts) { try { o.send([0xB0, 123, 0]); } catch (_) {} }
  _dawMidiActiveOuts.clear();
}

// Convert an audio clip → a new MIDI track.
let _dawMidiDialogEl = null;
function _dawCloseMidiDialog() {
  if (_dawMidiDialogEl) { _dawMidiDialogEl.remove(); _dawMidiDialogEl = null; }
  document.removeEventListener("keydown", _dawMidiEsc);
}
function _dawMidiEsc(e) { if (e.key === "Escape") _dawCloseMidiDialog(); }

function openConvertToMidiDialog(clip, anchor) {
  _dawCloseMidiDialog();
  const m = document.createElement("div"); _dawMidiDialogEl = m;
  m.style.cssText = "position:fixed;z-index:1000;background:#15171f;border:1px solid #2d3041;border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:6px;min-width:200px;box-shadow:0 4px 16px rgba(0,0,0,0.5)";
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 220) + "px"; m.style.top = (r.bottom + 4) + "px";
  const title = document.createElement("div");
  title.textContent = "🎹 Convert to MIDI"; title.style.cssText = "font-size:11px;color:#00d4b6;font-weight:bold";
  const modeRow = document.createElement("label");
  modeRow.style.cssText = "font-size:11px;color:#e2e4ed;display:flex;align-items:center;gap:6px";
  modeRow.textContent = "Mode";
  const sel = document.createElement("select"); sel.style.cssText = "font-size:11px;width:auto;flex:0 0 auto";
  for (const [v, l] of [["melody", "Melody"], ["rhythm", "Rhythm"], ["piano", "Piano"]]) {
    const o = document.createElement("option"); o.value = v; o.textContent = l; sel.appendChild(o);
  }
  modeRow.appendChild(sel);
  const btnRow = document.createElement("div"); btnRow.style.cssText = "display:flex;gap:6px;justify-content:flex-end";
  const go = document.createElement("button"); go.className = "secondary small"; go.textContent = "Convert"; go.style.cssText = "font-size:11px";
  const cancel = document.createElement("button"); cancel.className = "secondary small"; cancel.textContent = "Cancel"; cancel.style.cssText = "font-size:11px";
  go.addEventListener("click", () => { const mode = sel.value; _dawCloseMidiDialog(); dawConvertToMidi(clip, mode); });
  cancel.addEventListener("click", _dawCloseMidiDialog);
  btnRow.appendChild(go); btnRow.appendChild(cancel);
  m.appendChild(title); m.appendChild(modeRow); m.appendChild(btnRow);
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener("keydown", _dawMidiEsc), 0);
}

async function dawConvertToMidi(clip, mode) {
  _dawSetSaveStatus("Transcribing…");
  try {
    const resp = await fetch("/daw/transcribe", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: clip.file, mode }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || ("HTTP " + resp.status));
    const offset = clip.start || 0;
    const notes = (data.notes || []).map(n => ({ start: n.start + offset, dur: n.dur, pitch: n.pitch, vel: n.vel }));
    const t = dawAddMidiTrack(clip.name.slice(0, 14) + " · " + mode);
    dawSetTrackNotes(t.id, notes);
    _dawSetSaveStatus(notes.length ? ("MIDI ready ✓ (" + notes.length + " notes)") : "No notes detected");
  } catch (e) {
    _dawSetSaveStatus("Transcribe failed: " + e.message);
  }
}
