// ── Central state ─────────────────────────────────────────────────────────────
const mwState = {
  genre: "", bpm: 120, key: "C", scale: "Major", mode: "",
  time_sig: "4/4", chords: "", notes: "",
  instruments: [], vocal_tags: [], lyrics: "",
  steps: 8, cfg_scale: 2.0, duration: 30.0, seed: 0, lock_seed: false,
  temperature: 0.85, top_p: 0.9, top_k: 0, min_p: 0.0,
  audio_format: "mp3", audio_quality: "V0",
  vocal_language: "auto",
  generate_audio_codes: true,
  dit_model: "turbo",
  batch_size: 1,
};
