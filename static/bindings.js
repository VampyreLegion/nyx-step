// ── Style / Params / Lyrics / Overview field bindings ─────────────────────────
const bind = (id, key, transform) => {
  const el = document.getElementById(id);
  if (!el) return;
  const handler = () => {
    mwState[key] = transform ? transform(el.value) : el.value;
    document.getElementById("overview-tags").value = buildCaption();
    updateTagTokenCount();
    updatePayloadPreview();
  };
  el.addEventListener("input", _debounce(handler, 150));
  el.addEventListener("change", handler);
};

bind("style-bpm",    "bpm",         v => parseInt(v)   || 120);
bind("style-key",    "key");
bind("style-scale",  "scale");
bind("style-mode",   "mode");
bind("style-timesig","time_sig");
bind("style-chords", "chords");
bind("style-notes",  "notes");
bind("param-steps",  "steps",       v => parseInt(v)   || 8);
bind("param-cfg",    "cfg_scale",   v => parseFloat(v) || 2.0);
bind("param-duration","duration",   v => parseFloat(v) || 30);
bind("param-temp",   "temperature", v => parseFloat(v) || 0.85);
bind("param-topp",   "top_p",       v => parseFloat(v) || 0.9);
bind("param-topk",   "top_k",       v => parseInt(v)   || 0);
bind("param-minp",   "min_p",       v => parseFloat(v) || 0.0);
bind("param-seed",   "seed",        v => parseInt(v)   || 0);

document.getElementById("style-chords-preset").addEventListener("change", e => {
  if (!e.target.value) return;
  document.getElementById("style-chords").value = e.target.value;
  mwState.chords = e.target.value;
  e.target.value = "";
  document.getElementById("overview-tags").value = buildCaption();
  updatePayloadPreview();
});

document.getElementById("param-lock-seed").addEventListener("change", e => {
  mwState.lock_seed = e.target.checked;
});

document.getElementById("btn-random-seed").addEventListener("click", () => {
  const seed = Math.floor(Math.random() * (2 ** 32 - 1)) + 1;
  document.getElementById("param-seed").value = seed;
  document.getElementById("param-lock-seed").checked = true;
  mwState.seed = seed;
  mwState.lock_seed = true;
  updatePayloadPreview();
});

document.getElementById("lyrics-editor").addEventListener("input", e => {
  mwState.lyrics = e.target.value;
  updatePayloadPreview();
});

document.getElementById("overview-lyrics").addEventListener("input", e => {
  mwState.lyrics = e.target.value;
});

document.getElementById("overview-tags").addEventListener("input", () => { updateTagTokenCount(); updatePayloadPreview(); });
document.getElementById("btn-sync-overview").addEventListener("click", syncOverviewFromState);
