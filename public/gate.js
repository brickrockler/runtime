#!/usr/bin/env node
/* ==========================================================================
 * RUNTIME — Local Agent Blocker & Step Gate (gate.js)
 *
 * Path 1 — Pure Token Local Agent Blocker (NO API key, NO money needed):
 *   curl -fsSL https://runtime.jackcolley.com/gate.js | node - --install antigravity --vault <ID>
 *   curl -fsSL https://runtime.jackcolley.com/gate.js | node - --install claude --vault <ID>
 *   curl -fsSL https://runtime.jackcolley.com/gate.js | node - --install cursor --vault <ID>
 *   curl -fsSL https://runtime.jackcolley.com/gate.js | node - --install codex --vault <ID>
 *   curl -fsSL https://runtime.jackcolley.com/gate.js | node - --status --vault <ID>
 *   curl -fsSL https://runtime.jackcolley.com/gate.js | node - --uninstall
 *
 * Path 2 — Localhost HTTP Proxy / MCP Server:
 *   curl -fsSL https://runtime.jackcolley.com/gate.js | node - --vault <ID>
 *   curl -fsSL https://runtime.jackcolley.com/gate.js | node - --vault <ID> --mcp
 * ========================================================================== */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const readline = require("readline");
const crypto = require("crypto");

const FS_BASE =
  "https://firestore.googleapis.com/v1/projects/ee-offsite-simulation/databases/(default)/documents/runtime_v2_vaults";
const DEFAULT_ORIGIN = "https://runtime.jackcolley.com";
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function validateSafeToken(val, label, allowEmpty) {
  const s = String(val === undefined || val === null ? "" : val).trim();
  if (!s && allowEmpty) return "";
  if (!SAFE_ID_RE.test(s)) {
    throw new Error("Invalid " + label + " (must match /^[A-Za-z0-9_-]{1,64}$/)");
  }
  return s;
}

function normalizeOrigin(rawOrigin) {
  const s = String(rawOrigin || process.env.RUNTIME_SITE_ORIGIN || DEFAULT_ORIGIN)
    .trim()
    .replace(/\/+$/, "");
  if (!/^https?:\/\/[A-Za-z0-9.:-]+$/.test(s)) {
    throw new Error("Invalid --origin URL: " + s);
  }
  return s;
}

function buildWalkUrl(cfg) {
  const origin = normalizeOrigin(cfg.origin);
  const v = encodeURIComponent(cfg.vaultId);
  const ftPart = cfg.ft ? "&ft=" + encodeURIComponent(cfg.ft) : "";
  return origin + "/?pair=" + v + ftPart + "#walk";
}

function parseArgs(argv) {
  const out = {
    vaultId: process.env.RUNTIME_VAULT_ID || "vlt_cli_default",
    ft: process.env.RUNTIME_FIELD_TOKEN || "",
    origin: process.env.RUNTIME_SITE_ORIGIN || DEFAULT_ORIGIN,
    port: Number(process.env.RUNTIME_PORT || 4402),
    cost: Number(process.env.RUNTIME_TURN_TOKENS || 2500),
    bridgePort: Number(process.env.RUNTIME_BRIDGE_PORT || 8765),
    clientId: "",
    clientSecret: "",
    mode: "proxy",
    target: "",
    extraArgs: []
  };

  let passthrough = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (passthrough) {
      out.extraArgs.push(a);
      continue;
    }
    if (a === "--") {
      passthrough = true;
      continue;
    }
    if ((a === "--key" || a === "--vault") && argv[i + 1]) {
      out.vaultId = argv[++i];
    } else if (a.startsWith("--key=")) {
      out.vaultId = a.slice(6);
    } else if (a.startsWith("--vault=")) {
      out.vaultId = a.slice(8);
    } else if (a === "--ft" && argv[i + 1]) {
      out.ft = argv[++i];
    } else if (a.startsWith("--ft=")) {
      out.ft = a.slice(5);
    } else if (a === "--origin" && argv[i + 1]) {
      out.origin = argv[++i];
    } else if (a.startsWith("--origin=")) {
      out.origin = a.slice(9);
    } else if (a === "--port" && argv[i + 1]) {
      out.port = Number(argv[++i]);
    } else if (a.startsWith("--port=")) {
      out.port = Number(a.slice(7));
    } else if (a === "--cost" && argv[i + 1]) {
      out.cost = Number(argv[++i]);
    } else if (a.startsWith("--cost=")) {
      out.cost = Number(a.slice(7));
    } else if (a === "--install") {
      out.mode = "install";
      out.target = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i].toLowerCase() : "auto";
    } else if (a.startsWith("--install=")) {
      out.mode = "install";
      out.target = a.slice(10).toLowerCase();
    } else if (a === "--status") {
      out.mode = "status";
    } else if (a === "--uninstall") {
      out.mode = "uninstall";
      if (argv[i + 1] && !argv[i + 1].startsWith("-")) out.target = argv[++i].toLowerCase();
    } else if (a.startsWith("--uninstall=")) {
      out.mode = "uninstall";
      out.target = a.slice(12).toLowerCase();
    } else if (a === "--hook" && argv[i + 1]) {
      out.mode = "hook";
      out.target = argv[++i].toLowerCase();
    } else if (a.startsWith("--hook=")) {
      out.mode = "hook";
      out.target = a.slice(7).toLowerCase();
    } else if (a === "--codex") {
      out.mode = "codex";
    } else if (a === "--claude") {
      out.mode = "claude";
    } else if (a === "--connect") {
      out.mode = "connect";
      out.target = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i].toLowerCase() : "whoop";
    } else if (a.startsWith("--connect=")) {
      out.mode = "connect";
      out.target = a.slice(10).toLowerCase() || "whoop";
    } else if (a === "--disconnect") {
      out.mode = "disconnect";
      out.target = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i].toLowerCase() : "all";
    } else if (a.startsWith("--disconnect=")) {
      out.mode = "disconnect";
      out.target = a.slice(13).toLowerCase() || "all";
    } else if (a === "--sync" || a === "--sync-fitness") {
      out.mode = "sync";
    } else if (a === "--bridge") {
      out.mode = "bridge";
    } else if (a === "--bridge-port" && argv[i + 1]) {
      out.bridgePort = Number(argv[++i]);
    } else if (a.startsWith("--bridge-port=")) {
      out.bridgePort = Number(a.slice(14));
    } else if (a === "--client-id" && argv[i + 1]) {
      out.clientId = argv[++i];
    } else if (a.startsWith("--client-id=")) {
      out.clientId = a.slice(12);
    } else if (a === "--client-secret" && argv[i + 1]) {
      out.clientSecret = argv[++i];
    } else if (a.startsWith("--client-secret=")) {
      out.clientSecret = a.slice(16);
    } else if (a === "--mcp") {
      out.mode = "mcp";
    } else if (a === "--help" || a === "-h") {
      out.mode = "help";
    } else {
      out.extraArgs.push(a);
    }
  }

  if (
    (out.mode === "status" || out.mode === "connect" || out.mode === "sync" || out.mode === "bridge") &&
    out.vaultId === "vlt_cli_default" &&
    !process.env.RUNTIME_VAULT_ID
  ) {
    try {
      const savedCfgPath = path.join(os.homedir(), ".runtime", "config.json");
      if (fs.existsSync(savedCfgPath)) {
        const saved = JSON.parse(fs.readFileSync(savedCfgPath, "utf8"));
        if (saved && saved.vaultId) out.vaultId = saved.vaultId;
        if (saved && saved.ft && !out.ft) out.ft = saved.ft;
        if (saved && saved.origin && out.origin === DEFAULT_ORIGIN) out.origin = saved.origin;
      }
    } catch (_) {}
  }

  if (out.mode !== "uninstall" && out.mode !== "disconnect" && out.mode !== "help") {
    out.vaultId = validateSafeToken(out.vaultId, "vault ID", false);
    out.ft = validateSafeToken(out.ft, "field token", true);
    out.origin = normalizeOrigin(out.origin);
  }
  return out;
}

function fromFsFields(fields, updateTime) {
  const f = fields || {};
  const intField = (k, def) =>
    f[k] && f[k].integerValue !== undefined
      ? Number(f[k].integerValue)
      : f[k] && f[k].doubleValue !== undefined
        ? Math.floor(Number(f[k].doubleValue))
        : def;
  const strField = (k, def) =>
    f[k] && f[k].stringValue !== undefined ? String(f[k].stringValue) : def;
  const stepsTotal = Math.max(0, intField("stepsTotal", 0));
  const tokensPerStep = Math.max(1, intField("tokensPerStep", 25));
  const tokensBurned = Math.max(0, intField("tokensBurned", 0));
  const turnsCompleted = Math.max(0, intField("turnsCompleted", 0));
  const tokensEarned = stepsTotal * tokensPerStep;
  const tokensAvailable = Math.max(0, tokensEarned - tokensBurned);
  const creditAvailableUsd = Number((tokensAvailable * 0.00002).toFixed(4));
  return {
    vaultId: strField("vaultId", ""),
    stepsTotal,
    tokensPerStep,
    tokensEarned,
    tokensBurned,
    tokensAvailable,
    turnsCompleted,
    creditAvailableUsd,
    devices:
      f.devices && f.devices.arrayValue && Array.isArray(f.devices.arrayValue.values)
        ? f.devices.arrayValue.values
            .map((x) => (x && x.stringValue ? String(x.stringValue) : ""))
            .filter(Boolean)
        : [],
    dailySyncJson: strField("dailySyncJson", "{}"),
    fieldTokenHash: strField("fieldTokenHash", ""),
    resetEpoch: intField("resetEpoch", 0),
    updatedAt: intField("updatedAt", Date.now()),
    updateTime: updateTime || ""
  };
}

async function fetchWithTimeout(url, opts, ms = 4500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, opts || {}, { signal: ctrl.signal }));
  } finally {
    clearTimeout(t);
  }
}

async function getVaultState(vaultId) {
  const cleanId = validateSafeToken(vaultId, "vault ID", false);
  const url = FS_BASE + "/" + encodeURIComponent(cleanId);
  const r = await fetchWithTimeout(url);
  if (r.status === 404) {
    const created = await patchVaultState(cleanId, {
      vaultId: cleanId,
      stepsTotal: 0,
      tokensPerStep: 25,
      tokensEarned: 0,
      tokensBurned: 0,
      tokensAvailable: 0,
      turnsCompleted: 0,
      updatedAt: Date.now()
    });
    return created;
  }
  if (!r.ok) throw new Error("Firestore read HTTP " + r.status);
  const doc = await r.json();
  const parsed = fromFsFields(doc.fields, doc.updateTime);
  parsed.vaultId = cleanId;
  return parsed;
}

