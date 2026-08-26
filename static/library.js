// ── Library — browse & play every MP3 in ComfyUI output/audio ────────────────
let _libraryFiles = [];
let _libraryDir = "";
let _libraryLoaded = false;

function _libFmtSize(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
  return bytes + " B";
}

async function loadLibrary(force) {
  const list = document.getElementById("library-list");
  if (!list) return;
  if (_libraryLoaded && !force) { _renderLibrary(); return; }
  list.innerHTML = "<div style='color:var(--muted);font-size:12px;padding:12px 0'>Loading…</div>";
  try {
    const resp = await fetch("/api/library");
    const data = await resp.json();
    if (data.error) { showToast(data.error, "error"); list.innerHTML = ""; return; }
    _libraryFiles = data.files || [];
    _libraryDir = data.dir || "";
    _libraryLoaded = true;
    _renderLibrary();
  } catch (err) {
    list.innerHTML = "";
    showToast("Library load failed: " + err.message, "error");
  }
}

function _renderLibrary() {
  const list = document.getElementById("library-list");
  const empty = document.getElementById("library-empty");
  const count = document.getElementById("library-count");
  if (!list) return;
  list.innerHTML = "";

  const query = (document.getElementById("library-search").value || "").trim().toLowerCase();
  const filtered = query
    ? _libraryFiles.filter(f => f.name.toLowerCase().includes(query))
    : _libraryFiles;

  if (count) count.textContent = filtered.length + " of " + _libraryFiles.length + " songs — " + _libraryDir;

  if (!filtered.length) {
    empty.style.display = "";
    return;
  }
  empty.style.display = "none";

  filtered.forEach(f => {
    const row = document.createElement("div");
    row.style.cssText = "background:var(--surface2);border:1px solid var(--border);border-radius:6px;" +
      "padding:8px 12px;font-size:12px;display:flex;align-items:center;gap:10px;cursor:pointer";
    const date = f.mtime ? new Date(f.mtime * 1000).toLocaleString() : "";
    row.innerHTML =
      "<span style='color:var(--accent2);font-weight:bold'>▶</span>" +
      "<span style='flex:1;color:var(--text);word-break:break-all'>" + esc(f.name) + "</span>" +
      "<span style='color:var(--muted);font-size:11px;white-space:nowrap'>" + _libFmtSize(f.size) + "</span>" +
      "<span style='color:var(--muted);font-size:11px;white-space:nowrap'>" + date + "</span>";
    row.addEventListener("click", () => playLibraryFile(f.name, row));
    list.appendChild(row);
  });
}

function playLibraryFile(name, row) {
  const audio = document.getElementById("library-audio");
  const now = document.getElementById("library-now-playing");
  if (!audio) return;
  const src = "/library/audio/" + name.split("/").map(encodeURIComponent).join("/");
  if (!audio.src.endsWith(src)) {
    audio.src = src;
  }
  audio.play();
  if (now) now.textContent = "♪ " + name;
  document.querySelectorAll("#library-list > div").forEach(r => {
    r.style.borderColor = "var(--border)";
  });
  if (row) row.style.borderColor = "var(--accent2)";
}

document.getElementById("library-search")?.addEventListener("input", () => _renderLibrary());

document.getElementById("btn-library-refresh")?.addEventListener("click", () => loadLibrary(true));
