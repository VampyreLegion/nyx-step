// ── DAW tab glue ──────────────────────────────────────────────────────────────
let _dawInitialized = false;

async function onDawTabOpen() {
  if (!_dawInitialized) { _dawInitialized = true; _dawWireTransport(); }
  const projects = await dawRefreshProjectList();   // single fetch, reused below
  if (dawState.id == null) {
    if (projects.length) await dawLoadProject(projects[0].id);
    else { await dawNewProject("My First Project"); await dawRefreshProjectList(); }
  }
  await dawLoadLibrary();
  renderTimeline();
}

async function dawRefreshProjectList(projects) {
  const sel = document.getElementById("daw-project-select");
  if (!sel) return [];
  if (!projects) projects = await dawListProjects();
  sel.innerHTML = "";
  for (const p of projects) {              // createElement avoids HTML injection via project name
    const opt = document.createElement("option");
    opt.value = p.id; opt.textContent = p.name;
    sel.appendChild(opt);
  }
  if (dawState.id != null) sel.value = dawState.id;
  return projects;
}

function _dawWireTransport() {
  document.getElementById("daw-play").addEventListener("click", () => dawPlay());
  document.getElementById("daw-pause").addEventListener("click", () => dawPause());
  document.getElementById("daw-stop").addEventListener("click", () => dawStop());
  const loopBtn = document.getElementById("daw-loop");
  loopBtn.addEventListener("click", () => {
    const on = loopBtn.style.background === "";
    dawSetLoop(on);
    loopBtn.style.background = on ? "#7c65d9" : "";
    loopBtn.style.color = on ? "#fff" : "";
  });
  document.getElementById("daw-zoom-in").addEventListener("click", () => dawZoom(1.4));
  document.getElementById("daw-zoom-out").addEventListener("click", () => dawZoom(1 / 1.4));
  document.getElementById("daw-mixer-toggle").addEventListener("click", () => {
    const panel = document.getElementById("daw-mixer-panel");
    const show = panel.style.display === "none" || !panel.style.display;
    panel.style.display = show ? "block" : "none";
    if (show) { dawRenderMixer(); dawStartMeters(); }
    else { dawStopMeters(); }
  });
  document.getElementById("daw-export").addEventListener("click", () => dawExportWav());
  document.getElementById("daw-add-track").addEventListener("click", () => dawAddTrack());

  document.getElementById("daw-new").addEventListener("click", async () => {
    const name = prompt("New project name:", "Untitled Project");
    if (name === null) return;
    await dawNewProject(name || "Untitled Project");
    await dawRefreshProjectList();
    renderTimeline();
  });
  document.getElementById("daw-rename").addEventListener("click", async () => {
    const name = prompt("Rename project:", dawState.name);
    if (!name) return;
    dawState.name = name; dawMarkDirty(); await dawRefreshProjectList();
  });
  document.getElementById("daw-delete").addEventListener("click", async () => {
    if (dawState.id == null || !confirm("Delete this project?")) return;
    await dawDeleteProject(dawState.id);
    dawState = { id: null, name: "Untitled Project", tempo: 120, master_volume: 1.0, tracks: [] };
    await onDawTabOpen();
  });
  document.getElementById("daw-project-select").addEventListener("change", async e => {
    await dawLoadProject(parseInt(e.target.value, 10));
    await dawLoadLibrary();
    renderTimeline();
  });
}