async function patchVaultState(vaultId, partial, expectedUpdateTime) {
  const cleanId = validateSafeToken(vaultId, "vault ID", false);
  const fields = {};
  const queryParts = [];
  for (const [k, v] of Object.entries(partial)) {
    queryParts.push("updateMask.fieldPaths=" + encodeURIComponent(k));
    if (typeof v === "number") {
      fields[k] = { integerValue: String(Math.round(v)) };
    } else if (Array.isArray(v)) {
      fields[k] = {
        arrayValue: {
          values: v.map((item) => ({ stringValue: String(item) }))
        }
      };
    } else {
      fields[k] = { stringValue: String(v) };
    }
  }
  if (expectedUpdateTime) {
    queryParts.push(
      "currentDocument.updateTime=" + encodeURIComponent(expectedUpdateTime)
    );
  }
  const url = FS_BASE + "/" + encodeURIComponent(cleanId) + "?" + queryParts.join("&");
  const r = await fetchWithTimeout(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields })
  });
  if (!r.ok) {
    const err = new Error("Firestore patch HTTP " + r.status);
    err.status = r.status;
    throw err;
  }
  const doc = await r.json();
  const parsed = fromFsFields(doc.fields, doc.updateTime);
  parsed.vaultId = cleanId;
  return parsed;
}

async function recordTokenBurn(vaultId, tokensUsed, prefetchedState) {
  const cur = prefetchedState || (await getVaultState(vaultId));
  const delta = Math.max(1, Math.round(Number(tokensUsed) || 1));
  const applyOn = async (snap, usePrecondition) => {
    const nextBurned = Math.min(snap.tokensEarned, snap.tokensBurned + delta);
    const nextAvail = Math.max(0, snap.tokensEarned - nextBurned);
    const nextTurns = (snap.turnsCompleted || 0) + 1;
    return patchVaultState(
      vaultId,
      {
        tokensBurned: nextBurned,
        tokensAvailable: nextAvail,
        turnsCompleted: nextTurns,
        updatedAt: Date.now()
      },
      usePrecondition && snap.updateTime ? snap.updateTime : ""
    );
  };

  try {
    return await applyOn(cur, true);
  } catch (err) {
    if (err && (err.status === 400 || err.status === 409 || err.status === 412)) {
      const fresh = await getVaultState(vaultId);
      if (fresh.resetEpoch > (cur.resetEpoch || 0) || fresh.tokensAvailable <= 0) {
        return fresh;
      }
      return await applyOn(fresh, false);
    }
    throw err;
  }
}

/* ---------------- Stdin Reader & Antigravity Turn Deduplication ---------------- */
function readHookStdin(timeoutMs = 150) {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks = [];
    let totalBytes = 0;
    const maxBytes = 2 * 1024 * 1024;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        resolve(Buffer.concat(chunks).toString("utf8"));
      } catch (_) {
        resolve("");
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on("data", (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
      if (totalBytes < maxBytes) {
        chunks.push(buf);
        totalBytes += buf.length;
      }
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.resume();
  });
}

function extractAgConvAndStep(stdinObj) {
  if (!stdinObj || typeof stdinObj !== "object") return { convId: "", stepIdx: "" };
  const convId = String(
    stdinObj.conversationId || stdinObj.conversation_id || stdinObj.session_id || ""
  ).trim();
  const rawStep =
    stdinObj.stepIdx !== undefined
      ? stdinObj.stepIdx
      : stdinObj.step_index !== undefined
        ? stdinObj.step_index
        : "";
  return { convId, stepIdx: rawStep !== "" ? String(rawStep) : "" };
}

