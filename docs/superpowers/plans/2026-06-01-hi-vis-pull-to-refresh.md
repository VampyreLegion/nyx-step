# Hi-Vis Mode & Pull-to-Refresh Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent hi-vis toggle to the header that enlarges fonts/touch targets and boosts contrast, and unconditionally block pull-to-refresh on mobile.

**Architecture:** All changes are purely frontend (CSS + HTML + a few lines of JS). A `body.hi-vis` CSS class gates all hi-vis overrides. `localStorage` persists the preference; `init.js` restores it on page load. The pull-to-refresh fix is a single CSS property on `body`.

**Tech Stack:** Vanilla JS, CSS custom properties, localStorage, Jinja2 HTML template.

---

## Files

| File | Change |
|---|---|
| `static/style.css` | Add `overscroll-behavior-y: contain` to `body`; append `body.hi-vis` override block at end |
| `templates/index.html` | Add hi-vis toggle `<button>` in `#header`; bump CSS cache-bust from `?v=12` → `?v=13` |
| `static/init.js` | Restore hi-vis class from localStorage at top; wire button click handler at bottom |

---

## Task 1: Pull-to-Refresh CSS Fix

**Files:**
- Modify: `static/style.css` (body rule, line 6)

- [ ] **Step 1: Edit body rule in style.css**

  Find this line (around line 6):
  ```css
  body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text);
         font-size: 14px; line-height: 1.5; }
  ```
  Replace with:
  ```css
  body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text);
         font-size: 14px; line-height: 1.5; overscroll-behavior-y: contain; }
  ```

- [ ] **Step 2: Verify in browser on mobile (or DevTools)**

  Open the app → switch DevTools to mobile viewport → try pulling down from top of the page. The browser's pull-to-refresh loader should not appear.

- [ ] **Step 3: Commit**

  ```bash
  git add static/style.css
  git commit -m "fix: block pull-to-refresh on mobile (overscroll-behavior-y: contain)"
  ```

---

## Task 2: Hi-Vis CSS Override Block

**Files:**
- Modify: `static/style.css` (append at end of file)

- [ ] **Step 1: Append the hi-vis block to the end of style.css**

  Add this entire block at the very end of `static/style.css`:
  ```css
  /* ── Hi-Vis mode (tablet/mobile accessibility) ──────────────────────────── */
  body.hi-vis {
    font-size: 17px;
    --text: #ffffff;
    --muted: #c8d0e0;
  }
  body.hi-vis button { padding: 12px 22px; }
  body.hi-vis button.small { padding: 8px 14px; font-size: 13px; }
  body.hi-vis .chip { padding: 7px 14px; font-size: 14px; }
  body.hi-vis .tag-btn { padding: 7px 14px; font-size: 13px; }
  body.hi-vis input[type=text],
  body.hi-vis input[type=number],
  body.hi-vis select,
  body.hi-vis textarea { padding: 10px 12px; font-size: 15px; }
  body.hi-vis .tab-btn { padding: 13px 18px; font-size: 15px; }
  body.hi-vis .field-group label { font-size: 14px; }
  ```

- [ ] **Step 2: Bump the CSS cache-bust version in index.html**

  In `templates/index.html` line 7, change:
  ```html
  <link rel="stylesheet" href="/static/style.css?v=12">
  ```
  to:
  ```html
  <link rel="stylesheet" href="/static/style.css?v=13">
  ```

- [ ] **Step 3: Quick visual smoke-test**

  Open DevTools console and run:
  ```javascript
  document.body.classList.add('hi-vis')
  ```
  Fonts should grow, muted labels should brighten, buttons should get larger padding. Run:
  ```javascript
  document.body.classList.remove('hi-vis')
  ```
  to confirm it reverts cleanly.

---

## Task 3: Add Toggle Button to Header

**Files:**
- Modify: `templates/index.html` (inside `#header` div, around line 11–15)

- [ ] **Step 1: Add the button to the header**

  Find the `#header` div (line 11–15 in index.html):
  ```html
  <div id="header">
    <h1>🎛 Nyx's ai Music Studio by Legion</h1>
    <span id="queue-badge">Queue: —</span>
    <span id="comfy-status" style="font-size:12px;color:var(--muted)">ComfyUI: connecting…</span>
  </div>
  ```
  Replace with:
  ```html
  <div id="header">
    <h1>🎛 Nyx's ai Music Studio by Legion</h1>
    <span id="queue-badge">Queue: —</span>
    <span id="comfy-status" style="font-size:12px;color:var(--muted)">ComfyUI: connecting…</span>
    <button id="btn-hivis" class="secondary small" style="margin-left:auto" title="Toggle high-visibility mode for tablet/mobile use">Hi-Vis: OFF</button>
  </div>
  ```

---

## Task 4: Wire LocalStorage + Click Handler in init.js

**Files:**
- Modify: `static/init.js` (top and bottom of file)

- [ ] **Step 1: Add localStorage restore at the top of init.js**

  `init.js` currently starts with:
  ```javascript
  // ── Initialisation ────────────────────────────────────────────────────────────
  syncOverviewFromState();
  ```
  Replace with:
  ```javascript
  // ── Initialisation ────────────────────────────────────────────────────────────
  if (localStorage.getItem('hivis') === '1') {
    document.body.classList.add('hi-vis');
    const b = document.getElementById('btn-hivis');
    if (b) b.textContent = 'Hi-Vis: ON';
  }

  syncOverviewFromState();
  ```

- [ ] **Step 2: Add click handler at the bottom of init.js**

  `init.js` currently ends with:
  ```javascript
  fetch("/queue").then(r => r.json()).then(data => {
    (data.my_jobs || []).forEach(j => addJobCard(j.prompt_id, j.song_name, j.status, j.output_files));
    const doneJob = (data.my_jobs || []).find(j => j.status === "done" && j.output_files && j.output_files.length);
    if (doneJob) mwState.lastAudioFile = doneJob.output_files[0];
    const c = data.comfyui;
    document.getElementById("queue-badge").textContent =
      `Queue: ${c.running} running, ${c.pending} pending`;
  });
  ```
  Append after it:
  ```javascript

  document.getElementById('btn-hivis').addEventListener('click', function() {
    const on = document.body.classList.toggle('hi-vis');
    localStorage.setItem('hivis', on ? '1' : '0');
    this.textContent = on ? 'Hi-Vis: ON' : 'Hi-Vis: OFF';
  });
  ```

- [ ] **Step 3: Verify full flow in browser**

  1. Hard-reload the page (Ctrl+Shift+R / Cmd+Shift+R).
  2. Click **Hi-Vis: OFF** → button label changes to **Hi-Vis: ON**, fonts enlarge, muted text brightens, buttons grow.
  3. Reload the page normally (F5) → hi-vis mode is still active.
  4. Click **Hi-Vis: ON** → reverts, label back to **Hi-Vis: OFF**.
  5. Reload → stays off.

- [ ] **Step 4: Commit**

  ```bash
  git add static/style.css templates/index.html static/init.js
  git commit -m "feat: hi-vis toggle for tablet/mobile — larger fonts, higher contrast, bigger touch targets"
  ```
