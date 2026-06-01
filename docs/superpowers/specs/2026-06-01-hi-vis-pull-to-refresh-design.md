# Hi-Vis Mode & Pull-to-Refresh Fix — Design Spec

**Date:** 2026-06-01  
**Project:** Nyx Step (`/home/legion/legionprojects/nyx-step/`)

---

## Problem

The UI is hard to use on tablets and phones:
1. Font sizes (11–13px labels, muted grey text) are too small to read comfortably.
2. Low-contrast muted text (`#8a8f9e` on `#0b0c10`) is difficult to distinguish.
3. Touch targets (chips, tag buttons, small buttons) are too small to tap accurately.
4. Pull-to-refresh fires unintentionally when scrolling up on iOS/Android, interrupting work.

---

## Solution

### 1. Hi-Vis Mode

A persistent toggle that applies a `hi-vis` class to `<body>`, overriding CSS custom properties and element sizing via a scoped CSS block. State is saved to `localStorage` and restored on page load (no flash of unstyled content).

**Toggle button:** Added to `#header`, right side (next to ComfyUI status). Label: `Hi-Vis: OFF` / `Hi-Vis: ON` (text changes on toggle).

**What changes when `body.hi-vis` is active:**

| Element | Normal | Hi-Vis |
|---|---|---|
| Body font size | 14px | 17px |
| `--muted` color | `#8a8f9e` | `#c8d0e0` |
| `--text` color | `#e2e4ed` | `#ffffff` |
| Button padding | `8px 16px` | `12px 22px` |
| Small button (`.small`) padding | `4px 10px` | `8px 14px` |
| Chip padding | `3px 10px` | `7px 14px` |
| Tag button (`.tag-btn`) padding | `3px 8px` | `7px 14px` |
| Input / select / textarea padding | `7px 10px` | `10px 12px` |
| Tab button padding | `10px 16px` | `13px 18px` |

Only CSS variables and padding/font-size are changed — no layout or color-scheme changes.

### 2. Pull-to-Refresh Fix

Applied unconditionally (not tied to hi-vis mode) by adding to the base `body` rule in `style.css`:

```css
overscroll-behavior-y: contain;
```

`contain` (not `none`) preserves scroll bounce within the page but blocks the browser's native pull-to-refresh gesture.

---

## Files Changed

| File | Change |
|---|---|
| `static/style.css` | Add `overscroll-behavior-y: contain` to `body`; add `body.hi-vis { … }` block at end of file |
| `templates/index.html` | Add hi-vis toggle button to `#header` |
| `static/init.js` | On load, read `localStorage.getItem('hivis')` and apply class; wire toggle button click handler |

---

## Constraints

- No new JS files — logic goes in `init.js` (already the init entry point).
- No backend changes required.
- Must not affect the visual design for desktop users who never enable it.
- `style.css` version query string (`?v=12`) must be bumped to `?v=13` in the HTML `<link>` tag to bust cache.
