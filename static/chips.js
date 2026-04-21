// ── Instruments tab ───────────────────────────────────────────────────────────
fetch("/api/instruments").then(r => r.json()).then(data => {
  const container = document.getElementById("instrument-chips");
  data.categories.forEach(cat => {
    const title = document.createElement("div");
    title.className = "section-title";
    title.style.marginTop = "10px";
    title.textContent = cat.name;
    container.appendChild(title);
    const row = document.createElement("div");
    cat.subcategories.forEach(sub => {
      sub.items.forEach(item => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = item;
        chip.addEventListener("click", () => {
          chip.classList.toggle("active");
          if (chip.classList.contains("active")) {
            mwState.instruments.push(item);
          } else {
            mwState.instruments = mwState.instruments.filter(i => i !== item);
          }
          document.getElementById("instrument-selected").value =
            mwState.instruments.join(", ");
          updatePayloadPreview();
        });
        row.appendChild(chip);
      });
    });
    container.appendChild(row);
  });
  _restoreStagedChips();
}).catch(() => {
  document.getElementById("instrument-chips").textContent = "Failed to load instruments";
});

// ── Vocals tab ────────────────────────────────────────────────────────────────
fetch("/api/vocals").then(r => r.json()).then(data => {
  const container = document.getElementById("vocal-chips");
  Object.entries(data).forEach(([group, keywords]) => {
    const title = document.createElement("div");
    title.className = "section-title";
    title.style.marginTop = "10px";
    title.textContent = group;
    container.appendChild(title);
    const row = document.createElement("div");
    keywords.forEach(kw => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = kw;
      chip.addEventListener("click", () => {
        chip.classList.toggle("active");
        if (chip.classList.contains("active")) {
          mwState.vocal_tags.push(kw);
        } else {
          mwState.vocal_tags = mwState.vocal_tags.filter(v => v !== kw);
        }
        document.getElementById("vocal-selected").value =
          mwState.vocal_tags.join(", ");
        updatePayloadPreview();
      });
      row.appendChild(chip);
    });
    container.appendChild(row);
  });
  _restoreStagedChips();
}).catch(() => {
  document.getElementById("vocal-chips").textContent = "Failed to load vocals";
});

// ── Chip sync helpers ─────────────────────────────────────────────────────────
function _syncInstrumentChips() {
  document.querySelectorAll("#instrument-chips .chip").forEach(chip => {
    chip.classList.toggle("active", mwState.instruments.includes(chip.textContent.trim()));
  });
}

function _syncVocalChips() {
  document.querySelectorAll("#vocal-chips .chip").forEach(chip => {
    chip.classList.toggle("active", mwState.vocal_tags.includes(chip.textContent.trim()));
  });
}

document.getElementById("instrument-selected").addEventListener("input", e => {
  mwState.instruments = e.target.value.split(",").map(t => t.trim()).filter(Boolean);
  _syncInstrumentChips();
  updatePayloadPreview();
});

document.getElementById("vocal-selected").addEventListener("input", e => {
  mwState.vocal_tags = e.target.value.split(",").map(t => t.trim()).filter(Boolean);
  _syncVocalChips();
  updatePayloadPreview();
});
