// ── Central state ─────────────────────────────────────────────────────────────
const mwState = {
  genre: "", bpm: 120, key: "C", scale: "Major", mode: "",
  time_sig: "4/4", chords: "", notes: "",
  instruments: [], vocal_tags: [], lyrics: "",
  steps: 8, cfg_scale: 2.0, duration: 160.0, seed: 0, lock_seed: false,
  temperature: 0.85, top_p: 0.9, top_k: 0, min_p: 0.0,
  audio_format: "mp3", audio_quality: "V0",
  vocal_language: "auto",
  generate_audio_codes: true,
  dit_model: "turbo",
  sampler_name: "er_sde",
  scheduler: "linear_quadratic",
  batch_size: 1,
  lora_name: "",
  lora_scale: 1.0,
  lora2_name: "",
  lora2_scale: 1.0,
  negative_tags: "",
  engine: "ace-step",
};

// ── Tiny event bus ────────────────────────────────────────────────────────────
// Lets independent feature modules react to shared data changes (library
// refresh, job completion, settings loaded) without poking each other's DOM.
const mwBus = {
  _handlers: {},
  on(event, handler) {
    (this._handlers[event] ||= []).push(handler);
    return () => this.off(event, handler);
  },
  off(event, handler) {
    const list = this._handlers[event];
    if (!list) return;
    const i = list.indexOf(handler);
    if (i >= 0) list.splice(i, 1);
  },
  emit(event, payload) {
    (this._handlers[event] || []).slice().forEach(h => {
      try { h(payload); } catch (e) { console.error("mwBus handler error:", e); }
    });
  },
};
