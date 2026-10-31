/* ==========================================================================
 * RUNTIME — In-Page Sticky Notes Feedback System (sticky-notes.js)
 * Zero-dependency UI + LocalStorage + Cloud Firestore REST v1 persistence.
 * ========================================================================== */
(function (root) {
  "use strict";

  const LS_KEY = "rt_sticky_notes_v3";
  const SS_TOMBSTONES_KEY = "rt_sticky_notes_tombstones_v3";
  const SS_VISIBLE_KEY = "rt_sticky_visible_v3";
  const SS_UNLOCKED_KEY = "rt_sticky_unlocked_v3";
  const LOGO_SECRET_CLICKS = 5;
  const LOGO_SECRET_WINDOW_MS = 1200;
  const STYLE_ID = "rt-sticky-styles";
  const DOCK_ID = "rt-sticky-dock";
  const LAYER_ID = "rt-sticky-layer";

  const FS_PROJECT = "ee-offsite-simulation";
  const FS_COLLECTION = "runtime_v2_vaults";
  const FS_DOC_ID = "jack_sticky_notes_v3";
  const FS_DOCS_ROOT =
    "https://firestore.googleapis.com/v1/projects/" +
    FS_PROJECT +
    "/databases/(default)/documents";
  const FS_DOC_PATH =
    "projects/" +
    FS_PROJECT +
    "/databases/(default)/documents/" +
    FS_COLLECTION +
    "/" +
    FS_DOC_ID;
  const FS_BATCH_GET_URL = FS_DOCS_ROOT + ":batchGet";
  const FS_PATCH_URL =
    FS_DOCS_ROOT +
    "/" +
    FS_COLLECTION +
    "/" +
    FS_DOC_ID +
    "?updateMask.fieldPaths=notesJson&updateMask.fieldPaths=count&updateMask.fieldPaths=updatedAt";

  const DEBOUNCE_MS = 350;
  const KNOWN_SCREENS = ["landing", "how", "rate", "steps", "gate", "console", "walk", "choose", "setup", "onboard"];
  const TRANSIENT_CLASSES = {
    "is-active": true,
    "is-selected": true,
    "is-shuttered": true,
    "rt-sticky-drop-active": true
  };

  /* ---------------- Safe Storage Helpers ---------------- */
  const memFallback = {};

  function lsGet(key) {
    try {
      if (typeof localStorage !== "undefined" && localStorage) {
        return localStorage.getItem(key);
      }
    } catch (_) {}
    return Object.prototype.hasOwnProperty.call(memFallback, key)
      ? memFallback[key]
      : null;
  }

  function lsSet(key, val) {
    const str = String(val);
    memFallback[key] = str;
    try {
      if (typeof localStorage !== "undefined" && localStorage) {
        localStorage.setItem(key, str);
      }
    } catch (_) {}
  }

  function ssGet(key) {
    try {
      if (typeof sessionStorage !== "undefined" && sessionStorage) {
        return sessionStorage.getItem(key);
      }
    } catch (_) {}
    return null;
  }

  function ssSet(key, val) {
    try {
      if (typeof sessionStorage !== "undefined" && sessionStorage) {
        sessionStorage.setItem(key, String(val));
      }
    } catch (_) {}
  }

  /* ---------------- Utility & Normalization ---------------- */
  function randHex(bytes) {
    const arr = new Uint8Array(bytes);
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < bytes; i++) {
        arr[i] = Math.floor(Math.random() * 256);
      }
    }
    let out = "";
    for (let i = 0; i < arr.length; i++) {
      out += arr[i].toString(16).padStart(2, "0");
    }
    return out;
  }

  function makeNoteId() {
    return "sn_" + Date.now().toString(36) + "_" + randHex(3);
  }

  function numOr(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function scrubSecrets(str) {
    return String(str || "")
      .replace(/sk-or-[A-Za-z0-9_\s-]{4,}/gi, "[REDACTED_KEY]")
      .replace(/sk-[A-Za-z0-9_-]{6,}/g, "[REDACTED_KEY]")
      .replace(/AIza[A-Za-z0-9_-]{12,}/g, "[REDACTED_KEY]")
      .replace(/\bft_[A-Za-z0-9_-]{4,}/g, "[REDACTED_TOKEN]")
      .replace(/([?&]ft=)[^&#\s]+/gi, "$1[REDACTED_TOKEN]");
  }

  function computeClampedLeftStyle(xPct) {
    const pct = round2(clamp(numOr(xPct, 50), 0, 96));
    return "max(6px, min(" + pct + "%, calc(100vw - 242px)))";
  }

  function isVisibleEl(el) {
    if (!el || el.hidden || el.hasAttribute("hidden")) return false;
    if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      const cs = window.getComputedStyle(el);
      if (cs && (cs.display === "none" || cs.visibility === "hidden")) return false;
    }
    return true;
  }

  function detectActiveScreen() {
    if (typeof document === "undefined") return "landing";
    const qrModal = document.getElementById("qr-modal");
    if (isVisibleEl(qrModal)) return "qr-modal";
    for (let i = 0; i < KNOWN_SCREENS.length; i++) {
      const name = KNOWN_SCREENS[i];
      const el = document.getElementById("screen-" + name);
      if (isVisibleEl(el)) {
        if (name === "gate") {
          const wt = document.getElementById("gate-walkthrough-view");
          if (isVisibleEl(wt)) {
            const orBlock = document.getElementById("setup-or-block");
            return isVisibleEl(orBlock) ? "gate/key" : "gate/local";
          }
        }
        return name;
      }
    }
    const fallbackEl = document.querySelector('[id^="screen-"]:not([hidden])');
    if (fallbackEl && fallbackEl.id) {
      const custom = fallbackEl.id.replace(/^screen-/, "").trim();
      if (custom) return custom;
    }
    if (typeof location !== "undefined" && location.hash) {
      const h = String(location.hash).replace(/^#/, "").split("?")[0].trim();
      if (KNOWN_SCREENS.indexOf(h) !== -1) return h;
    }
    return "landing";
  }

  function normalizeScreen(screenVal, fallback) {
    const s = String(screenVal || "").trim().toLowerCase();
    if (s) return s;
    return fallback || detectActiveScreen() || "landing";
  }

  function normalizeNote(raw, fallbackScreen) {
    const src = raw && typeof raw === "object" ? raw : {};
    const id = String(src.id || "").trim() || makeNoteId();
    const screen = normalizeScreen(src.screen, fallbackScreen);
    const xPct = round2(clamp(numOr(src.xPct, 50), 0, 96));
    const yPx = Math.max(4, Math.round(numOr(src.yPx, 120)));
    const selector = scrubSecrets(String(src.selector || "page")).trim() || "page";
    const targetText = scrubSecrets(src.targetText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    const text = scrubSecrets(
      typeof src.text === "string" ? src.text : String(src.text || "")
    );
    const minimized = Boolean(src.minimized);
    const updatedAt = Math.max(1, Math.floor(numOr(src.updatedAt, Date.now())));

    return {
      id: id,
      screen: screen,
      xPct: xPct,
      yPx: yPx,
      selector: selector,
      targetText: targetText,
      text: text,
      minimized: minimized,
      updatedAt: updatedAt
    };
  }

  function cloneNote(n) {
    return {
      id: n.id,
      screen: n.screen,
      xPct: n.xPct,
      yPx: n.yPx,
      selector: n.selector,
      targetText: n.targetText,
      text: n.text,
      minimized: n.minimized,
      updatedAt: n.updatedAt
    };
  }

  /* ---------------- Runtime State ---------------- */
  const tombstones = new Map();
  (function loadTombstones() {
    try {
      const raw = ssGet(SS_TOMBSTONES_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object") {
        Object.keys(obj).forEach(function (k) {
          const ts = Number(obj[k]);
          if (Number.isFinite(ts) && ts > 0) tombstones.set(k, ts);
        });
      }
    } catch (_) {}
  })();

  function recordTombstone(id, ts) {
    if (!id) return;
    tombstones.set(id, ts || Date.now());
    try {
      const out = {};
      tombstones.forEach(function (val, key) {
        out[key] = val;
      });
      ssSet(SS_TOMBSTONES_KEY, JSON.stringify(out));
    } catch (_) {}
  }

  let notes = [];
  let dropMode = false;
  let externalDockHidden = false;
  let secretUnlocked = (function () {
    try {
      if (typeof location !== "undefined" && location.search) {
        const params = new URLSearchParams(location.search);
        if (params.get("clean") === "1" || params.get("notes") === "0") return false;
        if (params.get("notes") === "1") return true;
      }
      return ssGet(SS_UNLOCKED_KEY) === "1";
    } catch (_) {}
    return false;
  })();
  let notesVisible = (function () {
    try {
      if (typeof location !== "undefined" && location.search) {
        const params = new URLSearchParams(location.search);
        if (params.get("clean") === "1" || params.get("notes") === "0") return false;
        if (params.get("notes") === "1") return true;
      }
      const saved = ssGet(SS_VISIBLE_KEY);
      if (saved === "0") return false;
      if (saved === "1") return true;
    } catch (_) {}
    return true;
  })();
  let activeScreen = "landing";
  let draggingNoteId = null;
  let topCardZ = 99980;

  const debounceTimers = new Map();
  const cardDomMap = new Map();

  let styleEl = null;
  let layerEl = null;
  let dockEl = null;
  let addBtnEl = null;
  let toggleBtnEl = null;
  let clearBtnEl = null;
  let lockBtnEl = null;
  let secretToastTimer = null;
  let logoClickCount = 0;
  let lastLogoClickAt = 0;
  let burstStartedOffLanding = false;

  function loadLocalNotes() {
    try {
      const raw = lsGet(LS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const byId = new Map();
      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        if (!item || typeof item !== "object") continue;
        const norm = normalizeNote(item, "landing");
        const prev = byId.get(norm.id);
        if (!prev || norm.updatedAt >= prev.updatedAt) {
          byId.set(norm.id, norm);
        }
      }
      return Array.from(byId.values());
    } catch (_) {
      return [];
    }
  }

  function saveLocalNotes() {
    const clean = notes.map(cloneNote);
    lsSet(LS_KEY, JSON.stringify(clean));
  }

  notes = loadLocalNotes();

  /* ---------------- Cloud Firestore REST v1 Sync ---------------- */
  function parseFsFields(doc) {
    if (!doc || !doc.fields) return null;
    const f = doc.fields;
    const notesJson =
      f.notesJson && typeof f.notesJson.stringValue === "string"
        ? f.notesJson.stringValue
        : "[]";
    const count =
      f.count && f.count.integerValue !== undefined
        ? Number(f.count.integerValue)
        : 0;
    const updatedAt =
      f.updatedAt && f.updatedAt.integerValue !== undefined
        ? Number(f.updatedAt.integerValue)
        : 0;
    let parsedNotes = [];
    try {
      const arr = JSON.parse(notesJson);
      if (Array.isArray(arr)) {
        parsedNotes = arr
          .filter(function (x) {
            return x && typeof x === "object";
          })
          .map(function (x) {
            return normalizeNote(x, "landing");
          });
      }
    } catch (_) {
      parsedNotes = [];
    }
    return {
      notes: parsedNotes,
      notesJson: notesJson,
      count: Number.isFinite(count) ? count : parsedNotes.length,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
    };
  }

  async function fetchRemoteSnapshot() {
    if (typeof fetch !== "function") {
      return { ok: false, found: false, data: null };
    }
    try {
      const res = await fetch(FS_BATCH_GET_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documents: [FS_DOC_PATH]
        })
      });
      if (!res.ok) {
        return { ok: false, found: false, data: null };
      }
      const payload = await res.json();
      const first = Array.isArray(payload) ? payload[0] : payload;
      if (first && first.found) {
        return { ok: true, found: true, data: parseFsFields(first.found) };
      }
      if (first && first.missing) {
        return { ok: true, found: false, data: null };
      }
      return { ok: true, found: false, data: null };
    } catch (_) {
      return { ok: false, found: false, data: null };
    }
  }

  let writeInFlight = false;
  let writeQueued = false;
  let activeWritePromise = null;

  async function sendPatchRequest(snapshotNotes) {
    if (typeof fetch !== "function") return false;
    const clean = snapshotNotes.map(cloneNote);
    const notesJson = JSON.stringify(clean);
    const count = clean.length;
    const updatedAt = Date.now();

    const body = {
      fields: {
        notesJson: { stringValue: notesJson },
        count: { integerValue: String(count) },
        updatedAt: { integerValue: String(updatedAt) }
      }
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(FS_PATCH_URL, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (res && res.ok) return true;
      } catch (_) {}
      if (attempt === 0) {
        await new Promise(function (r) { setTimeout(r, 600); });
      }
    }
    return false;
  }

  function pushNotesToCloud() {
    if (typeof fetch !== "function") return Promise.resolve(false);
    if (writeInFlight) {
      writeQueued = true;
      return activeWritePromise || Promise.resolve(false);
    }
    writeInFlight = true;
    activeWritePromise = (async function () {
      let ok = false;
      do {
        writeQueued = false;
        ok = await sendPatchRequest(notes);
      } while (writeQueued);
      writeInFlight = false;
      return ok;
    })();
    return activeWritePromise;
  }

  function flushPendingDebounces() {
    if (debounceTimers.size === 0) return false;
    debounceTimers.forEach(function (timerId) {
      clearTimeout(timerId);
    });
    debounceTimers.clear();
    saveLocalNotes();
    return true;
  }

  function mergeLocalAndRemote(localArr, remoteArr) {
    const mergedMap = new Map();
    const order = [];

    function put(note) {
      if (!mergedMap.has(note.id)) {
        order.push(note.id);
      }
      mergedMap.set(note.id, cloneNote(note));
    }

    for (let i = 0; i < remoteArr.length; i++) {
      const r = normalizeNote(remoteArr[i], "landing");
      const delTs = tombstones.get(r.id) || 0;
      if (delTs && delTs >= r.updatedAt) {
        continue;
      }
      put(r);
    }

    for (let j = 0; j < localArr.length; j++) {
      const l = normalizeNote(localArr[j], "landing");
      const delTs = tombstones.get(l.id) || 0;
      if (delTs && delTs > l.updatedAt) {
        continue;
      }
      const existing = mergedMap.get(l.id);
      if (!existing || l.updatedAt >= existing.updatedAt) {
        put(l);
      }
    }

    return order.map(function (id) {
      return mergedMap.get(id);
    });
  }

  async function syncNow() {
    const hadPending = flushPendingDebounces();
    const snap = await fetchRemoteSnapshot();
    if (!snap.ok) {
      if (hadPending) await pushNotesToCloud();
      return getNotes();
    }

    const remoteNotes = snap.found && snap.data ? snap.data.notes : [];
    const merged = mergeLocalAndRemote(notes, remoteNotes);
    const mergedJson = JSON.stringify(merged);
    const remoteJson = snap.found && snap.data ? JSON.stringify(remoteNotes) : null;

    notes = merged;
    saveLocalNotes();
    renderAll();

    if (hadPending || (mergedJson !== remoteJson && (merged.length > 0 || snap.found))) {
      await pushNotesToCloud();
    }

    return getNotes();
  }

  /* ---------------- Target Element Inspection ---------------- */
  function getMeaningfulClass(el) {
    if (!el || typeof el.getAttribute !== "function") return "";
    const raw = String(el.getAttribute("class") || "").trim();
    if (!raw) return "";
    const parts = raw.split(/\s+/);
    for (let i = 0; i < parts.length; i++) {
      const c = parts[i];
      if (c && !TRANSIENT_CLASSES[c] && c.indexOf("rt-sticky") !== 0) {
        return c;
      }
    }
    return "";
  }

  function describeTarget(rawEl) {
    if (!rawEl || rawEl.nodeType !== 1) {
      return { selector: "page", targetText: "" };
    }
    let el = rawEl;
    if (typeof el.closest === "function") {
      const svgRoot = el.closest("svg");
      if (svgRoot && el !== svgRoot) {
        el = svgRoot;
      }
      const interactive = el.closest("button, a, input, textarea, select, summary");
      if (
        interactive &&
        !interactive.closest("#" + DOCK_ID) &&
        !interactive.closest(".rt-sticky-card")
      ) {
        el = interactive;
      }
    }

    let probe = el;
    for (let hop = 0; hop < 3 && probe && probe.nodeType === 1; hop++) {
      const pTag = String(probe.tagName || "").toLowerCase();
      if (pTag === "body" || pTag === "html" || pTag === "main") break;
      const pId = (probe.getAttribute("id") || "").trim();
      const pCls = getMeaningfulClass(probe);
      if (pId || pCls) {
        el = probe;
        break;
      }
      probe = probe.parentElement;
    }

    const tag = String(el.tagName || "div").toLowerCase();
    const id = (el.getAttribute("id") || "").trim();
    const cls = getMeaningfulClass(el);

    let selector = tag;
    if (id) {
      selector = id.indexOf("screen-") === 0 ? "#" + id : tag + "#" + id;
    } else if (cls) {
      selector = "." + cls;
    }

    let rawText = "";
    const inputType = String(el.getAttribute("type") || "").toLowerCase();
    const hasSensitiveChild =
      typeof el.querySelector === "function" &&
      Boolean(el.querySelector("#setup-minted-val, #or-prov-key-input, #setup-ide-cmd"));
    const isSensitiveBox =
      inputType === "password" ||
      id === "or-prov-key-input" ||
      id === "setup-minted-val" ||
      id === "setup-minted-box" ||
      id === "setup-ide-cmd" ||
      hasSensitiveChild ||
      (typeof el.closest === "function" &&
        Boolean(el.closest("#setup-minted-box, #setup-ide-cmd")));
    if (isSensitiveBox) {
      rawText =
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        "[Protected API Key Field]";
    } else if (tag === "input" || tag === "textarea") {
      rawText =
        el.getAttribute("placeholder") ||
        el.getAttribute("aria-label") ||
        el.value ||
        "";
    } else {
      rawText = el.getAttribute("aria-label") || el.textContent || "";
    }
    const targetText = scrubSecrets(rawText)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);

    return { selector: selector, targetText: targetText };
  }

  function formatTargetLabel(note) {
    const sel = String((note && note.selector) || "page").trim() || "page";
    return sel.indexOf("@") === 0 ? sel : "@ " + sel;
  }

  /* ---------------- Scoped Styles Injection ---------------- */
  function injectStyles() {
    if (typeof document === "undefined" || !document.head) return;
    styleEl = document.getElementById(STYLE_ID);
    if (styleEl) return;

    styleEl = document.createElement("style");
    styleEl.id = STYLE_ID;
    styleEl.textContent = [
      "html.rt-sticky-drop-active, html.rt-sticky-drop-active body, html.rt-sticky-drop-active body * {",
      "  cursor: crosshair !important;",
      "}",
      "#" + LAYER_ID + "[hidden], #" + DOCK_ID + "[hidden] { display: none !important; }",
      "#" + LAYER_ID + " {",
      "  position: static;",
      "  height: 0;",
      "  overflow: visible;",
      "  pointer-events: none;",
      "}",
      "#" + DOCK_ID + " {",
      "  position: fixed;",
      "  bottom: 16px;",
      "  right: 16px;",
      "  z-index: 99990;",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: flex-end;",
      "  flex-wrap: wrap;",
      "  gap: 8px;",
      "  max-width: calc(100vw - 32px);",
      "  font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;",
      "  font-size: 12px;",
      "  line-height: 1.2;",
      "  pointer-events: auto;",
      "}",
      ".rt-sticky-dock-btn {",
      "  appearance: none;",
      "  -webkit-appearance: none;",
      "  border-radius: 0;",
      "  border: 2px solid #000000;",
      "  box-shadow: 4px 4px 0 #000000;",
      "  padding: 8px 11px;",
      "  font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;",
      "  font-size: 12px;",
      "  font-weight: 700;",
      "  letter-spacing: 0.04em;",
      "  line-height: 1.2;",
      "  cursor: pointer;",
      "  user-select: none;",
      "  white-space: nowrap;",
      "  transition: transform 60ms linear, background-color 80ms linear, color 80ms linear;",
      "}",
      ".rt-sticky-dock-btn:active {",
      "  transform: translate(2px, 2px);",
      "  box-shadow: 2px 2px 0 #000000;",
      "}",
      ".rt-sticky-dock-btn:focus-visible {",
      "  outline: 2px dashed #ff0400;",
      "  outline-offset: 2px;",
      "}",
      ".rt-sticky-dock-add {",
      "  background: #000000;",
      "  color: #ff0400;",
      "  outline: 1px solid rgba(255, 4, 0, 0.85);",
      "}",
      ".rt-sticky-dock-add:hover {",
      "  background: #050505;",
      "  outline-color: #ff0400;",
      "}",
      ".rt-sticky-dock-add.is-drop-active {",
      "  background: #ff0400 !important;",
      "  color: #000000 !important;",
      "  border-color: #000000 !important;",
      "  outline: none !important;",
      "}",
      ".rt-sticky-dock-pill {",
      "  background: #ff0400;",
      "  color: #000000;",
      "}",
      ".rt-sticky-dock-pill:hover {",
      "  background: #ff0400;",
      "}",
      ".rt-sticky-dock-pill.is-notes-hidden {",
      "  background: #050505;",
      "  color: #ff0400;",
      "  outline: 1px solid rgba(255, 4, 0, 0.85);",
      "}",
      ".rt-sticky-dock-clear {",
      "  background: #000000;",
      "  color: #ff0400;",
      "  outline: 1px solid rgba(255, 4, 0, 0.85);",
      "}",
      ".rt-sticky-dock-clear:hover {",
      "  background: #ff0400;",
      "  color: #000000;",
      "  outline: none;",
      "}",
      ".rt-sticky-card {",
      "  position: absolute;",
      "  z-index: 99980;",
      "  width: 230px;",
      "  max-width: calc(100vw - 24px);",
      "  background: #ff0400;",
      "  color: #000000;",
      "  border: 2px solid #000000;",
      "  box-shadow: 4px 4px 0 #000000;",
      "  font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;",
      "  font-size: 12px;",
      "  line-height: 1.4;",
      "  box-sizing: border-box;",
      "  pointer-events: auto;",
      "}",
      ".rt-sticky-card[hidden] {",
      "  display: none !important;",
      "}",
      ".rt-sticky-card ::selection {",
      "  background: #000000;",
      "  color: #ff0400;",
      "}",
      ".rt-sticky-card.is-dragging {",
      "  box-shadow: 6px 6px 0 #000000;",
      "}",
      ".rt-sticky-header {",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: space-between;",
      "  gap: 4px;",
      "  padding: 5px 6px;",
      "  background: #ff0400;",
      "  color: #000000;",
      "  border-bottom: 2px solid #000000;",
      "  cursor: grab;",
      "  user-select: none;",
      "  -webkit-user-select: none;",
      "  touch-action: none;",
      "}",
      ".rt-sticky-card.is-dragging .rt-sticky-header {",
      "  cursor: grabbing;",
      "}",
      ".rt-sticky-card.is-minimized .rt-sticky-header {",
      "  border-bottom: 0;",
      "}",
      ".rt-sticky-title {",
      "  flex: 1 1 auto;",
      "  min-width: 0;",
      "  overflow: hidden;",
      "  text-overflow: ellipsis;",
      "  white-space: nowrap;",
      "  font-size: 11px;",
      "  font-weight: 700;",
      "  letter-spacing: 0.01em;",
      "  color: #000000;",
      "}",
      ".rt-sticky-actions {",
      "  flex: 0 0 auto;",
      "  display: inline-flex;",
      "  align-items: center;",
      "  gap: 2px;",
      "}",
      ".rt-sticky-hdr-btn {",
      "  appearance: none;",
      "  -webkit-appearance: none;",
      "  background: transparent;",
      "  color: #000000;",
      "  border: 1px solid transparent;",
      "  border-radius: 0;",
      "  padding: 1px 3px;",
      "  font-family: inherit;",
      "  font-size: 11px;",
      "  font-weight: 700;",
      "  line-height: 1.15;",
      "  cursor: pointer;",
      "}",
      ".rt-sticky-hdr-btn:hover, .rt-sticky-hdr-btn:focus-visible {",
      "  background: #000000;",
      "  color: #ff0400;",
      "  outline: none;",
      "}",
      ".rt-sticky-body {",
      "  background: #ff0400;",
      "}",
      ".rt-sticky-body[hidden] {",
      "  display: none !important;",
      "}",
      ".rt-sticky-textarea {",
      "  display: block;",
      "  width: 100%;",
      "  min-height: 78px;",
      "  max-height: 240px;",
      "  margin: 0;",
      "  padding: 8px;",
      "  border: 0;",
      "  border-radius: 0;",
      "  outline: none;",
      "  background: #ff0400;",
      "  color: #000000;",
      "  font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;",
      "  font-size: 12px;",
      "  line-height: 1.45;",
      "  resize: vertical;",
      "  box-sizing: border-box;",
      "}",
      ".rt-sticky-textarea::placeholder {",
      "  color: rgba(0, 0, 0, 0.52);",
      "}",
      ".rt-sticky-textarea:focus, .rt-sticky-textarea:focus-visible {",
      "  outline: 2px dashed #000000;",
      "  outline-offset: -3px;",
      "  background: #ff0400;",
      "}",
      "@media (max-width: 520px) {",
      "  #" + DOCK_ID + " {",
      "    bottom: calc(12px + env(safe-area-inset-bottom, 0px));",
      "    right: calc(12px + env(safe-area-inset-right, 0px));",
      "    gap: 6px;",
      "  }",
      "  .rt-sticky-dock-btn {",
      "    padding: 6px 8px;",
      "    font-size: 11px;",
      "  }",
      "}"
    ].join("\n");

    document.head.appendChild(styleEl);
  }

  /* ---------------- UI Rendering & Interactions ---------------- */
  function setDropMode(next) {
    dropMode = Boolean(next);
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.classList.toggle("rt-sticky-drop-active", dropMode);
    }
    renderDock();
  }

  function bumpCardZ(cardEl) {
    if (!cardEl) return;
    topCardZ += 1;
    if (topCardZ >= 99988) {
      topCardZ = 99981;
      cardDomMap.forEach(function (entry) {
        entry.cardEl.style.zIndex = "99980";
      });
    }
    cardEl.style.zIndex = String(topCardZ);
  }

  function scheduleNoteAutoSave(noteId) {
    const prev = debounceTimers.get(noteId);
    if (prev) clearTimeout(prev);
    const tid = setTimeout(function () {
      debounceTimers.delete(noteId);
      saveLocalNotes();
      pushNotesToCloud();
    }, DEBOUNCE_MS);
    debounceTimers.set(noteId, tid);
  }

  function deleteNoteById(noteId) {
    const pending = debounceTimers.get(noteId);
    if (pending) {
      clearTimeout(pending);
      debounceTimers.delete(noteId);
    }
    const idx = notes.findIndex(function (n) {
      return n.id === noteId;
    });
    if (idx === -1) return;
    notes.splice(idx, 1);
    recordTombstone(noteId, Date.now());
    saveLocalNotes();
    renderAll();
    pushNotesToCloud();
  }

  function toggleMinimizeById(noteId) {
    const note = notes.find(function (n) {
      return n.id === noteId;
    });
    if (!note) return;
    note.minimized = !note.minimized;
    note.updatedAt = Date.now();
    saveLocalNotes();
    renderNotes();
    pushNotesToCloud();
  }

  function clearAllNotesWithConfirm() {
    if (!notes.length) return;
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      const ok = window.confirm(
        "Clear all " + notes.length + " sticky note" + (notes.length === 1 ? "" : "s") + "?"
      );
      if (!ok) return;
    }
    debounceTimers.forEach(function (t) {
      clearTimeout(t);
    });
    debounceTimers.clear();
    const now = Date.now();
    for (let i = 0; i < notes.length; i++) {
      recordTombstone(notes[i].id, now);
    }
    notes = [];
    saveLocalNotes();
    renderAll();
    pushNotesToCloud();
  }

  function attachHeaderDrag(headerEl, cardEl, noteId) {
    headerEl.addEventListener("pointerdown", function (e) {
      if (e.target && typeof e.target.closest === "function" && e.target.closest("button")) {
        return;
      }
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const note = notes.find(function (n) {
        return n.id === noteId;
      });
      if (!note) return;

      e.preventDefault();
      bumpCardZ(cardEl);

      const startClientX = e.clientX;
      const startClientY = e.clientY;
      const rect = cardEl.getBoundingClientRect();
      const scrollX = (typeof window !== "undefined" && (window.scrollX || window.pageXOffset)) || 0;
      const scrollY = (typeof window !== "undefined" && (window.scrollY || window.pageYOffset)) || 0;
      const startLeftPx = rect.left + scrollX;
      const startTopPx = rect.top + scrollY;
      const cardWidth = rect.width || 230;
      let moved = false;

      draggingNoteId = noteId;
      cardEl.classList.add("is-dragging");

      try {
        if (typeof headerEl.setPointerCapture === "function") {
          headerEl.setPointerCapture(e.pointerId);
        }
      } catch (_) {}

      function onMove(ev) {
        const dx = ev.clientX - startClientX;
        const dy = ev.clientY - startClientY;
        if (!moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
        moved = true;

        const docWidth = Math.max(
          (document.documentElement && document.documentElement.clientWidth) || 0,
          (typeof window !== "undefined" && window.innerWidth) || 1
        );
        const maxLeftPx = Math.max(4, docWidth - cardWidth - 4);
        const nextLeftPx = clamp(startLeftPx + dx, 4, maxLeftPx);
        const nextTopPx = Math.max(4, Math.round(startTopPx + dy));
        const nextXPct = round2(clamp((nextLeftPx / docWidth) * 100, 0, 96));

        note.xPct = nextXPct;
        note.yPx = nextTopPx;
        cardEl.style.left = computeClampedLeftStyle(nextXPct);
        cardEl.style.top = nextTopPx + "px";
      }

      function onEnd() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onEnd);
        try {
          if (typeof headerEl.releasePointerCapture === "function") {
            headerEl.releasePointerCapture(e.pointerId);
          }
        } catch (_) {}
        draggingNoteId = null;
        cardEl.classList.remove("is-dragging");

        if (moved) {
          note.updatedAt = Date.now();
          saveLocalNotes();
          pushNotesToCloud();
        }
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
    });
  }

  function createCardDom(note) {
    const cardEl = document.createElement("article");
    cardEl.className = "rt-sticky-card";
    cardEl.setAttribute("data-note-id", note.id);
    cardEl.setAttribute("data-screen", note.screen);
    cardEl.style.zIndex = "99980";

    const headerEl = document.createElement("div");
    headerEl.className = "rt-sticky-header";

    const titleEl = document.createElement("span");
    titleEl.className = "rt-sticky-title";

    const actionsEl = document.createElement("div");
    actionsEl.className = "rt-sticky-actions";

    const minBtn = document.createElement("button");
    minBtn.type = "button";
    minBtn.className = "rt-sticky-hdr-btn rt-sticky-min-btn";
    minBtn.setAttribute("aria-label", "Minimize sticky note");
    minBtn.textContent = "[_]";

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "rt-sticky-hdr-btn rt-sticky-del-btn";
    delBtn.setAttribute("aria-label", "Delete sticky note");
    delBtn.textContent = "[X]";

    actionsEl.appendChild(minBtn);
    actionsEl.appendChild(delBtn);
    headerEl.appendChild(titleEl);
    headerEl.appendChild(actionsEl);

    const bodyEl = document.createElement("div");
    bodyEl.className = "rt-sticky-body";

    const textareaEl = document.createElement("textarea");
    textareaEl.className = "rt-sticky-textarea";
    textareaEl.placeholder = "Write feedback here...";
    textareaEl.rows = 4;
    textareaEl.value = note.text;

    bodyEl.appendChild(textareaEl);
    cardEl.appendChild(headerEl);
    cardEl.appendChild(bodyEl);

    cardEl.addEventListener("pointerdown", function () {
      bumpCardZ(cardEl);
    });

    minBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleMinimizeById(note.id);
    });

    delBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      deleteNoteById(note.id);
    });

    textareaEl.addEventListener("input", function () {
      const target = notes.find(function (n) {
        return n.id === note.id;
      });
      if (!target) return;
      target.text = scrubSecrets(textareaEl.value);
      target.updatedAt = Date.now();
      saveLocalNotes();
      scheduleNoteAutoSave(note.id);
    });

    textareaEl.addEventListener("blur", function () {
      const pending = debounceTimers.get(note.id);
      if (pending) {
        clearTimeout(pending);
        debounceTimers.delete(note.id);
        saveLocalNotes();
        pushNotesToCloud();
      }
    });

    attachHeaderDrag(headerEl, cardEl, note.id);

    return {
      cardEl: cardEl,
      headerEl: headerEl,
      titleEl: titleEl,
      minBtn: minBtn,
      bodyEl: bodyEl,
      textareaEl: textareaEl
    };
  }

  function renderDock() {
    if (!dockEl || !addBtnEl || !toggleBtnEl || !clearBtnEl) return;

    addBtnEl.classList.toggle("is-drop-active", dropMode);
    addBtnEl.setAttribute("aria-pressed", dropMode ? "true" : "false");
    addBtnEl.textContent = dropMode
      ? "[ CLICK ANYWHERE TO PIN... ]"
      : "[ + STICKY NOTE ]";
    addBtnEl.title = dropMode
      ? "Click any element on the page to pin feedback (Esc to cancel)"
      : "Pin a sticky note on the page (Alt+N)";

    let allowAdminClear = false;
    try {
      allowAdminClear =
        typeof location !== "undefined" &&
        new URLSearchParams(location.search || "").get("notes_admin") === "1";
    } catch (_) {}
    const count = notes.length;
    if (count > 0) {
      toggleBtnEl.hidden = false;
      clearBtnEl.hidden = !(allowAdminClear && notesVisible);
      toggleBtnEl.classList.toggle("is-notes-hidden", !notesVisible);
      toggleBtnEl.setAttribute("aria-pressed", notesVisible ? "true" : "false");
      toggleBtnEl.textContent = notesVisible
        ? "[ NOTES: " + count + " ]"
        : "[ NOTES: " + count + " (OFF) ]";
      toggleBtnEl.title = notesVisible
        ? "Click to hide sticky notes on screen"
        : "Click to show sticky notes on screen";
    } else {
      toggleBtnEl.hidden = true;
      clearBtnEl.hidden = true;
    }
  }

  function renderNotes() {
    if (!layerEl) return;
    activeScreen = detectActiveScreen();

    const validIds = new Set();
    for (let i = 0; i < notes.length; i++) {
      validIds.add(notes[i].id);
    }

    cardDomMap.forEach(function (entry, id) {
      if (!validIds.has(id)) {
        if (entry.cardEl.parentNode) {
          entry.cardEl.parentNode.removeChild(entry.cardEl);
        }
        cardDomMap.delete(id);
      }
    });

    for (let idx = 0; idx < notes.length; idx++) {
      const note = notes[idx];
      let entry = cardDomMap.get(note.id);
      if (!entry) {
        entry = createCardDom(note);
        cardDomMap.set(note.id, entry);
        layerEl.appendChild(entry.cardEl);
      }

      const isVisibleOnScreen =
        notesVisible && normalizeScreen(note.screen, "landing") === activeScreen;
      entry.cardEl.hidden = !isVisibleOnScreen;
      entry.cardEl.setAttribute("data-screen", note.screen);

      if (draggingNoteId !== note.id) {
        entry.cardEl.style.left = computeClampedLeftStyle(note.xPct);
        entry.cardEl.style.top = note.yPx + "px";
      }

      const targetLabel = formatTargetLabel(note);
      const headerLabel = "#" + (idx + 1) + " \u00b7 " + targetLabel;
      if (entry.titleEl.textContent !== headerLabel) {
        entry.titleEl.textContent = headerLabel;
      }

      const tooltipParts = [headerLabel];
      if (note.targetText) {
        tooltipParts.push('"' + note.targetText + '"');
      }
      tooltipParts.push("(Drag to reposition)");
      entry.headerEl.title = tooltipParts.join(" — ");

      const isMin = Boolean(note.minimized);
      entry.cardEl.classList.toggle("is-minimized", isMin);
      entry.bodyEl.hidden = isMin;
      entry.minBtn.textContent = isMin ? "[+]" : "[_]";
      entry.minBtn.setAttribute("aria-expanded", isMin ? "false" : "true");

      if (
        typeof document !== "undefined" &&
        document.activeElement !== entry.textareaEl &&
        entry.textareaEl.value !== note.text
      ) {
        entry.textareaEl.value = note.text;
      }
    }
  }

  function isCleanUrlForced() {
    try {
      return (
        typeof location !== "undefined" &&
        new URLSearchParams(location.search || "").get("clean") === "1"
      );
    } catch (_) {
      return false;
    }
  }

  function showSecretToast(msg) {
    if (typeof document === "undefined") return;
    const toastEl = document.getElementById("toast");
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("is-visible");
    if (secretToastTimer) clearTimeout(secretToastTimer);
    secretToastTimer = setTimeout(function () {
      toastEl.classList.remove("is-visible");
    }, 2200);
  }

  function setSecretUnlocked(nextVal, announce) {
    if (isCleanUrlForced() && nextVal) return;
    secretUnlocked = Boolean(nextVal);
    ssSet(SS_UNLOCKED_KEY, secretUnlocked ? "1" : "0");
    if (secretUnlocked) {
      notesVisible = true;
      ssSet(SS_VISIBLE_KEY, "1");
      renderAll();
      syncNow();
      if (announce) showSecretToast("STICKY NOTES UNLOCKED");
    } else {
      if (dropMode) setDropMode(false);
      renderAll();
      if (announce) showSecretToast("STICKY NOTES HIDDEN");
    }
  }

  function renderAll() {
    const cleanForced = isCleanUrlForced();
    if (!secretUnlocked || cleanForced) {
      if (dropMode) {
        dropMode = false;
        if (typeof document !== "undefined" && document.documentElement) {
          document.documentElement.classList.remove("rt-sticky-drop-active");
        }
      }
      if (dockEl) dockEl.hidden = true;
      if (layerEl) layerEl.hidden = true;
      return;
    }
    if (dockEl) dockEl.hidden = Boolean(externalDockHidden);
    if (layerEl) layerEl.hidden = false;
    renderDock();
    renderNotes();
  }

  function checkScreenChange() {
    const detected = detectActiveScreen();
    if (detected !== activeScreen) {
      activeScreen = detected;
      renderNotes();
    }
  }

  /* ---------------- Global Drop Mode & Screen Listeners ---------------- */
  let eventsBound = false;
  let suppressClickUntil = 0;
  let pendingFocusTextarea = null;

  function focusNoteTextarea(ta) {
    if (!ta) return;
    try {
      ta.focus({ preventScroll: true });
    } catch (_) {
      try { ta.focus(); } catch (__) {}
    }
  }

  function handleDropAtEvent(e) {
    const target = e.target;
    if (target && typeof target.closest === "function") {
      if (target.closest("#" + DOCK_ID) || target.closest("#preloader")) {
        return false;
      }
      const existingCard = target.closest(".rt-sticky-card");
      if (existingCard) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        setDropMode(false);
        suppressClickUntil = Date.now() + 550;
        const existingTa = existingCard.querySelector(".rt-sticky-textarea");
        if (existingTa) {
          pendingFocusTextarea = existingTa;
          focusNoteTextarea(existingTa);
        }
        return true;
      }
    }

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    suppressClickUntil = Date.now() + 650;

    const docWidth = Math.max(
      (document.documentElement && document.documentElement.clientWidth) || 0,
      window.innerWidth || 1
    );
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const hasClientCoords = typeof e.clientX === "number" && typeof e.clientY === "number";
    const clientX = hasClientCoords ? e.clientX : Math.round(docWidth * 0.5);
    const clientY = hasClientCoords ? e.clientY : 180;
    const pageX = typeof e.pageX === "number" ? e.pageX : clientX + scrollX;
    const pageY = typeof e.pageY === "number" ? e.pageY : clientY + scrollY;

    let hitEl = target;
    if (
      (!hitEl || hitEl.nodeType !== 1 || !document.contains(hitEl)) &&
      typeof document.elementFromPoint === "function"
    ) {
      hitEl = document.elementFromPoint(clientX, clientY) || document.body;
    }

    const maxLeftPx = Math.max(8, docWidth - 242);
    const clampedLeftPx = clamp(pageX, 8, maxLeftPx);
    const xPct = round2(clamp((clampedLeftPx / docWidth) * 100, 0, 96));
    const yPx = Math.max(8, Math.round(pageY));

    const info = describeTarget(hitEl);
    setDropMode(false);
    notesVisible = true;
    ssSet(SS_VISIBLE_KEY, "1");

    const created = addNote({
      screen: detectActiveScreen(),
      xPct: xPct,
      yPx: yPx,
      selector: info.selector,
      targetText: info.targetText,
      text: "",
      minimized: false
    });

    const entry = cardDomMap.get(created.id);
    if (entry && entry.textareaEl) {
      bumpCardZ(entry.cardEl);
      pendingFocusTextarea = entry.textareaEl;
      focusNoteTextarea(entry.textareaEl);
      setTimeout(function () { focusNoteTextarea(entry.textareaEl); }, 0);
      setTimeout(function () { focusNoteTextarea(entry.textareaEl); }, 60);
    }
    return true;
  }

  function bindGlobalEvents() {
    if (eventsBound) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;
    eventsBound = true;

    window.addEventListener(
      "pointerdown",
      function (e) {
        if (!dropMode) return;
        if (e.pointerType === "mouse" && typeof e.button === "number" && e.button !== 0) {
          return;
        }
        handleDropAtEvent(e);
      },
      true
    );

    window.addEventListener(
      "pointerup",
      function (e) {
        if (Date.now() < suppressClickUntil) {
          const t = e.target;
          if (!(t && typeof t.closest === "function" && t.closest("#" + DOCK_ID))) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            if (pendingFocusTextarea) {
              const ta = pendingFocusTextarea;
              pendingFocusTextarea = null;
              focusNoteTextarea(ta);
            }
          }
        }
      },
      true
    );

    document.addEventListener(
      "click",
      function (e) {
        if (Date.now() < suppressClickUntil) {
          suppressClickUntil = 0;
          const t = e.target;
          if (!(t && typeof t.closest === "function" && t.closest("#" + DOCK_ID))) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            if (pendingFocusTextarea) {
              const ta = pendingFocusTextarea;
              pendingFocusTextarea = null;
              focusNoteTextarea(ta);
            }
            return;
          }
        }
        if (!dropMode) {
          const clickTgt = e.target;
          const logoEl =
            clickTgt &&
            typeof clickTgt.closest === "function" &&
            (clickTgt.closest("#nav-home-btn") || clickTgt.closest(".hero-logo-wrap"));
          if (logoEl) {
            const now = Date.now();
            if (now - lastLogoClickAt > LOGO_SECRET_WINDOW_MS) {
              logoClickCount = 1;
              burstStartedOffLanding =
                Boolean(clickTgt.closest("#nav-home-btn")) &&
                detectActiveScreen() !== "landing";
            } else {
              logoClickCount += 1;
            }
            lastLogoClickAt = now;
            if (logoClickCount >= LOGO_SECRET_CLICKS) {
              logoClickCount = 0;
              lastLogoClickAt = 0;
              const shouldGoBack = burstStartedOffLanding;
              burstStartedOffLanding = false;
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();
              setSecretUnlocked(!secretUnlocked, true);
              if (
                shouldGoBack &&
                typeof history !== "undefined" &&
                typeof history.back === "function"
              ) {
                history.back();
              }
              return;
            }
          } else {
            logoClickCount = 0;
            burstStartedOffLanding = false;
          }
          setTimeout(checkScreenChange, 0);
          return;
        }
        handleDropAtEvent(e);
      },
      true
    );

    window.addEventListener(
      "keydown",
      function (e) {
        const isAltN =
          e.altKey &&
          !e.ctrlKey &&
          !e.metaKey &&
          (e.code === "KeyN" || String(e.key || "").toLowerCase() === "n");
        if (isAltN && secretUnlocked) {
          const tgt = e.target;
          const inEditable =
            tgt &&
            tgt.nodeType === 1 &&
            (tgt.isContentEditable ||
              /^(INPUT|TEXTAREA|SELECT)$/i.test(tgt.tagName || ""));
          if (inEditable) return;
          e.preventDefault();
          setDropMode(!dropMode);
          return;
        }
        if (e.key === "Escape" && dropMode) {
          e.preventDefault();
          setDropMode(false);
        }
      },
      true
    );

    window.addEventListener("hashchange", checkScreenChange);
    window.addEventListener("popstate", checkScreenChange);

    if (typeof MutationObserver === "function") {
      const obsTarget = document.body;
      if (obsTarget) {
        const observer = new MutationObserver(function () {
          checkScreenChange();
        });
        observer.observe(obsTarget, {
          attributes: true,
          subtree: true,
          attributeFilter: ["hidden", "class", "style"]
        });
      }
    }

    window.addEventListener("storage", function (e) {
      if (e && e.key === LS_KEY) {
        notes = loadLocalNotes();
        renderAll();
      }
    });

    window.addEventListener("pagehide", function () {
      if (flushPendingDebounces()) {
        pushNotesToCloud();
      }
    });

    let lastVisSync = 0;
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && secretUnlocked) {
        const now = Date.now();
        if (now - lastVisSync > 5000) {
          lastVisSync = now;
          syncNow();
        }
      }
    });
  }

  function mountDom() {
    if (typeof document === "undefined" || !document.body) return;
    injectStyles();

    layerEl = document.getElementById(LAYER_ID);
    if (!layerEl) {
      layerEl = document.createElement("div");
      layerEl.id = LAYER_ID;
      document.body.appendChild(layerEl);
    }

    dockEl = document.getElementById(DOCK_ID);
    if (!dockEl) {
      dockEl = document.createElement("div");
      dockEl.id = DOCK_ID;
      dockEl.setAttribute("role", "region");
      dockEl.setAttribute("aria-label", "Sticky notes feedback controls");

      toggleBtnEl = document.createElement("button");
      toggleBtnEl.type = "button";
      toggleBtnEl.id = "rt-sticky-toggle-btn";
      toggleBtnEl.className = "rt-sticky-dock-btn rt-sticky-dock-pill";
      toggleBtnEl.hidden = true;
      toggleBtnEl.addEventListener("click", function () {
        notesVisible = !notesVisible;
        ssSet(SS_VISIBLE_KEY, notesVisible ? "1" : "0");
        renderAll();
      });

      clearBtnEl = document.createElement("button");
      clearBtnEl.type = "button";
      clearBtnEl.id = "rt-sticky-clear-btn";
      clearBtnEl.className = "rt-sticky-dock-btn rt-sticky-dock-clear";
      clearBtnEl.textContent = "[ CLEAR ALL ]";
      clearBtnEl.title = "Clear all sticky notes";
      clearBtnEl.hidden = true;
      clearBtnEl.addEventListener("click", function () {
        clearAllNotesWithConfirm();
      });

      addBtnEl = document.createElement("button");
      addBtnEl.type = "button";
      addBtnEl.id = "rt-sticky-add-btn";
      addBtnEl.className = "rt-sticky-dock-btn rt-sticky-dock-add";
      addBtnEl.textContent = "[ + STICKY NOTE ]";
      addBtnEl.addEventListener("click", function () {
        setDropMode(!dropMode);
      });

      lockBtnEl = document.createElement("button");
      lockBtnEl.type = "button";
      lockBtnEl.id = "rt-sticky-lock-btn";
      lockBtnEl.className = "rt-sticky-dock-btn rt-sticky-dock-pill";
      lockBtnEl.textContent = "[ X ]";
      lockBtnEl.title = "Hide sticky notes mode (click logo 5x to reveal again)";
      lockBtnEl.setAttribute("aria-label", "Hide sticky notes mode");
      lockBtnEl.addEventListener("click", function () {
        setSecretUnlocked(false, true);
      });

      dockEl.appendChild(toggleBtnEl);
      dockEl.appendChild(clearBtnEl);
      dockEl.appendChild(addBtnEl);
      dockEl.appendChild(lockBtnEl);
      document.body.appendChild(dockEl);
    } else {
      addBtnEl = document.getElementById("rt-sticky-add-btn");
      toggleBtnEl = document.getElementById("rt-sticky-toggle-btn");
      clearBtnEl = document.getElementById("rt-sticky-clear-btn");
      lockBtnEl = document.getElementById("rt-sticky-lock-btn");
    }

    activeScreen = detectActiveScreen();
    bindGlobalEvents();
    renderAll();
    if (secretUnlocked && !isCleanUrlForced()) {
      syncNow();
    }
  }

  /* ---------------- Public API ---------------- */
  function getNotes() {
    return notes.map(cloneNote);
  }

  function addNote(input) {
    const base =
      typeof input === "string"
        ? { text: input }
        : input && typeof input === "object"
          ? input
          : {};
    const defaultY =
      ((typeof window !== "undefined" && (window.scrollY || window.pageYOffset)) || 0) +
      120 +
      (notes.length % 5) * 24;
    const defaultX = 48 + (notes.length % 4) * 3;

    const note = normalizeNote(
      {
        id: base.id || makeNoteId(),
        screen: base.screen || detectActiveScreen(),
        xPct: base.xPct !== undefined ? base.xPct : defaultX,
        yPx: base.yPx !== undefined ? base.yPx : defaultY,
        selector: base.selector || "page",
        targetText: base.targetText || "",
        text: base.text !== undefined ? base.text : "",
        minimized: Boolean(base.minimized),
        updatedAt: base.updatedAt !== undefined ? base.updatedAt : Date.now()
      },
      detectActiveScreen()
    );

    tombstones.delete(note.id);
    const existingIdx = notes.findIndex(function (n) {
      return n.id === note.id;
    });
    if (existingIdx !== -1) {
      notes[existingIdx] = note;
    } else {
      notes.push(note);
    }

    secretUnlocked = true;
    ssSet(SS_UNLOCKED_KEY, "1");
    notesVisible = true;
    ssSet(SS_VISIBLE_KEY, "1");
    saveLocalNotes();
    renderAll();
    pushNotesToCloud();
    return cloneNote(note);
  }

  function setDockHidden(hiddenFlag) {
    externalDockHidden = Boolean(hiddenFlag);
    renderAll();
  }

  const api = {
    getNotes: getNotes,
    setDockHidden: setDockHidden,
    isUnlocked: function () { return secretUnlocked; },
    setUnlocked: function (flag) { setSecretUnlocked(flag, false); },
    addNote: addNote,
    syncNow: syncNow
  };

  if (root) {
    root.RuntimeStickyNotes = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  if (typeof document !== "undefined") {
    if (document.body && document.head) {
      mountDom();
    } else if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mountDom, { once: true });
    } else {
      mountDom();
    }
  }
})(typeof window !== "undefined" ? window : globalThis);
