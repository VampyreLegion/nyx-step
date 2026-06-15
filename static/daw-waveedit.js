// ── DAW clip actions menu (wave editor) ───────────────────────────────────────
let _dawMenuEl = null;

function _dawCloseClipMenu() {
  if (!_dawMenuEl) return;
  _dawMenuEl.remove(); _dawMenuEl = null;
  document.removeEventListener("mousedown", _dawMenuOutside);
  document.removeEventListener("keydown", _dawMenuEsc);
}
function _dawMenuOutside(e) { if (_dawMenuEl && !_dawMenuEl.contains(e.target)) _dawCloseClipMenu(); }
function _dawMenuEsc(e) { if (e.key === "Escape") _dawCloseClipMenu(); }

function openClipMenu(clip, anchor) {
  _dawCloseClipMenu();
  const m = document.createElement("div");
  _dawMenuEl = m;
  m.style.cssText = "position:fixed;z-index:1000;background:#15171f;border:1px solid #2d3041;border-radius:6px;padding:6px;display:flex;flex-direction:column;gap:4px;min-width:160px;box-shadow:0 4px 16px rgba(0,0,0,0.5)";
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 180) + "px";
  m.style.top = (r.bottom + 4) + "px";

  const mkBtn = (label, fn) => {
    const b = document.createElement("button");
    b.className = "secondary small"; b.textContent = label;
    b.style.cssText = "font-size:11px;text-align:left";
    b.addEventListener("click", async () => { await fn(); _dawCloseClipMenu(); });
    return b;
  };
  m.appendChild(mkBtn("✂ Split at playhead", () => dawSplitClipAtPlayhead(clip.id)));
  m.appendChild(mkBtn("📊 Normalize", () => dawNormalizeClip(clip.id)));

  const gainRow = document.createElement("label");
  gainRow.style.cssText = "font-size:11px;color:#e2e4ed;display:flex;align-items:center;gap:6px";
  gainRow.textContent = "Gain dB";
  const gi = document.createElement("input");
  gi.type = "number"; gi.min = "-24"; gi.max = "12"; gi.step = "0.5";
  const curDb = (typeof gainToDb === "function") ? gainToDb(clip.gain ?? 1) : 0;
  gi.value = (curDb === -Infinity ? -24 : Number(curDb.toFixed(1)));
  gi.style.cssText = "width:58px;font-size:11px";
  gi.addEventListener("change", () => {
    const g = (typeof dbToGain === "function") ? dbToGain(parseFloat(gi.value)) : 1;
    dawSetClipGain(clip.id, g);
  });
  gainRow.appendChild(gi);
  m.appendChild(gainRow);

  m.appendChild(mkBtn("Reset fades", () => { dawSetClipFadeIn(clip.id, 0); dawSetClipFadeOut(clip.id, 0); }));
  m.appendChild(mkBtn("🤖 AI Remix…", () => { if (typeof openRemixDialog === "function") openRemixDialog(clip, anchor); }));
  m.appendChild(mkBtn("🎛 Split to Stems", () => { if (typeof dawSplitToStems === "function") dawSplitToStems(clip); }));

  document.body.appendChild(m);
  setTimeout(() => {
    document.addEventListener("mousedown", _dawMenuOutside);
    document.addEventListener("keydown", _dawMenuEsc);
  }, 0);
}