function wasAntigravityStepAlreadyAllowed(cfg, stdinObj) {
  const { convId, stepIdx } = extractAgConvAndStep(stdinObj);
  if (!convId) return false;
  const stateFile = path.join(os.homedir(), ".runtime", "turn-state.json");
  const key = cfg.vaultId + ":" + convId;
  const cooldownMs = Math.max(
    0,
    Number(
      process.env.RUNTIME_AG_COOLDOWN_MS !== undefined
        ? process.env.RUNTIME_AG_COOLDOWN_MS
        : 8000
    )
  );
  const now = Date.now();
  try {
    if (!fs.existsSync(stateFile)) return false;
    const map = JSON.parse(fs.readFileSync(stateFile, "utf8")) || {};
    const prev = map[key];
    if (prev && prev.allowed === true) {
      if (stepIdx && prev.stepIdx === stepIdx && now - Number(prev.ts || 0) < 30000) {
        return true;
      }
      if (cooldownMs > 0 && now - Number(prev.ts || 0) < cooldownMs) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

function shouldSkipAntigravityDuplicateBurn(cfg, stdinObj) {
  const { convId, stepIdx } = extractAgConvAndStep(stdinObj);
  if (!convId) {
    return false;
  }
  const rtDir = path.join(os.homedir(), ".runtime");
  const stateFile = path.join(rtDir, "turn-state.json");
  const key = cfg.vaultId + ":" + convId;
  const cooldownMs = Math.max(
    0,
    Number(
      process.env.RUNTIME_AG_COOLDOWN_MS !== undefined
        ? process.env.RUNTIME_AG_COOLDOWN_MS
        : 8000
    )
  );
  const now = Date.now();

  try {
    fs.mkdirSync(rtDir, { recursive: true });
    let map = {};
    if (fs.existsSync(stateFile)) {
      try {
        map = JSON.parse(fs.readFileSync(stateFile, "utf8")) || {};
      } catch (_) {
        map = {};
      }
    }
    const prev = map[key];
    if (prev && typeof prev === "object") {
      if (stepIdx && prev.stepIdx === stepIdx) {
        return true;
      }
      if (cooldownMs > 0 && now - Number(prev.ts || 0) < cooldownMs) {
        return true;
      }
    }
    for (const k of Object.keys(map)) {
      if (!map[k] || now - Number(map[k].ts || 0) > 600000) {
        delete map[k];
      }
    }
    map[key] = { stepIdx, allowed: true, ts: now };
    const tmpFile = stateFile + "." + process.pid + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(map), "utf8");
    fs.renameSync(tmpFile, stateFile);
  } catch (_) {}
  return false;
}

/* ---------------- Native Agent Hook Execution (Zero Money / Pure Tokens) ---------------- */
async function runIdeHook(cfg) {
  const rawStdin = await readHookStdin(120);
  let stdinObj = null;
  if (rawStdin && rawStdin.trim().startsWith("{")) {
    try {
      stdinObj = JSON.parse(rawStdin);
    } catch (_) {}
  }

  const walkUrl = buildWalkUrl(cfg);
  let st;
  try {
    st = await getVaultState(cfg.vaultId);
  } catch (_) {
    // Fail-open only on network outage so offline flights don't brick local agent
    if (cfg.target === "antigravity") console.log(JSON.stringify({ decision: "allow" }));
    else if (cfg.target === "cursor") console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  if (cfg.target === "antigravity" && wasAntigravityStepAlreadyAllowed(cfg, stdinObj)) {
    console.log(JSON.stringify({ decision: "allow" }));
    process.exit(0);
  }

  try {
    const syncedSt = await autoSyncFitnessInHook(cfg, st);
    if (syncedSt) st = syncedSt;
  } catch (_) {}

  if (st.tokensAvailable <= 0) {
    const msg =
      "RUNTIME BLOCKED -- 0 tokens left (" +
      st.stepsTotal.toLocaleString("en-US") +
      " steps walked). Walk on your phone to unlock automatically: " +
      walkUrl;
    if (cfg.target === "antigravity") {
      const agReason =
        msg +
        " -- IMPORTANT: Stop calling tools immediately and display this exact RUNTIME BLOCKED message and link to the user.";
      console.log(JSON.stringify({ decision: "deny", reason: agReason }));
      process.exit(0);
    } else if (cfg.target === "cursor") {
      console.log(JSON.stringify({ continue: false, user_message: msg, userMessage: msg }));
      process.exit(0);
    } else {
      // Claude Code & OpenAI Codex UserPromptSubmit hooks: exit 2 + stderr message blocks prompt
      process.stderr.write(msg + "\n");
      process.exit(2);
    }
  }

  const skipDup =
    cfg.target === "antigravity" && shouldSkipAntigravityDuplicateBurn(cfg, stdinObj);
  if (!skipDup) {
    try {
      await recordTokenBurn(cfg.vaultId, cfg.cost || 2500, st);
    } catch (_) {
      // Fail-open on transient write error so hook JSON output remains intact
    }
  }

  if (cfg.target === "antigravity") {
    console.log(JSON.stringify({ decision: "allow" }));
  } else if (cfg.target === "cursor") {
    console.log(JSON.stringify({ continue: true }));
  }
  process.exit(0);
}

/* ---------------- Safe JSON / JSONC Config Reader & Writer ---------------- */
function stripJsonc(input) {
  let out = "";
  let inStr = false;
  let strQuote = '"';
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];
    if (inStr) {
      out += ch;
      if (ch === "\\" && i + 1 < input.length) {
        out += input[++i];
      } else if (ch === strQuote) {
        inStr = false;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      strQuote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  // Strip trailing commas before } or ] outside strings
  let cleaned = "";
  inStr = false;
  for (let j = 0; j < out.length; j++) {
    const c = out[j];
    if (inStr) {
      cleaned += c;
      if (c === "\\" && j + 1 < out.length) cleaned += out[++j];
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      cleaned += c;
      continue;
    }
    if (c === ",") {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k++;
      if (out[k] === "}" || out[k] === "]") continue;
    }
    cleaned += c;
  }
  return cleaned;
}

function readJsonPreservingConfig(fp) {
  if (!fs.existsSync(fp)) return {};
  const raw = fs.readFileSync(fp, "utf8").replace(/^\uFEFF/, "");
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch (_) {
    try {
      const parsedJsonc = JSON.parse(stripJsonc(raw));
      if (parsedJsonc && typeof parsedJsonc === "object" && !Array.isArray(parsedJsonc)) {
        return parsedJsonc;
      }
    } catch (err2) {
      throw new Error(
        "Refusing to overwrite existing unparseable config file " +
          fp +
          " (" +
          (err2 && err2.message ? err2.message : "invalid JSON") +
          ")"
      );
    }
  }
  throw new Error("Refusing to overwrite non-object config file " + fp);
}

function writeJsonSafe(fp, obj) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function resolveNodeBinary() {
  if (
    process.execPath &&
    path.isAbsolute(process.execPath) &&
    fs.existsSync(process.execPath)
  ) {
    try {
      const realExec = fs.realpathSync(process.execPath);
      if (realExec && path.isAbsolute(realExec) && fs.existsSync(realExec)) {
        fs.accessSync(realExec, fs.constants.X_OK);
        return realExec;
      }
    } catch (_) {}
    return process.execPath;
  }
  const realHome = process.env.USER ? path.join("/Users", process.env.USER) : os.homedir();
  const candidates = [
    path.join(os.homedir(), ".volta", "bin", "node"),
    path.join(os.homedir(), ".nvm", "current", "bin", "node"),
    path.join(os.homedir(), ".fnm", "current", "bin", "node"),
    path.join(os.homedir(), ".asdf", "shims", "node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    path.join(realHome, ".volta", "bin", "node"),
    path.join(realHome, ".nvm", "current", "bin", "node")
  ];
  for (const c of candidates) {
    try {
      if (c && path.isAbsolute(c) && fs.existsSync(c)) {
        fs.accessSync(c, fs.constants.X_OK);
        return c;
      }
    } catch (_) {}
  }
  if (
    process.execPath &&
    path.isAbsolute(process.execPath) &&
    fs.existsSync(process.execPath)
  ) {
    return process.execPath;
  }
  return "node";
}

async function ensureLocalGateBinary(cfg) {
  const rtDir = path.join(os.homedir(), ".runtime");
  const dest = path.join(rtDir, "gate.js");
  fs.mkdirSync(rtDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(rtDir, 0o700); } catch (_) {}
  let code = "";
  try {
    if (__filename && fs.existsSync(__filename)) {
      code = fs.readFileSync(__filename, "utf8");
    }
  } catch (_) {}
  if (!code || code.length < 500) {
    const origin = normalizeOrigin(cfg && cfg.origin);
    const r = await fetchWithTimeout(origin + "/gate.js", {}, 8000);
    if (!r.ok) throw new Error("Failed to download gate.js (" + r.status + ")");
    code = await r.text();
  }
  fs.writeFileSync(dest, code, { mode: 0o755 });
  return dest;
}

function buildHookCmdString(nodeBin, gateBin, hookTarget, cfg, cost) {
  const parts = [
    `"${nodeBin}"`,
    `"${gateBin}"`,
    `--hook=${hookTarget}`,
    `--vault=${cfg.vaultId}`,
    `--cost=${cost}`
  ];
  if (cfg.ft) parts.push(`--ft=${cfg.ft}`);
  if (cfg.origin && cfg.origin !== DEFAULT_ORIGIN) {
    parts.push(`--origin=${cfg.origin}`);
  }
  return parts.join(" ");
}

function detectCandidateAgentDirs(home) {
  const found = [];
  if (fs.existsSync(path.join(home, ".gemini"))) found.push("antigravity");
  if (fs.existsSync(path.join(home, ".claude"))) found.push("claude");
  if (fs.existsSync(path.join(home, ".cursor"))) found.push("cursor");
  if (fs.existsSync(path.join(home, ".codex"))) found.push("codex");
  return found.length > 0 ? found : ["antigravity", "claude", "cursor", "codex"];
}

function installSingleIdeTarget(target, home, nodeBin, gateBin, cfg) {
  const vault = cfg.vaultId;
  if (target === "antigravity") {
    const fp = path.join(home, ".gemini", "config", "hooks.json");
    const j = readJsonPreservingConfig(fp);
    j["runtime-step-gate"] = {
      enabled: true,
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: buildHookCmdString(nodeBin, gateBin, "antigravity", cfg, cfg.cost || 2500),
              timeout: 10
            }
          ]
        }
      ]
    };
    writeJsonSafe(fp, j);
    console.log(`INSTALLED Antigravity step blocker -> ${fp}`);
  } else if (target === "claude") {
    const fp = path.join(home, ".claude", "settings.json");
    const j = readJsonPreservingConfig(fp);
    j.hooks = j.hooks && typeof j.hooks === "object" ? j.hooks : {};
    const list = Array.isArray(j.hooks.UserPromptSubmit) ? j.hooks.UserPromptSubmit : [];
    const filtered = list.filter((item) => !JSON.stringify(item).includes("--hook=claude"));
    filtered.push({
      hooks: [
        {
          type: "command",
          command: buildHookCmdString(nodeBin, gateBin, "claude", cfg, cfg.cost || 2500)
        }
      ]
    });
    j.hooks.UserPromptSubmit = filtered;
    writeJsonSafe(fp, j);
    console.log(`INSTALLED Claude Code step blocker -> ${fp}`);
  } else if (target === "cursor") {
    const fp = path.join(home, ".cursor", "hooks.json");
    const j = readJsonPreservingConfig(fp);
    if (!j.version) j.version = 1;
    j.hooks = j.hooks && typeof j.hooks === "object" ? j.hooks : {};
    const list = Array.isArray(j.hooks.beforeSubmitPrompt) ? j.hooks.beforeSubmitPrompt : [];
    const filtered = list.filter((item) => !JSON.stringify(item).includes("--hook=cursor"));
    filtered.push({
      command: buildHookCmdString(nodeBin, gateBin, "cursor", cfg, cfg.cost || 2500)
    });
    j.hooks.beforeSubmitPrompt = filtered;
    writeJsonSafe(fp, j);
    console.log(`INSTALLED Cursor step blocker -> ${fp}`);
  } else if (target === "codex") {
    const fp = path.join(home, ".codex", "hooks.json");
    const j = readJsonPreservingConfig(fp);
    j.hooks = j.hooks && typeof j.hooks === "object" ? j.hooks : {};
    const list = Array.isArray(j.hooks.UserPromptSubmit) ? j.hooks.UserPromptSubmit : [];
    const filtered = list.filter((item) => !JSON.stringify(item).includes("--hook=codex"));
    filtered.push({
      hooks: [
        {
          type: "command",
          command: buildHookCmdString(nodeBin, gateBin, "codex", cfg, cfg.cost || 2500)
        }
      ]
    });
    j.hooks.UserPromptSubmit = filtered;
    writeJsonSafe(fp, j);

    const wrapper = path.join(home, ".runtime", "codex-gated");
    const extraFlags = [
      `--codex`,
      `--vault=${vault}`,
      cfg.ft ? `--ft=${cfg.ft}` : "",
      cfg.origin && cfg.origin !== DEFAULT_ORIGIN ? `--origin=${cfg.origin}` : ""
    ]
      .filter(Boolean)
      .join(" ");
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\nexec "${nodeBin}" "${gateBin}" ${extraFlags} -- "$@"\n`,
      { mode: 0o755 }
    );
    console.log(`INSTALLED Codex step blocker -> ${fp} (+ ${wrapper})`);
  } else {
    throw new Error(
      "Unknown agent target: " + target + " (use auto, all, antigravity, claude, cursor, or codex)"
    );
  }
}

async function installIdeHook(cfg) {
  const home = os.homedir();
  const nodeBin = resolveNodeBinary();
  const gateBin = await ensureLocalGateBinary(cfg);
  const rawTarget = (cfg.target || "auto").toLowerCase();
  const vault = cfg.vaultId;

  const targetsToInstall =
    rawTarget === "all"
      ? ["antigravity", "claude", "cursor", "codex"]
      : rawTarget === "auto"
        ? detectCandidateAgentDirs(home)
        : [rawTarget];

  for (const t of targetsToInstall) {
    installSingleIdeTarget(t, home, nodeBin, gateBin, cfg);
  }

  try {
    const cfgPath = path.join(home, ".runtime", "config.json");
    let prev = {};
    if (fs.existsSync(cfgPath)) {
      try { prev = JSON.parse(fs.readFileSync(cfgPath, "utf8")) || {}; } catch (_) {}
    }
    const targets = Array.from(new Set([].concat(prev.installedTargets || [], targetsToInstall)));
    writeJsonSafe(cfgPath, {
      vaultId: vault,
      ft: cfg.ft || prev.ft || "",
      origin: normalizeOrigin(cfg.origin),
      installedTargets: targets,
      updatedAt: Date.now()
    });
    try { fs.chmodSync(cfgPath, 0o600); } catch (_) {}
  } catch (_) {}

  let balanceLine = "0 steps · 0 tokens (LOCKED -- walk to unlock)";
  try {
    const st = await getVaultState(vault);
    const agentDevs = targetsToInstall.map((t) => "agent_" + t);
    const nextDevs = Array.from(new Set([].concat(st.devices || [], agentDevs)));
    const changed = agentDevs.some((d) => (st.devices || []).indexOf(d) === -1);
    if (changed) {
      await patchVaultState(vault, { devices: nextDevs, updatedAt: Date.now() }).catch(() => {});
    }
    const stateTag = st.tokensAvailable > 0 ? "UNLOCKED" : "LOCKED -- walk to unlock";
    balanceLine = `${st.stepsTotal.toLocaleString("en-US")} steps · ${st.tokensAvailable.toLocaleString("en-US")} tokens (${stateTag})`;
  } catch (_) {}

  const toolNames = {
    antigravity: "ANTIGRAVITY",
    claude: "CLAUDE CODE",
    cursor: "CURSOR",
    codex: "CODEX"
  };
  const headerName =
    targetsToInstall.length > 1
      ? targetsToInstall.map((t) => toolNames[t] || t.toUpperCase()).join(" + ")
      : toolNames[targetsToInstall[0]] || targetsToInstall[0].toUpperCase();
  const titleText =
    targetsToInstall.length > 1
      ? `${targetsToInstall.length} AGENT BLOCKERS INSTALLED`
      : `${headerName} BLOCKER INSTALLED`;
  console.log("┌──────────────────────────────────────────────────────────────┐");
  console.log(`│ RUNTIME -- ${titleText.padEnd(50, " ")}│`);
  console.log("├──────────────────────────────────────────────────────────────┤");
  console.log(`  Agents    : ${headerName}`);
  console.log(`  Balance   : ${balanceLine}`);
  console.log(`  Settings  : Existing agent settings kept untouched`);
  console.log(`  Next step : Return to your browser -> [ OPEN LIVE TRACKER ]`);
  console.log(`  Walk link : ${buildWalkUrl(cfg)}`);
  console.log(`  Status    : node ~/.runtime/gate.js --status`);
  console.log(`  Uninstall : node ~/.runtime/gate.js --uninstall`);
  console.log("└──────────────────────────────────────────────────────────────┘");
}

function detectInstalledAgents(home) {
  const active = [];
  const check = (fp, needle, label) => {
    try {
      if (fs.existsSync(fp) && fs.readFileSync(fp, "utf8").includes(needle)) active.push(label);
    } catch (_) {}
  };
  check(path.join(home, ".gemini", "config", "hooks.json"), "runtime-step-gate", "antigravity");
  check(path.join(home, ".claude", "settings.json"), "--hook=claude", "claude");
  check(path.join(home, ".cursor", "hooks.json"), "--hook=cursor", "cursor");
  check(path.join(home, ".codex", "hooks.json"), "--hook=codex", "codex");
  return active;
}

async function printVaultStatus(cfg) {
  const st = await getVaultState(cfg.vaultId);
  const walkUrl = buildWalkUrl(cfg);
  const turns = st.tokensAvailable > 0 ? Math.ceil(st.tokensAvailable / (cfg.cost || 2500)) : 0;
  const barLen = 20;
  const fullTank = Math.max(2500, (st.tokensPerStep || 25) * 1000);
  const filled = Math.max(0, Math.min(barLen, Math.round((st.tokensAvailable / fullTank) * barLen)));
  const fuelBar = "█".repeat(filled) + "░".repeat(barLen - filled);
  const statusTag = st.tokensAvailable > 0 ? "UNLOCKED" : "LOCKED — GO WALK";
  const agents = detectInstalledAgents(os.homedir());

  console.log("┌──────────────────────────────────────────────────────────────┐");
  console.log("│ RUNTIME — STEP & TOKEN TRACKER                               │");
  console.log("├──────────────────────────────────────────────────────────────┤");
  console.log(`  STATUS   : [ ${statusTag} ]`);
  console.log(`  STEPS    : ${st.stepsTotal.toLocaleString("en-US")} walked (${(st.tokensPerStep * 1000).toLocaleString("en-US")} tokens / 1,000 steps)`);
  console.log(`  TOKENS   : ${st.tokensAvailable.toLocaleString("en-US")} left · ~${turns} turns (${st.tokensBurned.toLocaleString("en-US")} burned)`);
  console.log(`  TANK     : [${fuelBar}]`);
  console.log(`  AGENTS   : ${agents.length ? agents.join(", ") : "none installed on this computer"}`);
  const fitSummary = summarizeConnectedFitness();
  console.log(`  FITNESS  : ${fitSummary}`);
  console.log(`  VAULT    : ${cfg.vaultId}`);
  console.log(`  WALK URL : ${walkUrl}`);
  console.log("└──────────────────────────────────────────────────────────────┘");
}

function unlinkIfExists(fp) {
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (_) {}
}

function uninstallIdeHooks(targetFilter) {
  const home = os.homedir();
  const only = targetFilter ? String(targetFilter).toLowerCase().trim() : "";

  // 1. Antigravity (~/.gemini/config/hooks.json)
  if (!only || only === "antigravity") {
    try {
      const agFile = path.join(home, ".gemini", "config", "hooks.json");
      if (fs.existsSync(agFile)) {
        const j = readJsonPreservingConfig(agFile);
        delete j["runtime-step-gate"];
        if (Object.keys(j).length === 0) {
          unlinkIfExists(agFile);
        } else {
          writeJsonSafe(agFile, j);
        }
      }
    } catch (_) {}
  }

  // 2. Claude Code (~/.claude/settings.json)
  if (!only || only === "claude") {
    try {
      const clFile = path.join(home, ".claude", "settings.json");
      if (fs.existsSync(clFile)) {
        const j = readJsonPreservingConfig(clFile);
        if (j.hooks && typeof j.hooks === "object") {
          if (Array.isArray(j.hooks.UserPromptSubmit)) {
            j.hooks.UserPromptSubmit = j.hooks.UserPromptSubmit.filter(
              (x) => !JSON.stringify(x).includes("--hook=claude")
            );
            if (j.hooks.UserPromptSubmit.length === 0) {
              delete j.hooks.UserPromptSubmit;
            }
          }
          if (Object.keys(j.hooks).length === 0) {
            delete j.hooks;
          }
        }
        writeJsonSafe(clFile, j);
      }
    } catch (_) {}
  }

  // 3. Cursor (~/.cursor/hooks.json — schema requires minProperties: 1 on hooks)
  if (!only || only === "cursor") {
    try {
      const cuFile = path.join(home, ".cursor", "hooks.json");
      if (fs.existsSync(cuFile)) {
        const j = readJsonPreservingConfig(cuFile);
        if (j.hooks && typeof j.hooks === "object") {
          if (Array.isArray(j.hooks.beforeSubmitPrompt)) {
            j.hooks.beforeSubmitPrompt = j.hooks.beforeSubmitPrompt.filter(
              (x) => !JSON.stringify(x).includes("--hook=cursor")
            );
            if (j.hooks.beforeSubmitPrompt.length === 0) {
              delete j.hooks.beforeSubmitPrompt;
            }
          }
          if (Object.keys(j.hooks).length === 0) {
            delete j.hooks;
          }
        }
        const remainingHookEvents =
          j.hooks && typeof j.hooks === "object" ? Object.keys(j.hooks) : [];
        const nonStandardTopKeys = Object.keys(j).filter(
          (k) => k !== "version" && k !== "hooks"
        );
        if (remainingHookEvents.length === 0 && nonStandardTopKeys.length === 0) {
          unlinkIfExists(cuFile);
        } else {
          writeJsonSafe(cuFile, j);
        }
      }
    } catch (_) {}
  }

  // 4. OpenAI Codex (~/.codex/hooks.json + ~/.runtime/codex-gated)
  if (!only || only === "codex") {
    try {
      const cxFile = path.join(home, ".codex", "hooks.json");
      if (fs.existsSync(cxFile)) {
        const j = readJsonPreservingConfig(cxFile);
        if (j.hooks && typeof j.hooks === "object") {
          if (Array.isArray(j.hooks.UserPromptSubmit)) {
            j.hooks.UserPromptSubmit = j.hooks.UserPromptSubmit.filter(
              (x) => !JSON.stringify(x).includes("--hook=codex")
            );
            if (j.hooks.UserPromptSubmit.length === 0) {
              delete j.hooks.UserPromptSubmit;
            }
          }
          if (Object.keys(j.hooks).length === 0) {
            delete j.hooks;
          }
        }
        if (Object.keys(j).length === 0) {
          unlinkIfExists(cxFile);
        } else {
          writeJsonSafe(cxFile, j);
        }
      }
    } catch (_) {}
  }

  // 5. Remove ~/.runtime artifacts cleanly when no agents remain (or full uninstall)
  const rtDir = path.join(home, ".runtime");
  if (!only || only === "codex") {
    unlinkIfExists(path.join(rtDir, "codex-gated"));
  }
  const remainingAgents = detectInstalledAgents(home);
  if (!only || remainingAgents.length === 0) {
    unlinkIfExists(path.join(rtDir, "codex-gated"));
    unlinkIfExists(path.join(rtDir, "turn-state.json"));
    unlinkIfExists(path.join(rtDir, "config.json"));
    unlinkIfExists(path.join(rtDir, "gate.js"));
    try {
      if (fs.existsSync(rtDir) && fs.readdirSync(rtDir).length === 0) {
        fs.rmdirSync(rtDir);
      }
    } catch (_) {}
  }

  console.log(
    only
      ? `UNINSTALLED RUNTIME ${only} hook cleanly.`
      : "UNINSTALLED all RUNTIME local agent hooks cleanly."
  );
}

/* ---------------- HTTP Proxy & MCP Server ---------------- */
function allowedCorsOrigin(req) {
  const origin = req && req.headers ? String(req.headers.origin || "").trim() : "";
  if (!origin) return "";
  if (
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ||
    origin === "https://runtime-jackcolley.web.app" ||
    origin === "https://runtime.jackcolley.com" ||
    /^https:\/\/runtime(-[a-z0-9-]+)?\.vercel\.app$/i.test(origin)
  ) {
    return origin;
  }
  return "";
}

function readBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      total += buf.length;
      if (total > maxBytes) {
        const err = new Error("Request body exceeds 10MB limit");
        err.status = 413;
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj, extraHeaders, req) {
  const body = JSON.stringify(obj);
  const cors = allowedCorsOrigin(req);
  const baseHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, openai-beta, openai-organization, openai-project",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };
  if (cors) baseHeaders["Access-Control-Allow-Origin"] = cors;
  res.writeHead(status, Object.assign(baseHeaders, extraHeaders || {}));
  res.end(body);
}

function extractCallerKey(req) {
  const auth = String(req.headers["authorization"] || "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  if (req.headers["x-api-key"]) return String(req.headers["x-api-key"]).trim();
  return "";
}

function resolveUpstreamTarget(reqPath, search, callerKey) {
  const qs = search || "";
  const envAnthropic = process.env.ANTHROPIC_API_KEY || "";
  const envOpenRouter = process.env.OPENROUTER_API_KEY || "";
  const envOpenAI = process.env.OPENAI_API_KEY || "";
  const envUpstreamBase = (process.env.RUNTIME_UPSTREAM_BASE_URL || "").replace(/\/+$/, "");
  const realCallerKey = callerKey && !callerKey.startsWith("rt_gate_") ? callerKey : "";

  if (envUpstreamBase) {
    return {
      provider: reqPath.startsWith("/v1/messages") ? "anthropic" : "openai",
      url: envUpstreamBase + reqPath + qs,
      key: realCallerKey || envAnthropic || envOpenRouter || envOpenAI
    };
  }

  if (reqPath.startsWith("/v1/messages")) {
    return {
      provider: "anthropic",
      url: "https://api.anthropic.com" + reqPath + qs,
      key: realCallerKey || envAnthropic
    };
  }
  if (
    (realCallerKey && realCallerKey.startsWith("sk-or-")) ||
    (!realCallerKey && envOpenRouter && !envOpenAI)
  ) {
    return {
      provider: "openrouter",
      url: "https://openrouter.ai/api" + reqPath + qs,
      key: realCallerKey || envOpenRouter
    };
  }
  return {
    provider: "openai",
    url: "https://api.openai.com" + reqPath + qs,
    key: realCallerKey || envOpenAI
  };
}

function buildUpstreamHeaders(req, upstream) {
  const headers = { "Content-Type": "application/json" };
  if (upstream.provider === "anthropic") {
    if (req.headers["x-api-key"] || process.env.ANTHROPIC_API_KEY) {
      headers["x-api-key"] = upstream.key;
    } else if (req.headers["authorization"]) {
      headers["Authorization"] = String(req.headers["authorization"]);
    } else {
      headers["x-api-key"] = upstream.key;
    }
    headers["anthropic-version"] = String(req.headers["anthropic-version"] || "2023-06-01");
    if (req.headers["anthropic-beta"]) {
      headers["anthropic-beta"] = String(req.headers["anthropic-beta"]);
    }
  } else {
    headers["Authorization"] = "Bearer " + upstream.key;
    for (const h of ["openai-beta", "openai-organization", "openai-project"]) {
      if (req.headers[h]) headers[h] = String(req.headers[h]);
    }
  }
  return headers;
}

function clampExplicitMaxTokens(pathname, parsedBody, tokensAvailable) {
  if (!parsedBody || typeof parsedBody !== "object") return;
  const thinkingBudget =
    parsedBody.thinking && typeof parsedBody.thinking === "object"
      ? Number(parsedBody.thinking.budget_tokens || 0)
      : 0;

  if (pathname.startsWith("/v1/responses")) {
    if (typeof parsedBody.max_output_tokens === "number") {
      parsedBody.max_output_tokens = Math.min(
        parsedBody.max_output_tokens,
        Math.max(16, tokensAvailable)
      );
    }
    return;
  }

  if (typeof parsedBody.max_completion_tokens === "number") {
    parsedBody.max_completion_tokens = Math.min(
      parsedBody.max_completion_tokens,
      Math.max(1, tokensAvailable)
    );
  }
  if (typeof parsedBody.max_tokens === "number") {
    const floor = thinkingBudget > 0 ? thinkingBudget + 64 : 1;
    if (tokensAvailable >= floor) {
      parsedBody.max_tokens = Math.min(parsedBody.max_tokens, tokensAvailable);
    }
  }
}

function extractSseStats(sseBuffer) {
  let reportedTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let contentChars = 0;

  const lines = sseBuffer.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      const ev = JSON.parse(raw);
      // OpenAI / OpenRouter chat.completion.chunk
      if (ev.usage && typeof ev.usage === "object") {
        if (ev.usage.total_tokens) {
          reportedTokens = Math.max(reportedTokens, Number(ev.usage.total_tokens));
        } else {
          inputTokens = Math.max(inputTokens, Number(ev.usage.prompt_tokens || ev.usage.input_tokens || 0));
          outputTokens = Math.max(outputTokens, Number(ev.usage.completion_tokens || ev.usage.output_tokens || 0));
        }
      }
      // Anthropic message_start / message_delta
      if (ev.message && ev.message.usage) {
        inputTokens = Math.max(inputTokens, Number(ev.message.usage.input_tokens || 0));
        outputTokens = Math.max(outputTokens, Number(ev.message.usage.output_tokens || 0));
      }
      // OpenAI Responses response.completed
      if (ev.response && ev.response.usage && ev.response.usage.total_tokens) {
        reportedTokens = Math.max(reportedTokens, Number(ev.response.usage.total_tokens));
      }
      // Count actual text delta chars as fallback
      if (Array.isArray(ev.choices)) {
        for (const ch of ev.choices) {
          if (ch && ch.delta && typeof ch.delta.content === "string") {
            contentChars += ch.delta.content.length;
          }
        }
      }
      if (ev.delta && typeof ev.delta.text === "string") {
        contentChars += ev.delta.text.length;
      }
      if (typeof ev.delta === "string") {
        contentChars += ev.delta.length;
      }
    } catch (_) {}
  }

  const combined = reportedTokens || (inputTokens + outputTokens);
  if (combined > 0) return combined;
  return Math.max(16, Math.ceil(contentChars / 4));
}

function sendKeylessDemoResponse(res, pathname, parsedBody, used, remaining) {
  const text = `RUNTIME gate verified (${used} tokens burned, ${remaining} tokens left).`;
  if (parsedBody && parsedBody.stream === true) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    if (pathname.startsWith("/v1/messages")) {
      res.write(
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_runtime_demo", type: "message", role: "assistant", content: [], usage: { input_tokens: 12, output_tokens: 0 } } })}\n\n`
      );
      res.write(
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`
      );
      res.write(
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: Math.max(1, used - 12) } })}\n\n`
      );
      res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
    } else if (pathname.startsWith("/v1/responses")) {
      res.write(
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`
      );
      res.write(
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_runtime_demo", object: "response", output_text: text, usage: { total_tokens: used } } })}\n\n`
      );
    } else {
      res.write(
        `data: ${JSON.stringify({ id: "chatcmpl_runtime_demo", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({ id: "chatcmpl_runtime_demo", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: Math.max(1, used - 12), total_tokens: used } })}\n\n`
      );
      res.write("data: [DONE]\n\n");
    }
    res.end();
    return;
  }

  if (pathname.startsWith("/v1/messages")) {
    sendJson(res, 200, {
      id: "msg_runtime_demo",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 12, output_tokens: Math.max(1, used - 12) }
    });
  } else if (pathname.startsWith("/v1/responses")) {
    sendJson(res, 200, {
      id: "resp_runtime_demo",
      object: "response",
      status: "completed",
      output_text: text,
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }]
        }
      ],
      usage: { input_tokens: 12, output_tokens: Math.max(1, used - 12), total_tokens: used }
    });
  } else {
    sendJson(res, 200, {
      id: "chatcmpl_runtime_demo",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: Math.max(1, used - 12),
        total_tokens: used
      }
    });
  }
}

