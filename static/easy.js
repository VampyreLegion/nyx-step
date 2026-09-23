// ── Legion's BioInfusor tab ───────────────────────────────────────────────────
const _easyArtistState = {};
const _easyVocalState = {};
let _easyStyleInstruments = [];
let _genreMap = {};

fetch("/ollama/models").then(r => r.json()).then(data => {
  const sel = document.getElementById("easy-model");
  sel.innerHTML = "";
  data.models.forEach(m => {
    const opt = document.createElement("option");
    opt.value = m; opt.textContent = m;
    sel.appendChild(opt);
  });
  for (const pick of ["qwen3.5:27b", "gemma4:26b", "gemma4:latest"])
    if (data.models.includes(pick)) { sel.value = pick; break; }
});

fetch("/api/genres").then(r => r.json()).then(data => {
  const genres = data.genres || [];
  genres.forEach(g => { _genreMap[g.name] = g; });
  const sel = document.getElementById("easy-style");
  const byParent = {};
  genres.forEach(g => {
    if (!byParent[g.parent]) byParent[g.parent] = [];
    byParent[g.parent].push(g);
  });
  Object.keys(byParent).sort().forEach(cat => {
    const og = document.createElement("optgroup");
    og.label = cat;
    byParent[cat].forEach(g => {
      const opt = document.createElement("option");
      opt.value = g.name; opt.textContent = g.name;
      og.appendChild(opt);
    });
    sel.appendChild(og);
  });
});

document.getElementById("easy-style").addEventListener("change", e => {
  const val = e.target.value;
  const infoEl = document.getElementById("easy-style-info");
  if (!val) { infoEl.style.display = "none"; _easyStyleInstruments = []; return; }
  const g = _genreMap[val];
  if (!g) return;
  mwState.genre = g.name;
  mwState.bpm = Math.round((g.bpm_min + g.bpm_max) / 2);
  mwState.key = g.default_key || "C";
  mwState.scale = g.default_scale || "Major";
  _easyStyleInstruments = g.typical_instruments || [];
  let html = `<strong style="color:var(--accent)">${g.name}</strong>`;
  if (g.description) html += ` — ${g.description}`;
  if (_easyStyleInstruments.length) html += `<br>Instruments: ${_easyStyleInstruments.join(", ")}`;
  infoEl.innerHTML = html;
  infoEl.style.display = "block";
  updatePayloadPreview();
});

// ── Vocalist / Singer picker (top-15 per style) ───────────────────────────────
let _singerMap = {};

fetch("/api/singers").then(r => r.json()).then(data => {
  const singers = data.singers || [];
  singers.forEach(s => { _singerMap[s.name] = s; });
  const sel = document.getElementById("easy-singer");
  if (!sel) return;
  const byStyle = {};
  singers.forEach(s => {
    if (!byStyle[s.parent]) byStyle[s.parent] = [];
    byStyle[s.parent].push(s);
  });
  Object.keys(byStyle).sort().forEach(style => {
    const og = document.createElement("optgroup");
    og.label = style;
    byStyle[style].forEach(s => {
      const opt = document.createElement("option");
      opt.value = s.name; opt.textContent = s.name;
      og.appendChild(opt);
    });
    sel.appendChild(og);
  });
});

document.getElementById("easy-singer").addEventListener("change", e => {
  const val = e.target.value;
  const infoEl = document.getElementById("easy-singer-info");
  if (!val) { infoEl.style.display = "none"; return; }
  const s = _singerMap[val];
  if (!s) return;
  const tags = [s.name.toLowerCase() + " vocal", ...(s.tags || [])];
  mwState.vocal_tags = tags;
  document.getElementById("vocal-selected").value = tags.join(", ");
  document.getElementById("overview-tags").value = buildCaption();
  updateTagTokenCount();
  updatePayloadPreview();
  let html = `<strong style="color:var(--accent)">${esc(s.name)}</strong> <span style="color:var(--muted)">— ${esc(s.parent)}${s.range ? " · " + esc(s.range) : ""}</span>`;
  html += `<br><span style="color:var(--muted)">Vocal tags:</span> <span style="color:var(--accent2)">${esc(tags.join(", "))}</span>`;
  infoEl.innerHTML = html;
  infoEl.style.display = "block";
});

