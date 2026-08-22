// ── Call and Response ────────────────────────────────────────────────────────
async function generateCallResponse() {
  const callPrompt = document.getElementById('cr-call')?.value || '';
  const respPrompt = document.getElementById('cr-response')?.value || '';
  const interleave = document.getElementById('cr-interleave')?.value || '1:1';
  const statusEl = document.getElementById('cr-status');
  if (!callPrompt && !respPrompt) return alert('Enter at least one prompt');
  if (statusEl) statusEl.textContent = 'Generating call & response...';
  const res = await fetch('/call-response/generate', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ call_prompt: callPrompt, response_prompt: respPrompt, interleave, duration: 30 }),
  });
  const data = await res.json();
  if (statusEl) statusEl.textContent = `Queued ${data.queued.length} parts (${data.interleave} interleave)`;
}