function startProxyServer(cfg) {
  const walkUrl = buildWalkUrl(cfg);
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.origin && !allowedCorsOrigin(req)) {
        sendJson(res, 403, { error: "Origin not permitted by RUNTIME localhost proxy" }, {}, req);
        return;
      }
      if (req.method === "OPTIONS") {
        sendJson(res, 200, { ok: true }, {}, req);
        return;
      }
      const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
      const pathname = reqUrl.pathname;

      if (
        req.method === "GET" &&
        (pathname === "/" || pathname === "/health" || pathname === "/status")
      ) {
        const st = await getVaultState(cfg.vaultId);
        const safeWalkUrl = req.headers.origin
          ? walkUrl.replace(/([?&])ft=[^&#]+(&?)/, (_, p1, p2) => (p2 ? p1 : ""))
          : walkUrl;
        sendJson(
          res,
          200,
          {
            ok: true,
            vaultId: cfg.vaultId,
            stepsTotal: st.stepsTotal,
            tokensAvailable: st.tokensAvailable,
            locked: st.tokensAvailable <= 0,
            walkUrl: safeWalkUrl
          },
          {},
          req
        );
        return;
      }

      if (
        req.method === "POST" &&
        (pathname.startsWith("/v1/chat/completions") ||
          pathname.startsWith("/v1/responses") ||
          pathname.startsWith("/v1/messages"))
      ) {
        const st = await getVaultState(cfg.vaultId);
        if (st.tokensAvailable <= 0) {
          const msg =
            "RUNTIME BLOCKED — 0 tokens left. Burn some calories first, punk: " +
            walkUrl;
          sendJson(
            res,
            402,
            {
              type: "error",
              error: {
                message: msg,
                type: "walk_required_error",
                code: "walk_lazy_402",
                walk_url: walkUrl
              }
            },
            { "X-Runtime-Gate": "LOCKED" }
          );
          return;
        }

        const rawBodyBuf = await readBody(req);
        let parsedBody = null;
        try {
          parsedBody = JSON.parse(rawBodyBuf.toString("utf8") || "{}");
        } catch (_) {}

        const callerKey = extractCallerKey(req);
        const upstream = resolveUpstreamTarget(pathname, reqUrl.search, callerKey);

        if (!upstream.key) {
          const used = Math.min(st.tokensAvailable, 80);
          const after = await recordTokenBurn(cfg.vaultId, used, st);
          sendKeylessDemoResponse(res, pathname, parsedBody, used, after.tokensAvailable);
          return;
        }

        if (parsedBody && typeof parsedBody === "object") {
          clampExplicitMaxTokens(pathname, parsedBody, st.tokensAvailable);
        }

        const headers = buildUpstreamHeaders(req, upstream);
        const outBody =
          parsedBody && typeof parsedBody === "object"
            ? JSON.stringify(parsedBody)
            : rawBodyBuf;

        const upRes = await fetch(upstream.url, {
          method: "POST",
          headers,
          body: outBody
        });

        const contentType = upRes.headers.get("content-type") || "application/json";
        const isSse = contentType.toLowerCase().includes("text/event-stream");

        if (isSse && upRes.body) {
          res.writeHead(upRes.status, {
            "Content-Type": contentType,
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
                });
          let sseTranscript = "";
          const decoder = new TextDecoder();
          try {
            for await (const chunk of upRes.body) {
              const buf = Buffer.from(chunk);
              res.write(buf);
              if (sseTranscript.length < 524288) {
                sseTranscript += decoder.decode(buf, { stream: true });
              }
            }
            sseTranscript += decoder.decode();
          } finally {
            res.end();
          }
          if (upRes.ok) {
            const burned = Math.min(st.tokensAvailable, extractSseStats(sseTranscript));
            await recordTokenBurn(cfg.vaultId, burned, st).catch(() => {});
          }
          return;
        }

        const respBuf = Buffer.from(await upRes.arrayBuffer());
        let burned = Math.min(st.tokensAvailable, Math.max(16, Math.ceil(respBuf.length / 4)));
        try {
          const j = JSON.parse(respBuf.toString("utf8"));
          if (j && j.usage) {
            burned = Number(
              j.usage.total_tokens ||
                Number(j.usage.input_tokens || j.usage.prompt_tokens || 0) +
                  Number(j.usage.output_tokens || j.usage.completion_tokens || 0) ||
                burned
            );
          }
        } catch (_) {}

        if (upRes.ok) {
          await recordTokenBurn(cfg.vaultId, Math.min(st.tokensAvailable, burned), st).catch(
            () => {}
          );
        }
        res.writeHead(upRes.status, {
          "Content-Type": contentType,
            });
        res.end(respBuf);
        return;
      }

      sendJson(res, 404, { error: "Unknown route" });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: String(err && err.message ? err.message : err) });
      } else {
        try {
          res.end();
        } catch (_) {}
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(cfg.port, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, walkUrl });
    });
  });
}

