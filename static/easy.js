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
  if (data.models.includes("gemma4:latest")) sel.value = "gemma4:latest";
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

let _easyAppliedSource = null;

function _resetOtherApply(otherInfoId) {
  const other = document.querySelector(`#${otherInfoId} [data-apply-state]`);
  if (other) { other.textContent = "Apply to state"; other.disabled = false; }
}

async function _doArtistLookup(artist, infoEl, stateObj, useWeb = false, applyType = "artist") {
  infoEl.textContent = useWeb ? "Searching web + looking up…" : "Looking up…";
  try {
    const resp = await fetch("/ollama/artist-info", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({artist, model: document.getElementById("easy-model").value, use_web: useWeb}),
    });
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
      html += `<button class="secondary small" data-apply-state="${encodeURIComponent(JSON.stringify({instrTags, vocalTags}))}" data-apply-type="${applyType}" style="margin-top:2px">Apply to state</button>`;
    }
    infoEl.innerHTML = html || "No info found";

    infoEl.querySelector("[data-apply-state]")?.addEventListener("click", e => {
      const {instrTags, vocalTags} = JSON.parse(decodeURIComponent(e.target.dataset.applyState));
      const type = e.target.dataset.applyType;
      if (type === "artist") {
        _resetOtherApply("easy-vocal-info");
        mwState.instruments = [...instrTags];
        mwState.vocal_tags = [...vocalTags];
      } else {
        _resetOtherApply("easy-artist-info");
        mwState.instruments = [];
        mwState.vocal_tags = [...vocalTags];
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
    infoEl.textContent = "Lookup failed: " + err.message;
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
  const instrSet = new Set([..._easyStyleInstruments, ...(_easyArtistState.instrument_tags || [])]);
  const instrumentsHint = [...instrSet].join(", ");
  const vocalTags = [...(_easyVocalState.vocal_tags || []), ...(_easyArtistState.vocal_tags || [])];
  const vocalStyle = [...new Set(vocalTags)].join(", ");

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
