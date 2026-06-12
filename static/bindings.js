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
bind("param-seed",       "seed",       v => parseInt(v)   || 0);
bind("param-batch-size", "batch_size", v => Math.min(8, Math.max(1, parseInt(v) || 1)));

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

document.getElementById("param-vocal-language").addEventListener("change", e => {
  mwState.vocal_language = e.target.value;
});

const _modelHints = {
  turbo: "Recommended: 8 steps, CFG 2.0",
  sft:   "Recommended: 50 steps, CFG 7.0",
  base:  "Recommended: 50 steps, CFG 7.0 — enables Lego/Extract/Complete",
};
document.getElementById("param-dit-model").addEventListener("change", e => {
  const m = e.target.value;
  mwState.dit_model = m;
  document.getElementById("param-model-hint").textContent = _modelHints[m] || "";
});

document.getElementById("param-sampler").addEventListener("change", e => {
  mwState.sampler_name = e.target.value;
});
document.getElementById("param-scheduler").addEventListener("change", e => {
  mwState.scheduler = e.target.value;
});

document.getElementById("param-gen-audio-codes").addEventListener("change", e => {
  mwState.generate_audio_codes = e.target.checked;
});

document.getElementById("param-lora-name").addEventListener("change", e => {
  mwState.lora_name = e.target.value;
});
document.getElementById("param-lora-scale").addEventListener("input", e => {
  mwState.lora_scale = parseFloat(e.target.value) || 1.0;
});
document.getElementById("param-lora2-name").addEventListener("change", e => {
  mwState.lora2_name = e.target.value;
});
document.getElementById("param-lora2-scale").addEventListener("input", e => {
  mwState.lora2_scale = parseFloat(e.target.value) || 1.0;
});
bind("param-negative-tags", "negative_tags");

// Populate LoRA dropdown from ComfyUI
async function _loadLoras() {
  const sel  = document.getElementById("param-lora-name");
  const sel2 = document.getElementById("param-lora2-name");
  const countEl = document.getElementById("lora-count");
  try {
    const data = await fetch("/loras").then(r => r.json());
    const loras = data.loras || [];
    const opts = '<option value="">None</option>' + loras.map(l => `<option value="${l}">${l}</option>`).join("");
    sel.innerHTML  = opts;
    sel2.innerHTML = opts;
    countEl.textContent = loras.length ? `${loras.length} available` : "(none installed)";
  } catch (_) {
    countEl.textContent = "(ComfyUI offline)";
  }
}
_loadLoras();
document.getElementById("btn-lora-refresh").addEventListener("click", _loadLoras);

document.getElementById("btn-reset-params").addEventListener("click", () => {
  const defaults = {
    steps: 8, cfg_scale: 2.0, duration: 30.0,
    temperature: 0.85, top_p: 0.9, top_k: 0, min_p: 0.0,
    seed: 0, lock_seed: false,
    audio_format: "mp3", audio_quality: "V0",
    vocal_language: "auto",
    generate_audio_codes: true,
    dit_model: "turbo",
    sampler_name: "er_sde",
    scheduler: "linear_quadratic",
    batch_size: 1,
    negative_tags: "",
  };
  Object.assign(mwState, defaults);
  document.getElementById("param-steps").value    = defaults.steps;
  document.getElementById("param-cfg").value      = defaults.cfg_scale;
  document.getElementById("param-duration").value = defaults.duration;
  document.getElementById("param-temp").value     = defaults.temperature;
  document.getElementById("param-topp").value     = defaults.top_p;
  document.getElementById("param-topk").value     = defaults.top_k;
  document.getElementById("param-minp").value     = defaults.min_p;
  document.getElementById("param-seed").value     = defaults.seed;
  document.getElementById("param-lock-seed").checked = false;
  document.getElementById("param-audio-format").value   = defaults.audio_format;
  document.getElementById("param-audio-quality").value  = defaults.audio_quality;
  document.getElementById("param-quality-wrap").style.display = "";
  document.getElementById("param-vocal-language").value = defaults.vocal_language;
  document.getElementById("param-gen-audio-codes").checked = true;
  document.getElementById("param-dit-model").value = "turbo";
  document.getElementById("param-sampler").value = "er_sde";
  document.getElementById("param-scheduler").value = "linear_quadratic";
  document.getElementById("param-batch-size").value = 1;
  document.getElementById("param-negative-tags").value = "";
  document.getElementById("param-model-hint").textContent = _modelHints["turbo"];
  updatePayloadPreview();
});

const _qualityOptions = {
  mp3:  [["V0","V0 (best VBR)"],["128k","128k"],["320k","320k"]],
  flac: [],
  opus: [["64k","64k"],["96k","96k"],["128k","128k"],["192k","192k"],["320k","320k"]],
};
document.getElementById("param-audio-format").addEventListener("change", e => {
  const fmt = e.target.value;
  mwState.audio_format = fmt;
  const qSel = document.getElementById("param-audio-quality");
  const qWrap = document.getElementById("param-quality-wrap");
  const opts = _qualityOptions[fmt] || [];
  if (opts.length === 0) {
    qWrap.style.display = "none";
    mwState.audio_quality = "";
  } else {
    qWrap.style.display = "";
    qSel.innerHTML = opts.map(([v,l]) => `<option value="${v}">${l}</option>`).join("");
    mwState.audio_quality = opts[0][0];
  }
});
document.getElementById("param-audio-quality").addEventListener("change", e => {
  mwState.audio_quality = e.target.value;
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