function runMcpServer(cfg) {
  const walkUrl = buildWalkUrl(cfg);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const reply = (id, result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      return;
    }
    if (msg.id === undefined) return;
    try {
      if (msg.method === "initialize") {
        reply(msg.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "runtime-step-gate", version: "3.1.0" }
        });
      } else if (msg.method === "tools/list") {
        reply(msg.id, {
          tools: [
            {
              name: "runtime_status",
              description: "Check remaining walked steps and tokens.",
              inputSchema: { type: "object", properties: {} }
            },
            {
              name: "runtime_burn_tokens",
              description: "Burn exercise-gated tokens before coding. Fails at 0 tokens.",
              inputSchema: {
                type: "object",
                properties: { tokens: { type: "number" } },
                required: ["tokens"]
              }
            }
          ]
        });
      } else if (msg.method === "tools/call") {
        const name = msg.params && msg.params.name;
        const args = (msg.params && msg.params.arguments) || {};
        const st = await getVaultState(cfg.vaultId);
        if (name === "runtime_status") {
          reply(msg.id, {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  stepsTotal: st.stepsTotal,
                  tokensAvailable: st.tokensAvailable,
                  locked: st.tokensAvailable <= 0,
                  walkUrl
                })
              }
            ]
          });
        } else if (name === "runtime_burn_tokens") {
          if (st.tokensAvailable <= 0) {
            reply(msg.id, {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "RUNTIME BLOCKED — 0 tokens left. Go walk: " + walkUrl
                }
              ]
            });
          } else {
            const after = await recordTokenBurn(cfg.vaultId, Number(args.tokens || 100), st);
            reply(msg.id, {
              content: [{ type: "text", text: "Burned tokens. Remaining: " + after.tokensAvailable }]
            });
          }
        }
      } else {
        reply(msg.id, {});
      }
    } catch (e) {
      reply(msg.id, { isError: true, content: [{ type: "text", text: String(e.message || e) }] });
    }
  });
}

function printCliHelp() {
  console.log("RUNTIME — Local Agent Blocker & Live Fitness Sync");
  console.log("");
  console.log("Agent Blocker:");
  console.log("  node gate.js --install <auto|antigravity|claude|cursor|codex> --vault <ID> [--ft <TOKEN>]");
  console.log("  node gate.js --status [--vault <ID>]");
  console.log("  node gate.js --uninstall [antigravity|claude|cursor|codex]");
  console.log("");
  console.log("Live Fitness Connections (WHOOP v2, Fitbit / Google Health v4, Strava v3):");
  console.log("  node gate.js --connect <whoop|fitbit|strava> [--vault <ID>]");
  console.log("  node gate.js --sync [--vault <ID>]");
  console.log("  node gate.js --bridge [--vault <ID>] [--bridge-port 8765]");
  console.log("  node gate.js --disconnect [whoop|fitbit|strava|all]");
  console.log("");
  console.log("Proxy / MCP:");
  console.log("  node gate.js --vault <ID> [--port 4402]   (localhost OpenAI/Anthropic HTTP proxy)");
  console.log("  node gate.js --vault <ID> --mcp           (JSON-RPC stdio MCP server)");
}

/* ==========================================================================
 * Live Fitness Connectors (WHOOP v2, Fitbit / Google Health v4, Strava v3)
 * Tokens and client credentials stay strictly in ~/.runtime/fitness.json (0600)
 * and are NEVER uploaded to Cloud Firestore.
 * ========================================================================== */
function getFitnessConfigPath() {
  return path.join(os.homedir(), ".runtime", "fitness.json");
}

function readFitnessStore() {
  const fp = getFitnessConfigPath();
  if (!fs.existsSync(fp)) return { providers: {}, lastAutoSyncAt: 0 };
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (parsed && typeof parsed === "object") {
      if (!parsed.providers || typeof parsed.providers !== "object") parsed.providers = {};
      return parsed;
    }
  } catch (_) {}
  return { providers: {}, lastAutoSyncAt: 0 };
}

function writeFitnessStore(store) {
  const fp = getFitnessConfigPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, fp);
  try {
    fs.chmodSync(fp, 0o600);
  } catch (_) {}
}

