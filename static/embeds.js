// ── Iframe integrations ───────────────────────────────────────────────────────
// A tiny, declarative way to embed separate web apps (ComfyUI, ACE-Step,
// GrooveLab/TB-303, …) into Nyx-Step tabs. The hostname of the embedding page
// is used to pick the right URL: on the public domain we use the matching
// *.nyxstudios.net subdomain, on localhost we use the LAN port directly.
//
// Config lives in the HTML element:
//   <iframe data-embed data-sub="comfy" data-port="8188" data-height="700"></iframe>
// which points at https://comfy.nyxstudios.net  (or http://localhost:8188).

const EMBED_CONFIG = [
  { id: "groovelab-iframe",  sub: "acid",       port: 7870, reloadOnOpen: true },
  { id: "comfyui-iframe",    sub: "comfy",      port: 8188 },
  { id: "acestep-iframe",    sub: "ace-step",   port: 7865 },
];

function embedBaseUrl() {
  const h = window.location.hostname;
  if (h && h !== "localhost" && h !== "127.0.0.1" && h !== "0.0.0.0") {
    return (sub) => `https://${sub}.${h.split(".").slice(-2).join(".")}`;
  }
  return () => null; // caller falls back to port-based LAN URL on localhost
}

function embedUrl(cfg) {
  const base = embedBaseUrl()(cfg.sub);
  if (base) return base;
  return `http://localhost:${cfg.port}`;
}

function initEmbeds() {
  EMBED_CONFIG.forEach(cfg => {
    const el = document.getElementById(cfg.id);
    if (el && !el.dataset.inited) {
      el.dataset.inited = "1";
      el.src = embedUrl(cfg);
    }
  });
}

// Tabs that host embeds re-set the src on each open so lazy-forced reload of
// audio/video contexts and fresh connections work exactly like GrooveLab did.
function refreshEmbedOnOpen(tabName) {
  const cfg = EMBED_CONFIG.find(c => document.getElementById("tab-" + tabName));
  if (!cfg) return;
  const el = document.getElementById(cfg.id);
  if (el && cfg.reloadOnOpen) el.src = el.src;
}

document.addEventListener("DOMContentLoaded", initEmbeds);

// Dock status strip — one-line summary of ComfyUI health pulled from the
// /api/comfy/status telemetry endpoint.
async function updateIntegrationsTelemetry() {
  const el = document.getElementById("integrations-telemetry");
  if (!el) return;
  try {
    const r = await fetch("/api/comfy/status");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    const online = d.comfyui_online ? "● online" : "○ offline";
    const gpu = d.gpu && d.gpu.gpu_util_pct !== undefined
      ? `GPU ${d.gpu.gpu_util_pct}% · ${d.gpu.gpu_temp_c}°C`
      : "GPU n/a";
    const q = d.queue || {};
    const queue = `${q.running_count || 0} running · ${q.pending_count || 0} pending`;
    el.textContent = `ComfyUI ${online} — ${queue} — ${gpu}`;
  } catch (e) {
    el.textContent = "ComfyUI telemetry unavailable: " + e.message;
  }
}