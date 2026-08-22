// ── Harmonic Progression Presets ─────────────────────────────────────────────
const CHORD_PROGRESSIONS = {
  'I - IV - V - I (Pop/Rock)': 'melodic pop chord progression, major key resolution, catchy hooks',
  'ii - V - I (Jazz)': 'jazz ii-V-I progression, smooth voice leading, sophisticated harmony',
  'I - vi - IV - V (50s Doo-Wop)': 'doo-wop progression, nostalgic, warm major chords',
  'I - IV - vi - V (Modern Pop)': 'modern pop progression, uplifting, anthemic feel',
  'i - III - VII - IV (Epic)': 'epic minor progression, dramatic, cinematic chords',
  'i - iv - v - i (Natural Minor)': 'dark natural minor progression, moody, introspective',
  'I - V - vi - IV (Axis)': 'axis progression, emotionally resonant, singalong',
  'vi - IV - I - V (Emotional)': 'emotional progression, bittersweet, powerful',
  'i - VII - III - VI (Aeolian)': 'aeolian mode progression, floating, modal feel',
  'I - bVII - IV - I (Rock)': 'rock mixolydian progression, bluesy, raw energy',
  'i - bVI - bIII - bVII (Cinematic)': 'cinematic minor progression, sweeping, grand',
  'ii - V - I - IV (Extended Jazz)': 'extended jazz progression, bebop flavor, complex',
};

function injectChordTags(name) {
  const tags = CHORD_PROGRESSIONS[name];
  if (!tags) return;
  const tagInput = document.getElementById('caption-input') || document.getElementById('tags');
  if (tagInput) {
    const current = tagInput.value.trim();
    tagInput.value = current ? `${current}, ${tags}` : tags;
    tagInput.dispatchEvent(new Event('input'));
  }
}