function normalizeProviderKey(raw) {
  const s = String(raw || "whoop").toLowerCase().trim();
  if (s === "whoop") return "whoop";
  if (s === "fitbit" || s === "google" || s === "google-health" || s === "google_health") {
    return "google";
  }
  if (s === "strava") return "strava";
  throw new Error("Unsupported fitness provider '" + raw + "' (choose whoop, fitbit, or strava)");
}

function summarizeConnectedFitness() {
  const store = readFitnessStore();
  const entries = [];
  for (const [k, v] of Object.entries(store.providers || {})) {
    if (v && (v.accessToken || v.refreshToken)) {
      const label = k === "google" ? "fitbit/google-health" : k;
      const stepsTxt = typeof v.lastSteps === "number" ? `${v.lastSteps.toLocaleString("en-US")} steps` : "linked";
      const extra = k === "whoop" && typeof v.lastStrain === "number" ? ` · ${v.lastStrain.toFixed(1)} strain` : "";
      entries.push(`${label} (${stepsTxt}${extra})`);
    }
  }
  return entries.length
    ? entries.join(", ")
    : "none linked (run: node ~/.runtime/gate.js --connect whoop)";
}

function localTodayParts() {
  const d = new Date();
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const iso =
    String(year) +
    "-" +
    String(month).padStart(2, "0") +
    "-" +
    String(day).padStart(2, "0");
  const next = new Date(year, d.getMonth(), day + 1);
  const startMidnightSec = Math.floor(new Date(year, d.getMonth(), day, 0, 0, 0, 0).getTime() / 1000);
  return {
    iso,
    year,
    month,
    day,
    nextYear: next.getFullYear(),
    nextMonth: next.getMonth() + 1,
    nextDay: next.getDate(),
    startMidnightSec,
    startMidnightMs: startMidnightSec * 1000
  };
}

function pruneSyncMapLocal(map) {
  const out = {};
  if (!map || typeof map !== "object") return out;
  const keys = Object.keys(map).sort().slice(-30);
  for (const k of keys) {
    const v = Math.max(0, Math.floor(Number(map[k]) || 0));
    if (v > 0) out[k] = v;
  }
  return out;
}

async function syncDailyStepsToVault(vaultId, ft, totalTodaySteps, source) {
  const cleanId = validateSafeToken(vaultId, "vault ID", false);
  const reported = Math.max(0, Math.min(250000, Math.round(Number(totalTodaySteps) || 0)));
  const cleanSource = String(source || "whoop_api").toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const dayKey = localTodayParts().iso + ":" + cleanSource;

  const cur = await getVaultState(cleanId);
  if (cur.fieldTokenHash) {
    const candidate = ft
      ? crypto.createHash("sha256").update(String(ft), "utf8").digest("hex")
      : "";
    if (ft && candidate !== cur.fieldTokenHash) {
      throw new Error("Field token mismatch for vault " + cleanId);
    }
  }

  let syncMap = {};
  try {
    syncMap = pruneSyncMapLocal(JSON.parse(cur.dailySyncJson || "{}"));
  } catch (_) {}

  const prevSynced = Math.max(0, Math.floor(Number(syncMap[dayKey]) || 0));
  const delta = Math.max(0, reported - prevSynced);
  syncMap[dayKey] = Math.max(prevSynced, reported);

  const nextStepsTotal = cur.stepsTotal + delta;
  const rate = Math.max(1, cur.tokensPerStep || 25);
  const tokensEarned = nextStepsTotal * rate;
  const tokensAvailable = Math.max(0, tokensEarned - cur.tokensBurned);
  const nextDevices = Array.from(new Set([].concat(cur.devices || [], [cleanSource])));

  const updated = await patchVaultState(cleanId, {
    stepsTotal: nextStepsTotal,
    tokensEarned,
    tokensAvailable,
    devices: nextDevices,
    dailySyncJson: JSON.stringify(syncMap),
    updatedAt: Date.now()
  });

  return {
    vaultState: updated,
    reportedToday: reported,
    stepsAdded: delta,
    stepsTotal: updated.stepsTotal,
    tokensAvailable: updated.tokensAvailable
  };
}

function openUrlInBrowser(url) {
  try {
    const plat = process.platform;
    if (plat === "darwin") {
      const p = spawn("open", [url], { detached: true, stdio: "ignore" });
      p.unref();
    } else if (plat === "win32") {
      const p = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
      p.unref();
    } else {
      const p = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
      p.unref();
    }
  } catch (_) {}
}

function promptQuestion(rl, query) {
  return new Promise((resolve) => rl.question(query, (ans) => resolve(String(ans || "").trim())));
}

async function ensureProviderCredentials(provider, cfg, store) {
  const existing = (store.providers && store.providers[provider]) || {};
  const envPrefix = provider === "google" ? "GOOGLE" : provider.toUpperCase();
  let clientId = String(cfg.clientId || process.env[envPrefix + "_CLIENT_ID"] || existing.clientId || "").trim();
  let clientSecret = String(
    cfg.clientSecret || process.env[envPrefix + "_CLIENT_SECRET"] || existing.clientSecret || ""
  ).trim();

  if (clientId && (provider === "google" || clientSecret)) {
    return { clientId, clientSecret };
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      `Missing ${provider.toUpperCase()} OAuth credentials. Pass --client-id / --client-secret or run interactively in a terminal.`
    );
  }

  const callbackUrl = `http://127.0.0.1:${cfg.bridgePort || 8765}/callback`;
  console.log("");
  if (provider === "whoop") {
    console.log("WHOOP Official API Setup (one-time, takes ~30 seconds):");
    console.log("  1. Open https://developer-dashboard.whoop.com and create a personal App");
    console.log("  2. Add this Redirect URL: " + callbackUrl);
    console.log("  3. Copy your Client ID and Client Secret below:");
  } else if (provider === "strava") {
    console.log("Strava API Setup (one-time, also pulls synced WHOOP / Garmin / Watch workouts):");
    console.log("  1. Open https://www.strava.com/settings/api");
    console.log("  2. Set Authorization Callback Domain to: 127.0.0.1");
    console.log("  3. Copy your Client ID and Client Secret below:");
  } else {
    console.log("Fitbit & Google Health v4 API Setup (one-time):");
    console.log("  1. Open https://console.cloud.google.com/apis/credentials (enable Google Health API)");
    console.log("  2. Create OAuth Client ID (Web or Desktop) with Redirect URI: " + callbackUrl);
    console.log("  3. Copy your Client ID (and Client Secret if issued) below:");
  }
  console.log("");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!clientId) {
      clientId = await promptQuestion(rl, "  Client ID     : ");
    }
    if (!clientSecret) {
      const label = provider === "google" ? "  Client Secret (optional for Desktop PKCE): " : "  Client Secret : ";
      clientSecret = await promptQuestion(rl, label);
    }
  } finally {
    rl.close();
  }

  if (!clientId || (provider !== "google" && !clientSecret)) {
    throw new Error("Client ID and Client Secret are required to authorize " + provider.toUpperCase());
  }
  return { clientId, clientSecret };
}

function buildPkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function buildProviderAuthUrl(provider, clientId, redirectUri, state, pkceChallenge) {
  if (provider === "whoop") {
    const u = new URL("https://api.prod.whoop.com/oauth/oauth2/auth");
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "offline read:cycles read:workout");
    u.searchParams.set("state", state);
    return u.toString();
  }
  if (provider === "strava") {
    const u = new URL("https://www.strava.com/oauth/authorize");
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("approval_prompt", "auto");
    u.searchParams.set("scope", "activity:read_all");
    u.searchParams.set("state", state);
    return u.toString();
  }
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("code_challenge", pkceChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set(
    "scope",
    "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly"
  );
  u.searchParams.set("state", state);
  return u.toString();
}

async function exchangeProviderCode(provider, code, creds, redirectUri, pkceVerifier, timeoutMs = 8000) {
  if (provider === "whoop") {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: redirectUri
    });
    const r = await fetchWithTimeout(
      "https://api.prod.whoop.com/oauth/oauth2/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
      },
      timeoutMs
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      throw new Error("WHOOP token exchange failed (" + r.status + "): " + (j.error_description || j.error || "check Client ID/Secret & Redirect URL"));
    }
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token || "",
      expiresAt: Date.now() + Number(j.expires_in || 3600) * 1000
    };
  }

  if (provider === "strava") {
    const r = await fetchWithTimeout(
      "https://www.strava.com/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          code,
          grant_type: "authorization_code"
        })
      },
      timeoutMs
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      throw new Error("Strava token exchange failed (" + r.status + "): " + (j.message || "check Client ID/Secret"));
    }
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token || "",
      expiresAt: j.expires_at ? Number(j.expires_at) * 1000 : Date.now() + Number(j.expires_in || 3600) * 1000
    };
  }

  const params = {
    grant_type: "authorization_code",
    code,
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    code_verifier: pkceVerifier
  };
  if (creds.clientSecret) params.client_secret = creds.clientSecret;
  const r = await fetchWithTimeout(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString()
    },
    timeoutMs
  );
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error("Google Health token exchange failed (" + r.status + "): " + (j.error_description || j.error || "check credentials"));
  }
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token || "",
    expiresAt: Date.now() + Number(j.expires_in || 3600) * 1000
  };
}

async function ensureFreshAccessToken(provider, entry, store, timeoutMs = 4500) {
  if (!entry) throw new Error(provider + " is not connected");
  const now = Date.now();
  if (entry.accessToken && entry.expiresAt && now < Number(entry.expiresAt) - 60000) {
    return entry.accessToken;
  }
  if (!entry.refreshToken) {
    if (entry.accessToken) return entry.accessToken;
    throw new Error(provider + " session expired -- reconnect with --connect " + provider);
  }

  if (provider === "whoop") {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: entry.refreshToken,
      client_id: entry.clientId,
      client_secret: entry.clientSecret,
      scope: "offline"
    });
    const r = await fetchWithTimeout(
      "https://api.prod.whoop.com/oauth/oauth2/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
      },
      timeoutMs
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      throw new Error("WHOOP token refresh HTTP " + r.status);
    }
    entry.accessToken = j.access_token;
    if (j.refresh_token) entry.refreshToken = j.refresh_token;
    entry.expiresAt = Date.now() + Number(j.expires_in || 3600) * 1000;
    store.providers[provider] = entry;
    writeFitnessStore(store);
    return entry.accessToken;
  }

  if (provider === "strava") {
    const r = await fetchWithTimeout(
      "https://www.strava.com/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: entry.clientId,
          client_secret: entry.clientSecret,
          refresh_token: entry.refreshToken,
          grant_type: "refresh_token"
        })
      },
      timeoutMs
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      throw new Error("Strava token refresh HTTP " + r.status);
    }
    entry.accessToken = j.access_token;
    if (j.refresh_token) entry.refreshToken = j.refresh_token;
    entry.expiresAt = j.expires_at ? Number(j.expires_at) * 1000 : Date.now() + Number(j.expires_in || 3600) * 1000;
    store.providers[provider] = entry;
    writeFitnessStore(store);
    return entry.accessToken;
  }

  const params = {
    grant_type: "refresh_token",
    refresh_token: entry.refreshToken,
    client_id: entry.clientId
  };
  if (entry.clientSecret) params.client_secret = entry.clientSecret;
  const r = await fetchWithTimeout(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString()
    },
    timeoutMs
  );
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error("Google Health token refresh HTTP " + r.status);
  }
  entry.accessToken = j.access_token;
  if (j.refresh_token) entry.refreshToken = j.refresh_token;
  entry.expiresAt = Date.now() + Number(j.expires_in || 3600) * 1000;
  store.providers[provider] = entry;
  writeFitnessStore(store);
  return entry.accessToken;
}

