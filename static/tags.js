// ── Tagging tab — staging buffer ─────────────────────────────────────────────
let _tagBuffer = JSON.parse(localStorage.getItem("mw_tag_buffer") || "[]");

function _insertAtCursor(text) {
  const editor = document.getElementById("lyrics-editor");
  const pos = editor.selectionStart;
  const before = editor.value.substring(0, pos);
  const after = editor.value.substring(pos);
  editor.value = before + text + after;
  editor.selectionStart = editor.selectionEnd = pos + text.length;
  editor.focus();
  mwState.lyrics = editor.value;
  updatePayloadPreview();
}

function _updateStagingBar() {
  const list = document.getElementById("tag-staging-list");
  const btn = document.getElementById("btn-insert-parens");
  if (_tagBuffer.length === 0) {
    list.innerHTML = "<span style='color:var(--muted)'>(click plain-text tags to stage, then insert as a group)</span>";
    btn.disabled = true;
  } else {
    list.innerHTML = _tagBuffer
      .map(t => `<span style="background:var(--surface2);border:1px solid var(--accent);border-radius:10px;padding:1px 8px;margin:2px;display:inline-block;font-size:11px;color:var(--accent)">${t}</span>`)
      .join("");
    btn.disabled = false;
  }
}

function _saveTagBuffer() {
  localStorage.setItem("mw_tag_buffer", JSON.stringify(_tagBuffer));
  _updateStagingBar();
}

function _restoreStagedChips() {
  if (!_tagBuffer.length) return;
  document.querySelectorAll(".tag-btn").forEach(btn => {
    const tag = btn.dataset.tag;
    if (tag && !tag.startsWith("[") && !tag.startsWith("(") && _tagBuffer.includes(tag)) {
      btn.style.borderColor = "var(--accent)";
      btn.style.color = "var(--accent)";
    }
  });
}

document.querySelectorAll(".tag-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const tag = btn.dataset.tag;
    if (tag.startsWith("[") || tag.startsWith("(")) {
      const isSectionTag = tag.startsWith("[") &&
        !tag.startsWith("[Vocal:") &&
        !tag.match(/^\[[a-z]{2}\]$/);
      _insertAtCursor(isSectionTag ? "\n" + tag + "\n" : tag);
      return;
    }
    const idx = _tagBuffer.indexOf(tag);
    if (idx === -1) {
      _tagBuffer.push(tag);
      btn.style.borderColor = "var(--accent)";
      btn.style.color = "var(--accent)";
    } else {
      _tagBuffer.splice(idx, 1);
      btn.style.borderColor = "";
      btn.style.color = "";
    }
    _saveTagBuffer();
  });
});

document.getElementById("btn-insert-parens").addEventListener("click", () => {
  if (!_tagBuffer.length) return;
  _insertAtCursor(`(${_tagBuffer.join(", ")})`);
  _tagBuffer = [];
  document.querySelectorAll(".tag-btn").forEach(b => { b.style.borderColor = ""; b.style.color = ""; });
  _saveTagBuffer();
});

document.getElementById("btn-clear-staging").addEventListener("click", () => {
  _tagBuffer = [];
  document.querySelectorAll(".tag-btn").forEach(b => { b.style.borderColor = ""; b.style.color = ""; });
  _saveTagBuffer();
});

// ── Song structure templates ───────────────────────────────────────────────────
const TEMPLATES = {
  "Verse-Chorus": "[Verse]\n\n[Chorus]\n\n[Verse]\n\n[Chorus]\n",
  "Verse-Chorus-Bridge": "[Verse]\n\n[Chorus]\n\n[Verse]\n\n[Chorus]\n\n[Bridge]\n\n[Chorus]\n",
  "Intro-Verse-Chorus-Outro": "[Intro: Atmospheric]\n\n[Verse]\n\n[Chorus: Anthemic]\n\n[Verse]\n\n[Chorus: Anthemic]\n\n[Outro]\n",
  "EDM Structure": "[Intro: Atmospheric]\n\n[Build]\n\n[Drop]\n\n[Breakdown]\n\n[Build]\n\n[Drop]\n\n[Outro]\n",
  "Minimal": "[Verse]\n\n[Chorus]\n",
};
const tplSel = document.getElementById("lyrics-template");
Object.keys(TEMPLATES).forEach(k => {
  const opt = document.createElement("option");
  opt.value = k; opt.textContent = k;
  tplSel.appendChild(opt);
});
tplSel.addEventListener("change", () => {
  if (!tplSel.value) return;
  const editor = document.getElementById("lyrics-editor");
  editor.value = TEMPLATES[tplSel.value] || "";
  mwState.lyrics = editor.value;
  updatePayloadPreview();
});

// Restore staging bar display on load
_updateStagingBar();