let _easyAppliedSource = null;

function _resetOtherApply(otherInfoId) {
  const other = document.querySelector(`#${otherInfoId} [data-apply-state]`);
  if (other) { other.textContent = "Apply to state"; other.disabled = false; }
}

async function _doArtistLookup(artist, infoEl, stateObj, useWeb = false, applyType = "artist") {
  const _lookupStart = Date.now();
  const _lookupBaseMsg = useWeb ? "Searching web + looking up" : "Looking up";
  infoEl.textContent = _lookupBaseMsg + "…";
  const _lookupTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - _lookupStart) / 1000);
    infoEl.textContent = `${_lookupBaseMsg}… ${elapsed}s`;
  }, 1000);
  try {
    const resp = await fetch("/ollama/artist-info", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({artist, model: document.getElementById("easy-model").value, use_web: useWeb}),
    });
    clearInterval(_lookupTimer);
    const data = await resp.json();
    if (data.error) { infoEl.textContent = "Error: " + data.error; return; }
    Object.assign(stateObj, data);

    const instrTags = data.instrument_tags || [];
    const vocalTags = data.vocal_tags || [];
    const styleTags = data.style_tags || [];
    const genreTag = data.genre_tag || "";
    const allAceTags = [genreTag, ...instrTags, ...vocalTags, ...styleTags].filter(Boolean);

    let html = "";
    if (allAceTags.length) {
      html += `<div style="margin-bottom:4px"><span style="color:var(--muted)">Nyx-Step tags:</span> `
            + `<span style="color:var(--accent2)">${allAceTags.join(", ")}</span></div>`;
    }
    if (data.vocal_key) {
      html += `<div style="margin-bottom:2px"><span style="color:var(--muted)">Vocal key:</span> <span style="color:var(--accent)">${data.vocal_key}</span></div>`;
    }
    if (data.lyric_style) {
      html += `<div style="margin-bottom:2px"><span style="color:var(--muted)">Style:</span> ${data.lyric_style}</div>`;
    }
    if (data.lyric_themes?.length) {
      html += `<div style="margin-bottom:4px"><span style="color:var(--muted)">Themes:</span> ${data.lyric_themes.join(", ")}</div>`;
    }
    if (allAceTags.length) {
      html += `<button class="secondary small" data-apply-state="${encodeURIComponent(JSON.stringify({instrTags, vocalTags, genreTag, vocalKey: data.vocal_key || ""}))}" data-apply-type="${applyType}" style="margin-top:2px">Apply to state</button>`;
    }
    infoEl.innerHTML = html || "No info found";

    infoEl.querySelector("[data-apply-state]")?.addEventListener("click", e => {
      const {instrTags, vocalTags, genreTag, vocalKey} = JSON.parse(decodeURIComponent(e.target.dataset.applyState));
      const type = e.target.dataset.applyType;
      if (type === "artist") {
        _resetOtherApply("easy-vocal-info");
        mwState.instruments = [...instrTags];
        mwState.vocal_tags = [...vocalTags];
        if (genreTag) mwState.genre = genreTag;
      } else {
        _resetOtherApply("easy-artist-info");
        mwState.instruments = [];
        mwState.vocal_tags = [...vocalTags];
      }
      // Parse "a3-e5, often sings in g major / e minor" → key + scale
      const _flatToSharp = {db:"C#",eb:"D#",gb:"F#",ab:"G#",bb:"A#"};
      const km = (vocalKey || "").match(/\b([a-g][#♯b♭]?)\s+(major|minor)\b/i);
      if (km) {
        let rawKey = km[1].toLowerCase().replace("♯", "#").replace("♭", "b");
        rawKey = _flatToSharp[rawKey] || (rawKey.charAt(0).toUpperCase() + rawKey.slice(1).replace("#", "#"));
        mwState.key = rawKey.charAt(0).toUpperCase() + rawKey.slice(1);
        mwState.scale = km[2].charAt(0).toUpperCase() + km[2].slice(1).toLowerCase();
        const keyEl = document.getElementById("style-key");
        const scaleEl = document.getElementById("style-scale");
        if (keyEl) keyEl.value = mwState.key;
        if (scaleEl) scaleEl.value = mwState.scale;
      }
      _easyAppliedSource = type;
      document.getElementById("instrument-selected").value = mwState.instruments.join(", ");
      document.getElementById("vocal-selected").value = mwState.vocal_tags.join(", ");
      document.getElementById("overview-tags").value = buildCaption();
      updatePayloadPreview();
      e.target.textContent = "Applied ✓";
      e.target.disabled = true;
    });
  } catch(err) {
    clearInterval(_lookupTimer);
    infoEl.textContent = "Lookup failed: " + err.message;
    showToast("Artist lookup failed: " + err.message, "error");
  }
}

document.getElementById("btn-easy-artist-lookup").addEventListener("click", () => {
  const btn = document.getElementById("btn-easy-artist-lookup");
  const artist = document.getElementById("easy-artist").value.trim();
  const infoEl = document.getElementById("easy-artist-info");
  if (!artist) { infoEl.textContent = "Enter an artist name."; return; }
  const useWeb = document.getElementById("easy-artist-web").checked;
  btn.disabled = true; btn.textContent = "Looking up…";
  _doArtistLookup(artist, infoEl, _easyArtistState, useWeb, "artist")
    .finally(() => { btn.disabled = false; btn.textContent = "Look Up"; });
});

document.getElementById("btn-easy-vocal-lookup").addEventListener("click", () => {
  const btn = document.getElementById("btn-easy-vocal-lookup");
  const artist = document.getElementById("easy-vocal-artist").value.trim();
  const infoEl = document.getElementById("easy-vocal-info");
  if (!artist) { infoEl.textContent = "Enter an artist name."; return; }
  const useWeb = document.getElementById("easy-vocal-web").checked;
  btn.disabled = true; btn.textContent = "Looking up…";
  _doArtistLookup(artist, infoEl, _easyVocalState, useWeb, "vocal")
    .finally(() => { btn.disabled = false; btn.textContent = "Look Up"; });
});

function _getEnhancementTags() {
  const tags = [];
  const activeInstruments = (mwState.instruments || []).map(i => i.toLowerCase());
  const activeVocals = (mwState.vocal_tags || []).map(v => v.toLowerCase());
  const genre = (mwState.genre || "").toLowerCase();

  // ── Instrument-based performance modifiers ──
  const hasGuitar = activeInstruments.some(i => /guitar|banjo|mandolin|ukulele/.test(i));
  const hasBass = activeInstruments.some(i => /bass/.test(i));
  const hasSynth = activeInstruments.some(i => /synth|pad|keyboard|organ|electric piano|rhodes|wurlitzer/.test(i));
  const hasAcidSynth = activeInstruments.some(i => /303|acid|moog|tb-?303/.test(i));
  const hasDrums = activeInstruments.some(i => /drum|808|909|percussion|beat/.test(i));
  const hasStrings = activeInstruments.some(i => /string|violin|cello|viola|orchestra/.test(i));
  const hasBrass = activeInstruments.some(i => /brass|trumpet|trombone|horn|sax/.test(i));
  const hasPiano = activeInstruments.some(i => /piano|grand|upright/.test(i));
  const hasFlute = activeInstruments.some(i => /flute|woodwind|clarinet|oboe|bassoon/.test(i));
  const hasVoice = activeVocals.some(i => /vocal|voice|singer|choir/.test(i)) || activeVocals.length > 0;

  if (hasGuitar) tags.push("solo guitar break", "rhythmic strumming");
  if (hasAcidSynth) tags.push("TB303 bassline fill", "squelchy resonant filter");
  else if (hasSynth) tags.push("arpeggiated synth", "sweeping pads");
  if (hasBass) tags.push("groove bassline");
  if (hasDrums) tags.push("driving rhythm", "syncopated");
  if (hasStrings) tags.push("legato strings", "staccato strings");
  if (hasBrass) tags.push("brass section swell");
  if (hasPiano) tags.push("grand piano", "piano arpeggios");
  if (hasFlute) tags.push("soaring flute melody");

  // ── Genre-based production & mood ──
  if (/dubstep|techno|house|trance|edm|dance|electronic|acid/.test(genre)) {
    tags.push("sidechained", "filtered", "punchy");
  } else if (/rock|metal|punk|grunge|alternative/.test(genre)) {
    tags.push("overdrive", "powerful", "distorted rhythm guitar");
  } else if (/jazz|blues|soul|r&b|funk/.test(genre)) {
    tags.push("swing", "warm", "soulful");
  } else if (/hip hop|rap|trap/.test(genre)) {
    tags.push("lo-fi", "pitch shift", "heavy bass");
  } else if (/ambient|chill|downtempo|lo-fi/.test(genre)) {
    tags.push("ethereal", "reverb hall", "dreamy");
  } else if (/classical|orchestral|cinematic|baroque/.test(genre)) {
    tags.push("cinematic", "epic", "lush orchestral strings");
  } else if (/folk|acoustic|country|singer/.test(genre)) {
    tags.push("intimate", "fingerpicked", "warm");
  } else if (/pop|synthpop|indie/.test(genre)) {
    tags.push("catchy", "bright", "polished");
  } else {
    tags.push("rich", "textured", "dynamic");
  }

  // ── Add a structural breakdown for instrumental sections ──
  const structure = document.getElementById("easy-structure").value;
  if (structure === "EDM Structure") {
    tags.push("build-up", "breakdown");
  } else if (!/minimal/i.test(structure)) {
    tags.push("breakdown");
  }

  return [...new Set(tags)];
}

document.getElementById("btn-easy-gen").addEventListener("click", () => {
  const btn = document.getElementById("btn-easy-gen");
  const log = document.getElementById("easy-log");
  log.style.display = "block";
  log.textContent = "";
  const editor = document.getElementById("lyrics-editor");
  editor.value = "";
  mwState.lyrics = "";
  btn.disabled = true;
  btn.textContent = "✨ Generating…";
  let tokenCount = 0;

  const instrumental = document.getElementById("easy-instrumental").checked;
  const enhanceChecked = document.getElementById("easy-enhance").checked;

  const instrSet = new Set([..._easyStyleInstruments, ...(_easyArtistState.instrument_tags || [])]);
  const instrumentsHint = [...instrSet].join(", ");
  const vocalTags = [...(_easyVocalState.vocal_tags || []), ...(_easyArtistState.vocal_tags || []), ...(mwState.vocal_tags || [])];
  const vocalStyle = [...new Set(vocalTags)].join(", ");

  // Apply auto-enhance tags to the overview caption and pass to Ollama
  let enhancementTags = "";
  if (enhanceChecked) {
    enhancementTags = _getEnhancementTags().join(", ");
    if (enhancementTags) {
      const existingTags = document.getElementById("overview-tags").value.trim();
      document.getElementById("overview-tags").value = existingTags
        ? existingTags + ", " + enhancementTags
        : enhancementTags;
      updatePayloadPreview();
    }
  }

  const params = new URLSearchParams({
    topic: document.getElementById("easy-topic").value,
    genre: mwState.genre || document.getElementById("easy-style").value || "electronic",
    key: mwState.key,
    mood: document.getElementById("easy-mood").value,
    structure: document.getElementById("easy-structure").value,
    subject: document.getElementById("easy-subject").value,
    name_override: document.getElementById("easy-name-override").value,
    model: document.getElementById("easy-model").value,
    artist: document.getElementById("easy-artist").value.trim(),
    lyric_style: _easyArtistState.lyric_style || "",
    lyric_themes: (_easyArtistState.lyric_themes || []).join(", "),
    vocal_style: vocalStyle,
    instruments_hint: instrumentsHint,
    enhancement_tags: enhancementTags,
    instrumental: instrumental ? "true" : "false",
  });

  const es = new EventSource("/ollama/stream?" + params.toString());
  es.addEventListener("token", e => {
    const {token} = JSON.parse(e.data);
    editor.value += token;
    mwState.lyrics = editor.value;
    log.textContent += token;
    log.scrollTop = log.scrollHeight;
    tokenCount++;
    btn.textContent = `✨ Generating… (${tokenCount} tokens)`;
  });
  es.addEventListener("done", () => {
    es.close();
    log.textContent += "\n[done]";
    btn.disabled = false;
    btn.textContent = "✨ Generate Music Idea";
    syncOverviewFromState();
  });
  es.onerror = () => {
    es.close();
    log.textContent += "\n[error]";
    btn.disabled = false;
    btn.textContent = "✨ Generate Music Idea";
  };
});