async function fetchTodayProviderMetrics(provider, accessToken, timeoutMs = 4500) {
  const today = localTodayParts();

  if (provider === "whoop") {
    const [cycRes, wkRes] = await Promise.all([
      fetchWithTimeout(
        "https://api.prod.whoop.com/developer/v2/cycle?limit=3",
        { headers: { Authorization: "Bearer " + accessToken } },
        timeoutMs
      ),
      fetchWithTimeout(
        "https://api.prod.whoop.com/developer/v2/activity/workout?limit=12",
        { headers: { Authorization: "Bearer " + accessToken } },
        timeoutMs
      ).catch(() => null)
    ]);
    if (!cycRes.ok) throw new Error("WHOOP cycle API HTTP " + cycRes.status);
    const cycJson = await cycRes.json().catch(() => ({}));
    const records = Array.isArray(cycJson.records) ? cycJson.records : [];
    const currentCycle = records.find((c) => !c.end) || records[0] || null;
    const cycleSteps =
      currentCycle && typeof currentCycle.step_count === "number" && currentCycle.step_count > 0
        ? Math.round(currentCycle.step_count)
        : 0;
    const strain =
      currentCycle && currentCycle.score && typeof currentCycle.score.strain === "number"
        ? Number(currentCycle.score.strain)
        : 0;

    let allWorkoutKcal = 0;
    let nonStepWorkoutKcal = 0;
    if (wkRes && wkRes.ok) {
      const wkJson = await wkRes.json().catch(() => ({}));
      const wkRecords = Array.isArray(wkJson.records) ? wkJson.records : [];
      for (const w of wkRecords) {
        const startMs = w && w.start ? Date.parse(w.start) : 0;
        if (!startMs || startMs < today.startMidnightMs) continue;
        const kj = w.score && typeof w.score.kilojoule === "number" ? w.score.kilojoule : 0;
        const kcal = kj > 0 ? kj / 4.184 : 0;
        allWorkoutKcal += kcal;
        const sport = String(w.sport_name || "").toLowerCase();
        const isStepSport = /walk|run|hike|ruck|jog|treadmill/.test(sport);
        if (!isStepSport) nonStepWorkoutKcal += kcal;
      }
    }

    const reportedSteps = Math.max(
      cycleSteps + Math.round(nonStepWorkoutKcal * 20),
      Math.round(allWorkoutKcal * 20)
    );
    return {
      source: "whoop_api",
      stepsEquivalent: reportedSteps,
      rawSteps: cycleSteps,
      workoutCalories: Math.round(allWorkoutKcal),
      strain
    };
  }

  if (provider === "strava") {
    const r = await fetchWithTimeout(
      `https://www.strava.com/api/v3/athlete/activities?after=${today.startMidnightSec}&per_page=30`,
      { headers: { Authorization: "Bearer " + accessToken } },
      timeoutMs
    );
    if (!r.ok) throw new Error("Strava activities API HTTP " + r.status);
    const list = await r.json().catch(() => []);
    let totalStepsEq = 0;
    let totalKcal = 0;
    for (const act of Array.isArray(list) ? list : []) {
      const sport = String(act.sport_type || act.type || "").toLowerCase();
      const distM = Number(act.distance || 0);
      const kj = Number(act.kilojoules || 0);
      const cal = Number(act.calories || 0);
      const movingMin = Number(act.moving_time || 0) / 60;
      const avgHr = Number(act.average_heartrate || 0);
      let actSteps = 0;
      if (/walk|run|hike|trail/.test(sport) && distM > 0) {
        actSteps = Math.round(distM * 1.31);
      }
      const activeKcal =
        cal > 0
          ? cal
          : kj > 0
            ? kj
            : avgHr >= 95 && movingMin > 0
              ? Math.max(1, (avgHr - 80) * 0.14 * movingMin)
              : movingMin > 0 && !/walk|run|hike/.test(sport)
                ? movingMin * 5
                : 0;
      totalKcal += activeKcal;
      actSteps = Math.max(actSteps, Math.round(activeKcal * 20));
      totalStepsEq += actSteps;
    }
    return {
      source: "strava_api",
      stepsEquivalent: totalStepsEq,
      rawSteps: totalStepsEq,
      workoutCalories: Math.round(totalKcal),
      strain: 0
    };
  }

  // Google Health API v4 (Fitbit, Pixel Watch, Google Health)
  const rangeBody = JSON.stringify({
    windowSizeDays: 1,
    range: {
      start: { date: { year: today.year, month: today.month, day: today.day } },
      end: { date: { year: today.nextYear, month: today.nextMonth, day: today.nextDay } }
    }
  });
  const [stepsRes, calRes] = await Promise.all([
    fetchWithTimeout(
      "https://health.googleapis.com/v4/users/me/dataTypes/steps/dataPoints:dailyRollUp",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/json"
        },
        body: rangeBody
      },
      timeoutMs
    ),
    fetchWithTimeout(
      "https://health.googleapis.com/v4/users/me/dataTypes/active-energy-burned/dataPoints:dailyRollUp",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/json"
        },
        body: rangeBody
      },
      timeoutMs
    ).catch(() => null)
  ]);
  if (!stepsRes.ok) throw new Error("Google Health v4 steps API HTTP " + stepsRes.status);
  const stepsJson = await stepsRes.json().catch(() => ({}));
  const roll = Array.isArray(stepsJson.rollupDataPoints) ? stepsJson.rollupDataPoints[0] : null;
  const countSum = roll && roll.steps && roll.steps.countSum ? Number(roll.steps.countSum) : 0;

  let activeKcal = 0;
  if (calRes && calRes.ok) {
    const calJson = await calRes.json().catch(() => ({}));
    const calRoll = Array.isArray(calJson.rollupDataPoints) ? calJson.rollupDataPoints[0] : null;
    if (calRoll && calRoll.activeEnergyBurned && typeof calRoll.activeEnergyBurned.kcalSum === "number") {
      activeKcal = calRoll.activeEnergyBurned.kcalSum;
    }
  }
  const stepsEq = Math.max(Math.round(countSum), Math.round(activeKcal * 20));
  return {
    source: "google_health",
    stepsEquivalent: stepsEq,
    rawSteps: Math.round(countSum),
    workoutCalories: Math.round(activeKcal),
    strain: 0
  };
}

async function syncAllConnectedFitness(cfg, opts = {}) {
  const store = readFitnessStore();
  const providers = Object.keys(store.providers || {}).filter((k) => {
    const p = store.providers[k];
    return p && (p.accessToken || p.refreshToken);
  });
  if (providers.length === 0) {
    return { synced: false, results: [], vaultState: null };
  }

  const timeoutMs = opts.timeoutMs || 5000;
  const results = [];
  let latestVaultState = null;

  for (const prov of providers) {
    try {
      const entry = store.providers[prov];
      const token = await ensureFreshAccessToken(prov, entry, store, timeoutMs);
      const metrics = await fetchTodayProviderMetrics(prov, token, timeoutMs);
      const syncOut = await syncDailyStepsToVault(
        cfg.vaultId,
        cfg.ft,
        metrics.stepsEquivalent,
        metrics.source
      );
      latestVaultState = syncOut.vaultState;
      entry.lastSteps = metrics.stepsEquivalent;
      entry.lastStrain = metrics.strain || 0;
      entry.lastCalories = metrics.workoutCalories || 0;
      entry.lastSyncAt = Date.now();
      store.providers[prov] = entry;
      results.push({
        provider: prov,
        ok: true,
        reportedToday: metrics.stepsEquivalent,
        stepsAdded: syncOut.stepsAdded,
        strain: metrics.strain || 0,
        workoutCalories: metrics.workoutCalories || 0
      });
    } catch (err) {
      results.push({
        provider: prov,
        ok: false,
        error: String(err && err.message ? err.message : err)
      });
    }
  }

  store.lastAutoSyncAt = Date.now();
  writeFitnessStore(store);
  return { synced: true, results, vaultState: latestVaultState };
}

async function autoSyncFitnessInHook(cfg, st) {
  const store = readFitnessStore();
  const hasAny = Object.values(store.providers || {}).some(
    (p) => p && (p.accessToken || p.refreshToken)
  );
  if (!hasAny) return null;
  const stale = Date.now() - Number(store.lastAutoSyncAt || 0) > 180000;
  if (st.tokensAvailable > 0 && !stale) return null;
  const out = await syncAllConnectedFitness(cfg, { timeoutMs: 2600 });
  return out && out.vaultState ? out.vaultState : null;
}

async function connectFitnessProviderInteractive(cfg) {
  const provider = normalizeProviderKey(cfg.target || "whoop");
  const store = readFitnessStore();
  const creds = await ensureProviderCredentials(provider, cfg, store);
  const port = Number(cfg.bridgePort || 8765);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const state = crypto.randomBytes(8).toString("hex");
  const pkce = buildPkcePair();
  const authUrl = buildProviderAuthUrl(provider, creds.clientId, redirectUri, state, pkce.challenge);

  const codePromise = new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      try {
        const u = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        if (u.pathname !== "/callback") {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }
        const errParam = u.searchParams.get("error");
        const gotState = u.searchParams.get("state");
        const code = u.searchParams.get("code");
        if (errParam) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h2>Authorization cancelled</h2><p>Return to your terminal.</p>");
          srv.close();
          reject(new Error("Authorization denied: " + errParam));
          return;
        }
        if (!code || gotState !== state) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h2>Invalid callback state</h2><p>Return to your terminal and try again.</p>");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<!doctype html><html><body style='background:#000;color:#ff3b14;font-family:monospace;padding:40px;text-align:center'>" +
            "<h1>RUNTIME CONNECTED</h1><p>Live fitness sync is active. You can close this tab.</p></body></html>"
        );
        srv.close();
        resolve(code);
      } catch (e) {
        srv.close();
        reject(e);
      }
    });
    srv.on("error", (err) => {
      reject(
        new Error(
          `Could not listen on 127.0.0.1:${port} (${err.message}). Close any other process on port ${port} or pass --bridge-port.`
        )
      );
    });
    srv.listen(port, "127.0.0.1");
  });

  console.log("");
  console.log(`Opening ${provider.toUpperCase()} authorization in your browser...`);
  console.log(`If it doesn't open automatically, open this link:\n  ${authUrl}`);
  openUrlInBrowser(authUrl);

  const code = await codePromise;
  const tokens = await exchangeProviderCode(provider, code, creds, redirectUri, pkce.verifier);
  store.providers[provider] = {
    clientId: creds.clientId,
    clientSecret: creds.clientSecret || "",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || "",
    expiresAt: tokens.expiresAt,
    connectedAt: Date.now()
  };
  writeFitnessStore(store);

  const out = await syncAllConnectedFitness(cfg, { timeoutMs: 8000 });
  const r = (out.results || []).find((x) => x.provider === provider) || {};
  console.log("");
  console.log("┌──────────────────────────────────────────────────────────────┐");
  console.log(`│ RUNTIME -- ${provider.toUpperCase()} LIVE SYNC CONNECTED`.padEnd(63, " ") + "│");
  console.log("├──────────────────────────────────────────────────────────────┤");
  if (r.ok) {
    console.log(`  Today     : ${(r.reportedToday || 0).toLocaleString("en-US")} steps equivalent (+${(r.stepsAdded || 0).toLocaleString("en-US")} newly unlocked)`);
    if (r.strain) console.log(`  Strain    : ${r.strain.toFixed(1)}`);
  } else if (r.error) {
    console.log(`  Sync note : ${r.error}`);
  }
  console.log(`  Auto-sync : Pulls fresh data automatically when you prompt your AI`);
  console.log(`  Manual    : node ~/.runtime/gate.js --sync`);
  console.log(`  Web UI    : node ~/.runtime/gate.js --bridge`);
  console.log("└──────────────────────────────────────────────────────────────┘");
}

