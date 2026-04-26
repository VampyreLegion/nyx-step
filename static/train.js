// ── LoRA Training Tab ─────────────────────────────────────────────────────────
(function () {
  let _trainEvents = null;
  let _lossHistory = [];
  let _canvas = null;
  let _ctx = null;

  function _initCanvas() {
    _canvas = document.getElementById("train-loss-canvas");
    if (!_canvas) return;
    _ctx = _canvas.getContext("2d");
    _drawLossChart();
  }

  function _drawLossChart() {
    if (!_ctx) return;
    const w = _canvas.width;
    const h = _canvas.height;
    _ctx.clearRect(0, 0, w, h);

    _ctx.strokeStyle = "var(--border)";
    _ctx.lineWidth = 1;
    _ctx.strokeRect(0, 0, w, h);

    if (_lossHistory.length < 2) {
      _ctx.fillStyle = "var(--muted)";
      _ctx.font = "11px monospace";
      _ctx.textAlign = "center";
      _ctx.fillText("Loss chart appears when training starts", w / 2, h / 2);
      _ctx.textAlign = "left";
      return;
    }

    const min = Math.min(..._lossHistory);
    const max = Math.max(..._lossHistory);
    const range = max - min || 1e-8;
    const pad = 4;

    _ctx.strokeStyle = "var(--accent)";
    _ctx.lineWidth = 2;
    _ctx.beginPath();
    _lossHistory.forEach((v, i) => {
      const x = (i / (_lossHistory.length - 1)) * (w - pad * 2) + pad;
      const y = (h - pad * 2) - ((v - min) / range) * (h - pad * 2) + pad;
      i === 0 ? _ctx.moveTo(x, y) : _ctx.lineTo(x, y);
    });
    _ctx.stroke();

    _ctx.fillStyle = "var(--muted)";
    _ctx.font = "10px monospace";
    _ctx.fillText(max.toFixed(4), pad + 2, pad + 10);
    _ctx.fillText(min.toFixed(4), pad + 2, h - pad - 2);
  }

  const _logColors = { info: "var(--muted)", success: "#4caf50", error: "var(--error, #e53935)" };
  function _log(msg, cls) {
    const el = document.getElementById("train-log");
    if (!el) return;
    const line = document.createElement("div");
    if (cls && _logColors[cls]) line.style.color = _logColors[cls];
    line.textContent = msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  function _setStatus(msg) {
    const el = document.getElementById("train-status");
    if (el) el.textContent = msg;
  }

  function _setProgress(pct) {
    const bar = document.getElementById("train-progress-bar");
    const label = document.getElementById("train-progress-label");
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    if (label) label.textContent = `${Math.round(pct)}%`;
  }

  function _stopEvents() {
    if (_trainEvents) { _trainEvents.close(); _trainEvents = null; }
  }

  function _setBusy(busy) {
    const startBtn = document.getElementById("btn-train-start");
    const stopBtn = document.getElementById("btn-train-stop");
    if (startBtn) startBtn.disabled = busy;
    if (stopBtn) stopBtn.disabled = !busy;
  }

  function _startEvents() {
    _stopEvents();
    _trainEvents = new EventSource("/train/events");

    _trainEvents.addEventListener("connected", () => {
      _log("Connected to ComfyUI training stream.", "info");
    });

    _trainEvents.addEventListener("train_progress", e => {
      const d = JSON.parse(e.data);
      const type = d.type;

      if (type === "status") {
        _setStatus(d.message || "");
        _log(d.message || "", "info");
      } else if (type === "progress") {
        const { epoch, step, loss, lr, loss_history } = d;
        if (Array.isArray(loss_history) && loss_history.length > 0) {
          _lossHistory = loss_history;
        } else if (loss !== undefined) {
          _lossHistory.push(loss);
        }
        _drawLossChart();
        const maxEpochs = parseInt(document.getElementById("train-epochs").value) || 100;
        _setProgress(((epoch || 0) / maxEpochs) * 100);
        _setStatus(`Epoch ${epoch || 0}  ·  Step ${step || 0}  ·  Loss ${(loss || 0).toFixed(5)}  ·  LR ${(lr || 0).toExponential(2)}`);
      } else if (type === "checkpoint") {
        _log(`✓ Checkpoint: epoch ${d.epoch}, loss ${(d.loss || 0).toFixed(5)} → ${d.checkpoint_path || ""}`, "success");
      } else if (type === "complete") {
        _log(`Training complete! LoRA saved: ${d.final_path || ""}`, "success");
        _setStatus("Done");
        _setProgress(100);
        _stopEvents();
        _setBusy(false);
      }
    });

    _trainEvents.addEventListener("train_error", e => {
      const d = JSON.parse(e.data);
      _log(`Error: ${d.message || JSON.stringify(d)}`, "error");
      _setStatus("Error");
      _stopEvents();
      _setBusy(false);
    });

    _trainEvents.addEventListener("train_complete", () => {
      _stopEvents();
      _setBusy(false);
    });

    _trainEvents.onerror = () => {
      _log("Connection lost.", "error");
      _stopEvents();
      _setBusy(false);
    };
  }

  document.getElementById("btn-train-start").addEventListener("click", async () => {
    const datasetDir = document.getElementById("train-dataset-dir").value.trim();
    if (!datasetDir) { _log("Dataset directory is required.", "error"); return; }

    const body = {
      dataset_dir: datasetDir,
      lora_name: document.getElementById("train-lora-name").value.trim() || "my_lora",
      custom_tag: document.getElementById("train-custom-tag").value.trim(),
      tag_position: document.getElementById("train-tag-position").value,
      all_instrumental: document.getElementById("train-all-instrumental").checked,
      tensor_output_dir: document.getElementById("train-tensor-dir").value.trim(),
      lora_output_dir: document.getElementById("train-lora-dir").value.trim(),
      lora_rank: parseInt(document.getElementById("train-rank").value) || 8,
      lora_alpha: parseInt(document.getElementById("train-alpha").value) || 16,
      lora_dropout: parseFloat(document.getElementById("train-dropout").value) || 0.1,
      learning_rate: parseFloat(document.getElementById("train-lr").value) || 1e-4,
      max_epochs: parseInt(document.getElementById("train-epochs").value) || 100,
      batch_size: parseInt(document.getElementById("train-batch").value) || 1,
      gradient_accumulation: parseInt(document.getElementById("train-grad-accum").value) || 4,
      save_every_n_epochs: parseInt(document.getElementById("train-save-every").value) || 10,
      warmup_steps: parseInt(document.getElementById("train-warmup").value) || 100,
      weight_decay: parseFloat(document.getElementById("train-weight-decay").value) || 0.01,
      max_grad_norm: parseFloat(document.getElementById("train-grad-clip").value) || 1.0,
      target_modules: document.getElementById("train-target-modules").value.trim() || "q_proj,k_proj,v_proj,o_proj",
      seed: parseInt(document.getElementById("train-seed").value) || 42,
      use_llm_labeling: document.getElementById("train-llm-label").checked,
      llm_model: document.getElementById("train-llm-model").value,
    };

    _lossHistory = [];
    _drawLossChart();
    document.getElementById("train-log").innerHTML = "";
    _setProgress(0);
    _setStatus("Submitting…");
    _setBusy(true);

    try {
      const r = await fetch("/train/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (data.error) {
        _log(`Error: ${data.error}`, "error");
        _setStatus("Error");
        _setBusy(false);
        return;
      }
      _log(`Job submitted: ${data.prompt_id}`, "info");
      _startEvents();
    } catch (err) {
      _log(`Failed to submit: ${err}`, "error");
      _setStatus("Error");
      _setBusy(false);
    }
  });

  document.getElementById("btn-train-stop").addEventListener("click", async () => {
    _stopEvents();
    _setBusy(false);
    _setStatus("Stopping…");
    await fetch("/train/stop", { method: "POST" }).catch(() => {});
    _log("Stop requested.", "info");
    _setStatus("Stopped");
  });

  _initCanvas();
})();