function disconnectFitnessProvider(target) {
  const store = readFitnessStore();
  const clean = String(target || "all").toLowerCase().trim();
  if (!clean || clean === "all") {
    store.providers = {};
    writeFitnessStore(store);
    console.log("Disconnected all saved fitness accounts from ~/.runtime/fitness.json.");
    return;
  }
  const prov = normalizeProviderKey(clean);
  if (store.providers) delete store.providers[prov];
  writeFitnessStore(store);
  console.log(`Disconnected ${prov} from ~/.runtime/fitness.json.`);
}

async function startFitnessBridgeServer(cfg) {
  const port =
    cfg.bridgePort !== undefined && cfg.bridgePort !== null && !Number.isNaN(Number(cfg.bridgePort))
      ? Number(cfg.bridgePort)
      : 8765;
  let pendingOAuth = null;

  const setCors = (req, res) => {
    const origin = String(req.headers.origin || "*");
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  };

  const isTrustedBrowserOrigin = (origin) => {
    if (!origin) return true;
    return (
      origin === "https://runtime.jackcolley.com" ||
      origin === "https://runtime-jackcolley.web.app" ||
      /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
    );
  };

  const server = http.createServer(async (req, res) => {
    setCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const u = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    if (req.method === "GET" && u.pathname === "/status") {
      const store = readFitnessStore();
      const pub = {};
      for (const [k, v] of Object.entries(store.providers || {})) {
        if (v && (v.accessToken || v.refreshToken)) {
          pub[k] = {
            connected: true,
            lastSteps: v.lastSteps || 0,
            lastStrain: v.lastStrain || 0,
            lastCalories: v.lastCalories || 0,
            lastSyncAt: v.lastSyncAt || 0
          };
        }
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, bridge: true, vaultId: cfg.vaultId, providers: pub }));
      return;
    }

    if (req.method === "POST" && u.pathname === "/sync") {
      if (!isTrustedBrowserOrigin(String(req.headers.origin || ""))) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Untrusted origin" }));
        return;
      }
      let bodyObj = {};
      try {
        const chunks = [];
        for await (const ch of req) chunks.push(ch);
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw.trim()) bodyObj = JSON.parse(raw);
      } catch (_) {}
      const syncCfg = Object.assign({}, cfg, {
        vaultId: bodyObj.vaultId ? validateSafeToken(bodyObj.vaultId, "vault ID", false) : cfg.vaultId,
        ft: bodyObj.ft ? validateSafeToken(bodyObj.ft, "field token", true) : cfg.ft
      });
      const out = await syncAllConnectedFitness(syncCfg, { timeoutMs: 7000 });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          synced: out.synced,
          results: out.results,
          stepsTotal: out.vaultState ? out.vaultState.stepsTotal : undefined,
          tokensAvailable: out.vaultState ? out.vaultState.tokensAvailable : undefined
        })
      );
      return;
    }

    if (req.method === "POST" && u.pathname === "/connect") {
      if (!isTrustedBrowserOrigin(String(req.headers.origin || ""))) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Untrusted origin" }));
        return;
      }
      try {
        const chunks = [];
        for await (const ch of req) chunks.push(ch);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const provider = normalizeProviderKey(body.provider || "whoop");
        const store = readFitnessStore();
        const prev = (store.providers && store.providers[provider]) || {};
        const clientId = String(body.clientId || prev.clientId || "").trim();
        const clientSecret = String(body.clientSecret || prev.clientSecret || "").trim();
        if (!clientId || (provider !== "google" && !clientSecret)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, needsCredentials: true, callbackUrl: `http://127.0.0.1:${port}/callback` }));
          return;
        }
        const redirectUri = `http://127.0.0.1:${port}/callback`;
        const state = crypto.randomBytes(8).toString("hex");
        const pkce = buildPkcePair();
        pendingOAuth = {
          provider,
          clientId,
          clientSecret,
          redirectUri,
          state,
          pkceVerifier: pkce.verifier,
          vaultId: body.vaultId ? validateSafeToken(body.vaultId, "vault ID", false) : cfg.vaultId,
          ft: body.ft ? validateSafeToken(body.ft, "field token", true) : cfg.ft,
          returnOrigin: isTrustedBrowserOrigin(String(req.headers.origin || ""))
            ? String(req.headers.origin || DEFAULT_ORIGIN)
            : DEFAULT_ORIGIN
        };
        const authUrl = buildProviderAuthUrl(provider, clientId, redirectUri, state, pkce.challenge);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, authUrl }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
      }
      return;
    }

    if (req.method === "GET" && u.pathname === "/callback") {
      if (!pendingOAuth) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("No active OAuth request.");
        return;
      }
      const code = u.searchParams.get("code");
      const gotState = u.searchParams.get("state");
      if (!code || gotState !== pendingOAuth.state) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid OAuth callback state.");
        return;
      }
      try {
        const cur = pendingOAuth;
        pendingOAuth = null;
        const tokens = await exchangeProviderCode(
          cur.provider,
          code,
          { clientId: cur.clientId, clientSecret: cur.clientSecret },
          cur.redirectUri,
          cur.pkceVerifier
        );
        const store = readFitnessStore();
        store.providers[cur.provider] = {
          clientId: cur.clientId,
          clientSecret: cur.clientSecret,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken || "",
          expiresAt: tokens.expiresAt,
          connectedAt: Date.now()
        };
        writeFitnessStore(store);
        await syncAllConnectedFitness(
          Object.assign({}, cfg, { vaultId: cur.vaultId, ft: cur.ft }),
          { timeoutMs: 7000 }
        );
        res.writeHead(302, { Location: cur.returnOrigin.replace(/\/+$/, "") + "/?bridge_synced=" + cur.provider + "#walk" });
        res.end();
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("OAuth error: " + String(err.message || err));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Not found" }));
  });

  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  // Auto-sync every 5 minutes in background while bridge runs
  const timer = setInterval(() => {
    syncAllConnectedFitness(cfg, { timeoutMs: 6000 }).catch(() => {});
  }, 300000);
  if (typeof timer.unref === "function") timer.unref();

  const boundPort = server.address() && server.address().port ? server.address().port : port;
  console.log(`RUNTIME local fitness bridge active on http://127.0.0.1:${boundPort} (Vault: ${cfg.vaultId})`);
  console.log(`Connected: ${summarizeConnectedFitness()}`);
  return { server, port: boundPort };
}

async function main() {
  const cfg = parseArgs(process.argv);
  if (cfg.mode === "help") {
    printCliHelp();
    return;
  }
  if (cfg.mode === "hook") {
    await runIdeHook(cfg);
    return;
  }
  if (cfg.mode === "install") {
    await installIdeHook(cfg);
    return;
  }
  if (cfg.mode === "status") {
    await printVaultStatus(cfg);
    return;
  }
  if (cfg.mode === "uninstall") {
    uninstallIdeHooks(cfg.target);
    return;
  }
  if (cfg.mode === "connect") {
    await connectFitnessProviderInteractive(cfg);
    return;
  }
  if (cfg.mode === "disconnect") {
    disconnectFitnessProvider(cfg.target);
    return;
  }
  if (cfg.mode === "sync") {
    const out = await syncAllConnectedFitness(cfg, { timeoutMs: 8000 });
    if (!out.synced) {
      console.log("No fitness accounts linked yet. Run: node ~/.runtime/gate.js --connect whoop");
      return;
    }
    for (const r of out.results) {
      if (r.ok) {
        console.log(
          `SYNCED ${r.provider.toUpperCase()}: ${r.reportedToday.toLocaleString("en-US")} steps today (+${r.stepsAdded.toLocaleString("en-US")} newly unlocked)`
        );
      } else {
        console.error(`SYNC ERROR (${r.provider}): ${r.error}`);
      }
    }
    return;
  }
  if (cfg.mode === "bridge") {
    await startFitnessBridgeServer(cfg);
    return;
  }
  if (cfg.mode === "mcp") {
    runMcpServer(cfg);
    return;
  }

  if (cfg.mode === "codex" || cfg.mode === "claude") {
    const st = await getVaultState(cfg.vaultId);
    const walkUrl = buildWalkUrl(cfg);
    if (st.tokensAvailable <= 0) {
      console.error(
        "RUNTIME BLOCKED (0 TOKENS / " +
          st.stepsTotal.toLocaleString("en-US") +
          " STEPS WALKED). Burn some calories first, punk! Walk -> " +
          walkUrl
      );
      process.exit(2);
    }

    const bin = cfg.mode === "codex" ? "codex" : "claude";
    const needsProxy =
      (cfg.mode === "codex" && Boolean(process.env.OPENAI_API_KEY)) ||
      (cfg.mode === "claude" && Boolean(process.env.ANTHROPIC_API_KEY));
    const env = Object.assign({}, process.env);

    let proxyServer = null;
    if (needsProxy) {
      const started = await startProxyServer(Object.assign({}, cfg, { port: 0 }));
      proxyServer = started.server;
      const baseUrl = "http://127.0.0.1:" + started.port;
      if (cfg.mode === "codex") env.OPENAI_BASE_URL = baseUrl + "/v1";
      if (cfg.mode === "claude") env.ANTHROPIC_BASE_URL = baseUrl;
    }

    const child = spawn(bin, cfg.extraArgs, { stdio: "inherit", env });
    child.on("error", (err) => {
      if (proxyServer) proxyServer.close();
      console.error(`RUNTIME gate error: could not launch '${bin}' (${err.message || err})`);
      process.exit(127);
    });
    child.on("spawn", () => {
      if (!needsProxy) {
        recordTokenBurn(cfg.vaultId, cfg.cost || 2500, st).catch(() => {});
      }
    });
    child.on("exit", (code) => {
      if (proxyServer) proxyServer.close();
      process.exit(code || 0);
    });
    return;
  }

  const { port, walkUrl } = await startProxyServer(cfg);
  const baseUrl = "http://127.0.0.1:" + port;
  console.error(
    "RUNTIME proxy ready — Vault: " +
      cfg.vaultId +
      " // " +
      baseUrl +
      " // Walk: " +
      walkUrl
  );
}

if (require.main === module || module.id === "[stdin]") {
  main().catch((err) => {
    console.error("RUNTIME gate error:", err.message || err);
    process.exit(1);
  });
}

module.exports = {
  startProxyServer,
  startFitnessBridgeServer,
  syncAllConnectedFitness,
  fetchTodayProviderMetrics,
  parseArgs,
  installIdeHook,
  uninstallIdeHooks,
  printVaultStatus,
  stripJsonc,
  extractSseStats
};
