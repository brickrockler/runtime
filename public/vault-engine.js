/* ==========================================================================
 * RUNTIME v2 — STEPS == TOKENS Vault & Step Gate Engine (vault-engine.js)
 * Works identically on localhost/127.0.0.1 and production Firebase Hosting.
 * SECURITY INVARIANT: Raw upstream LLM API keys (sk-..., sk-ant-..., AIza...,
 * sk-or-...) stay strictly in browser localStorage ("rt_v2_secret_key" /
 * "rt_v2_or_minted") and are NEVER uploaded or persisted to Cloud Firestore.
 * ========================================================================== */
(function (root) {
  "use strict";

  const LS_STATE_KEY = "rt_v2_state";
  const LS_SECRET_KEY = "rt_v2_secret_key";
  const LS_OR_MINT_KEY = "rt_v2_or_minted";
  const COOKIE_VAULT_KEY = "rt_v2_vault";
  const COOKIE_MAX_AGE_SEC = 34560000; // 400 days (browser cap for 1st-party cookies)
  const FS_PROJECT = "ee-offsite-simulation";
  const FS_COLLECTION = "runtime_v2_vaults";
  const DEFAULT_PROD_ORIGIN = "https://runtime-jackcolley.web.app";
  const FS_BASE =
    "https://firestore.googleapis.com/v1/projects/" +
    FS_PROJECT +
    "/databases/(default)/documents";

  const DEFAULT_TOKENS_PER_STEP = 25; // STANDARD: 1,000 steps = 25,000 tokens (~10 turns) = $0.50
  const DEFAULT_INITIAL_STEPS = 0; // Start strictly at 0 steps, 0 tokens, $0.00 credit (isLocked: true)
  const TOKENS_PER_TURN_APPROX = 2500;
  const USD_PER_TOKEN = 0.00002; // $1.00 = 50,000 tokens | 2,500 tokens = 1 turn = $0.05
  const MIN_OR_LIMIT_USD = 0.0001; // OpenRouter requires positive numeric limit (> 0)
  const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  const DIFFICULTY_PRESETS = {
    easy: { id: "easy", label: "EASY", tokensPerStep: 50, usdPerStep: 0.001, usdPer1k: 1.0 },
    standard: { id: "standard", label: "STANDARD", tokensPerStep: 25, usdPerStep: 0.0005, usdPer1k: 0.5 },
    hardcore: { id: "hardcore", label: "HARDCORE", tokensPerStep: 5, usdPerStep: 0.0001, usdPer1k: 0.1 }
  };

  function inferDifficulty(rate) {
    const r = Math.round(Number(rate) || DEFAULT_TOKENS_PER_STEP);
    if (r === 50) return "easy";
    if (r === 25) return "standard";
    if (r === 5) return "hardcore";
    return "custom";
  }

  // Un-anchored patterns catch raw keys even if embedded inside JSON strings
  const SECRET_KEY_PATTERNS = [
    /sk-ant-[A-Za-z0-9_-]{8,}/,
    /sk-or-[A-Za-z0-9_-]{8,}/,
    /sk-[A-Za-z0-9_-]{12,}/,
    /AIza[A-Za-z0-9_-]{16,}/
  ];

  let pollTimer = null;
  let pollCallback = null;
  let visibilityBound = false;

  /* ---------------- Safe Storage Wrapper (Browser + Node Fallback) ---------------- */
  const memStore = {};
  function storageGet(key) {
    try {
      if (typeof localStorage !== "undefined" && localStorage) {
        return localStorage.getItem(key);
      }
    } catch (_) {}
    return Object.prototype.hasOwnProperty.call(memStore, key) ? memStore[key] : null;
  }

  function storageSet(key, val) {
    try {
      if (typeof localStorage !== "undefined" && localStorage) {
        localStorage.setItem(key, String(val));
        return;
      }
    } catch (_) {}
    memStore[key] = String(val);
  }

  function storageRemove(key) {
    try {
      if (typeof localStorage !== "undefined" && localStorage) {
        localStorage.removeItem(key);
        return;
      }
    } catch (_) {}
    delete memStore[key];
  }

  let persistRequested = false;
  function requestPersistentStorageOnce() {
    if (persistRequested) return;
    persistRequested = true;
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.storage &&
        typeof navigator.storage.persist === "function"
      ) {
        navigator.storage.persist().catch(() => {});
      }
    } catch (_) {}
  }

  // First-party cookie backup of non-secret vault identity (survives localStorage eviction; NEVER stores API keys)
  function cookieSetVaultBackup(st) {
    try {
      if (typeof document === "undefined" || typeof document.cookie !== "string" || !st || !st.vaultId) {
        return;
      }
      const v = sanitizeSafeId(st.vaultId, "");
      if (!v) return;
      const f = st.fieldToken ? sanitizeSafeId(st.fieldToken, "") : "";
      const sr = st.shortRand ? sanitizeSafeId(st.shortRand, "") : "";
      const payload = JSON.stringify({
        v,
        s: sr,
        f,
        p: st.isPaired ? 1 : 0,
        g: st.gatePath === "openrouter" || st.gatePath === "ide" ? st.gatePath : "",
        i: sanitizeSafeId(st.selectedIde || "auto", "antigravity"),
        a: st.gateActivated ? 1 : 0
      });
      if (looksLikeRawApiKey(payload)) return;
      const isHttps =
        typeof location !== "undefined" && location && location.protocol === "https:";
      const secureAttr = isHttps ? "; Secure" : "";
      document.cookie =
        COOKIE_VAULT_KEY +
        "=" +
        encodeURIComponent(payload) +
        "; Max-Age=" +
        COOKIE_MAX_AGE_SEC +
        "; Path=/; SameSite=Lax" +
        secureAttr;
    } catch (_) {}
  }

  function cookieGetVaultBackup() {
    try {
      if (typeof document === "undefined" || typeof document.cookie !== "string" || !document.cookie) {
        return null;
      }
      const parts = document.cookie.split(";");
      for (let idx = 0; idx < parts.length; idx++) {
        const seg = parts[idx].trim();
        if (seg.startsWith(COOKIE_VAULT_KEY + "=")) {
          const rawVal = decodeURIComponent(seg.slice(COOKIE_VAULT_KEY.length + 1));
          const parsed = JSON.parse(rawVal);
          if (!parsed || typeof parsed !== "object" || !parsed.v) return null;
          const v = sanitizeSafeId(parsed.v, "");
          if (!v) return null;
          return {
            vaultId: v,
            shortRand: parsed.s ? sanitizeSafeId(parsed.s, "") : undefined,
            fieldToken: parsed.f ? sanitizeSafeId(parsed.f, "") : "",
            isPaired: Boolean(parsed.p),
            gatePath: parsed.g === "openrouter" || parsed.g === "ide" ? parsed.g : "",
            selectedIde: sanitizeSafeId(parsed.i || "auto", "auto"),
            gateActivated: Boolean(parsed.a)
          };
        }
      }
    } catch (_) {}
    return null;
  }

  /* ---------------- Crypto & Hashing Helpers (HTTPS + HTTP LAN safe) ---------------- */
  function randHex(byteLen) {
    const arr = new Uint8Array(byteLen);
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < byteLen; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function sha256Fallback(ascii) {
    function rightRotate(value, amount) {
      return (value >>> amount) | (value << (32 - amount));
    }
    const mathPow = Math.pow;
    const maxWord = mathPow(2, 32);
    let result = "";
    const words = [];
    const asciiBitLength = ascii.length * 8;
    let hash = [];
    const k = [];
    let primeCounter = 0;
    const isComposite = {};
    for (let candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (let i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    ascii += "\x80";
    while ((ascii.length % 64) - 56) ascii += "\x00";
    for (let i = 0; i < ascii.length; i++) {
      const j = ascii.charCodeAt(i);
      words[i >> 2] |= j << (((3 - i) % 4) * 8);
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;
    for (let j = 0; j < words.length; ) {
      const w = words.slice(j, (j += 16));
      const oldHash = hash.slice(0);
      for (let i = 0; i < 64; i++) {
        const w15 = w[i - 15];
        const w2 = w[i - 2];
        const a = hash[0];
        const e = hash[4];
        const temp1 =
          hash[7] +
          (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
          ((e & hash[5]) ^ (~e & hash[6])) +
          k[i] +
          (w[i] =
            i < 16
              ? w[i]
              : (w[i - 16] +
                  (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) +
                  w[i - 7] +
                  (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) |
                0);
        const temp2 =
          (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) +
          ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
        hash.pop();
      }
      for (let i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (let i = 0; i < 8; i++) {
      for (let j = 3; j + 1; j--) {
        const b = (hash[i] >> (j * 8)) & 255;
        result += (b < 16 ? "0" : "") + b.toString(16);
      }
    }
    return result;
  }

  async function sha256Hex(input) {
    const str = String(input || "");
    try {
      if (
        typeof crypto !== "undefined" &&
        crypto.subtle &&
        typeof crypto.subtle.digest === "function" &&
        typeof TextEncoder !== "undefined"
      ) {
        const bytes = new TextEncoder().encode(str);
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(digest), (b) =>
          b.toString(16).padStart(2, "0")
        ).join("");
      }
    } catch (_) {}
    const utf8 = unescape(encodeURIComponent(str));
    return sha256Fallback(utf8);
  }

  /* ---------------- Firestore REST Value Marshalling + Secret Guard ---------------- */
  function looksLikeRawApiKey(val) {
    if (typeof val !== "string") return false;
    return SECRET_KEY_PATTERNS.some((re) => re.test(val));
  }

  function sanitizeSafeId(raw, fallback) {
    const cleaned = String(raw || "").trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    return SAFE_ID_RE.test(cleaned) ? cleaned : fallback;
  }

  // Strictly <= 15 canonical keys (firestore.rules enforces keys().size() <= 16)
  function sanitizeCloudObject(obj) {
    const clean = {};
    const allowedKeys = new Set([
      "vaultId",
      "stepsTotal",
      "tokensPerStep",
      "tokensEarned",
      "tokensBurned",
      "tokensAvailable",
      "turnsCompleted",
      "resetEpoch",
      "rateUpdatedAt",
      "devices",
      "dailySyncJson",
      "provider",
      "gatedKeyMask",
      "fieldTokenHash",
      "pairedAt",
      "updatedAt"
    ]);
    Object.keys(obj || {}).forEach((k) => {
      if (!allowedKeys.has(k)) return;
      const v = obj[k];
      if (v === undefined) return;
      if (looksLikeRawApiKey(v)) {
        throw new Error("SECURITY_BLOCK: Refusing to upload raw upstream API key to Firestore.");
      }
      if (Array.isArray(v)) {
        v.forEach((item) => {
          if (looksLikeRawApiKey(String(item || ""))) {
            throw new Error("SECURITY_BLOCK: Refusing to upload raw API key in array to Firestore.");
          }
        });
      }
      clean[k] = v;
    });
    return clean;
  }

  function toFsVal(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === "boolean") return { booleanValue: v };
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return { integerValue: "0" };
      return Number.isInteger(v)
        ? { integerValue: String(v) }
        : { doubleValue: v };
    }
    if (typeof v === "string") return { stringValue: v };
    if (Array.isArray(v)) {
      return { arrayValue: { values: v.map(toFsVal) } };
    }
    if (typeof v === "object") {
      const fields = {};
      Object.keys(v).forEach((k) => {
        if (v[k] !== undefined) fields[k] = toFsVal(v[k]);
      });
      return { mapValue: { fields } };
    }
    return { stringValue: String(v) };
  }

  function fromFsVal(fv) {
    if (!fv || typeof fv !== "object") return null;
    if ("stringValue" in fv) return fv.stringValue;
    if ("integerValue" in fv) return Number(fv.integerValue);
    if ("doubleValue" in fv) return Number(fv.doubleValue);
    if ("booleanValue" in fv) return Boolean(fv.booleanValue);
    if ("timestampValue" in fv) {
      const t = Date.parse(fv.timestampValue);
      return Number.isFinite(t) ? t : 0;
    }
    if ("nullValue" in fv) return null;
    if ("arrayValue" in fv) {
      return ((fv.arrayValue && fv.arrayValue.values) || []).map(fromFsVal);
    }
    if ("mapValue" in fv) {
      const out = {};
      const f = (fv.mapValue && fv.mapValue.fields) || {};
      Object.keys(f).forEach((k) => {
        out[k] = fromFsVal(f[k]);
      });
      return out;
    }
    return null;
  }

  function docToObj(doc) {
    if (!doc || !doc.fields) return null;
    const out = {};
    Object.keys(doc.fields).forEach((k) => {
      out[k] = fromFsVal(doc.fields[k]);
    });
    return out;
  }

  function intOr(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
  }

  function uniqueStrings(list) {
    const out = [];
    const seen = new Set();
    (Array.isArray(list) ? list : []).forEach((item) => {
      const s = String(item || "").trim();
      if (s && !seen.has(s) && !looksLikeRawApiKey(s)) {
        seen.add(s);
        out.push(s);
      }
    });
    return out;
  }

  function todayIsoLocal() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function pruneDailySyncMap(rawMap) {
    const out = {};
    if (!rawMap || typeof rawMap !== "object") return out;
    const todayPrefix = todayIsoLocal() + ":";
    Object.keys(rawMap).forEach((k) => {
      if (k.startsWith(todayPrefix)) {
        const v = intOr(rawMap[k], 0);
        if (v > 0) out[k] = v;
      }
    });
    return out;
  }

  function detectProvider(providerInput, rawKey) {
    const k = String(rawKey || "").trim();
    if (!k || k.toUpperCase() === "DEMO") return "demo";
    const explicit = String(providerInput || "auto").trim().toLowerCase();
    if (explicit && explicit !== "auto" && explicit !== "demo") {
      return explicit;
    }
    if (k.startsWith("sk-ant-")) return "anthropic";
    if (k.startsWith("AIza")) return "gemini";
    if (k.startsWith("sk-or-")) return "openrouter";
    if (k.startsWith("sk-")) return "openai";
    return "openai";
  }

  function maskSecretKey(rawKey) {
    const k = String(rawKey || "").trim();
    if (!k || k.toUpperCase() === "DEMO") return "";
    if (k.length <= 10) return k.slice(0, 3) + "••••" + k.slice(-2);
    return k.slice(0, 7) + "••••" + k.slice(-4);
  }

  function maskGatedKey(gk) {
    const s = String(gk || "").trim();
    if (!s) return "";
    if (s.length <= 14) return s;
    return s.slice(0, 12) + "..." + s.slice(-4);
  }

  function buildGatedKey(vaultId, shortRand) {
    const cleanId = String(vaultId || "").replace(/^vlt_/, "");
    return "rt_gate_" + cleanId + "_" + (shortRand || randHex(2));
  }

  function currentOrigin(override) {
    if (override) return String(override).replace(/\/+$/, "");
    if (
      typeof location !== "undefined" &&
      location &&
      location.origin &&
      location.origin !== "null" &&
      /^https?:\/\//.test(location.origin)
    ) {
      return String(location.origin).replace(/\/+$/, "");
    }
    return DEFAULT_PROD_ORIGIN;
  }

  function parsePairParams() {
    try {
      if (typeof location === "undefined" || !location) return null;
      const searchParams = new URLSearchParams(location.search || "");
      let pair = (searchParams.get("pair") || "").trim();
      let sync = (searchParams.get("sync") || "").trim();
      let ft = (searchParams.get("ft") || "").trim();
      let source = (searchParams.get("source") || "").trim();
      if (!pair && !sync && location.hash && location.hash.includes("?")) {
        const qIdx = location.hash.indexOf("?");
        const hashParams = new URLSearchParams(location.hash.slice(qIdx + 1));
        pair = (hashParams.get("pair") || "").trim();
        sync = (hashParams.get("sync") || "").trim();
        ft = ft || (hashParams.get("ft") || "").trim();
        source = source || (hashParams.get("source") || "").trim();
      }
      const targetVault = pair || sync;
      if (!targetVault || !SAFE_ID_RE.test(targetVault)) return null;
      return {
        vaultId: targetVault,
        fieldToken: SAFE_ID_RE.test(ft) ? ft : "",
        isSync: Boolean(sync && !pair),
        source: source || (pair ? "phone_qr" : "apple_health")
      };
    } catch (_) {
      return null;
    }
  }

  /* ---------------- OpenRouter Storage Helpers ---------------- */
  let lastSyncedOrLimit = -1;
  let lastSyncedOrDisabled = null;
  let orSyncChain = Promise.resolve(null);
  let orUsagePollPromise = null;
  let syncFromCloudPromise = null;

  function getMintedKeyInfo() {
    try {
      const raw = storageGet(LS_OR_MINT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.hash) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function writeMintedKeyInfoMerged(patch) {
    const cur = getMintedKeyInfo() || {};
    const merged = Object.assign({}, cur, patch || {});
    if (!merged.hash) return null;
    storageSet(LS_OR_MINT_KEY, JSON.stringify(merged));
    return merged;
  }

  (function seedSyncedOrCache() {
    const info = getMintedKeyInfo();
    if (info) {
      if (typeof info.limitUsd === "number" && Number.isFinite(info.limitUsd)) {
        lastSyncedOrLimit = info.limitUsd;
      }
      if (typeof info.disabled === "boolean") {
        lastSyncedOrDisabled = info.disabled;
      }
    }
  })();

  /* ---------------- Internal Vault State ---------------- */
  function createFreshState(overrides) {
    const ov = overrides || {};
    const vaultId = sanitizeSafeId(ov.vaultId, "vlt_" + randHex(8));
    const shortRand = ov.shortRand || randHex(2);
    const fieldToken =
      ov.fieldToken !== undefined ? String(ov.fieldToken) : "ft_" + randHex(8);
    return Object.assign(
      {
        vaultId,
        shortRand,
        gatedKey: buildGatedKey(vaultId, shortRand),
        fieldToken,
        fieldTokenHash: "",
        stepsTotal: DEFAULT_INITIAL_STEPS,
        tokensPerStep: DEFAULT_TOKENS_PER_STEP,
        tokensBurned: 0,
        turnsCompleted: 0,
        resetEpoch: 0,
        rateUpdatedAt: 0,
        devices: [],
        dailySyncMap: {},
        provider: "demo",
        gatePath: "",
        selectedIde: "auto",
        gateActivated: false,
        isConnected: false,
        isPaired: false,
        pairedAt: 0,
        updatedAt: Date.now()
      },
      ov,
      { vaultId, fieldToken }
    );
  }

  function loadLocalState() {
    try {
      const raw = storageGet(LS_STATE_KEY);
      if (!raw) {
        const cookieBackup = cookieGetVaultBackup();
        if (!cookieBackup) return null;
        return createFreshState({
          vaultId: cookieBackup.vaultId,
          shortRand: cookieBackup.shortRand || randHex(2),
          fieldToken: cookieBackup.fieldToken,
          isPaired: cookieBackup.isPaired,
          gatePath: cookieBackup.gatePath,
          selectedIde: cookieBackup.selectedIde,
          gateActivated: cookieBackup.gateActivated
        });
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.vaultId) return null;
      const vaultId = sanitizeSafeId(parsed.vaultId, "");
      if (!vaultId) return null;
      const shortRand = parsed.shortRand || randHex(2);
      const savedKey = getRawSecretKey();
      const provider = savedKey ? detectProvider(parsed.provider, savedKey) : "demo";
      const rawRate = intOr(parsed.tokensPerStep, DEFAULT_TOKENS_PER_STEP);
      const rateUpdatedAt = intOr(parsed.rateUpdatedAt, 0);
      const migratedRate =
        rawRate === 10 && rateUpdatedAt === 0
          ? DEFAULT_TOKENS_PER_STEP
          : Math.max(1, rawRate);
      const isPaired = Boolean(parsed.isPaired);
      // Do NOT fabricate a random fieldToken on a paired device if originally paired without ft
      const fieldToken =
        parsed.fieldToken !== undefined
          ? String(parsed.fieldToken)
          : isPaired
            ? ""
            : "ft_" + randHex(8);
      return {
        vaultId,
        shortRand,
        gatedKey: parsed.gatedKey || buildGatedKey(vaultId, shortRand),
        fieldToken,
        fieldTokenHash: String(parsed.fieldTokenHash || ""),
        stepsTotal: intOr(parsed.stepsTotal, DEFAULT_INITIAL_STEPS),
        tokensPerStep: migratedRate,
        tokensBurned: intOr(parsed.tokensBurned, 0),
        turnsCompleted: intOr(parsed.turnsCompleted, 0),
        resetEpoch: intOr(parsed.resetEpoch, 0),
        rateUpdatedAt,
        devices: uniqueStrings(parsed.devices),
        dailySyncMap: pruneDailySyncMap(parsed.dailySyncMap),
        provider,
        gatePath: String(parsed.gatePath || ""),
        selectedIde: String(parsed.selectedIde || "auto"),
        gateActivated: Boolean(parsed.gateActivated),
        isConnected: Boolean(parsed.isConnected),
        isPaired,
        pairedAt: intOr(parsed.pairedAt, 0),
        updatedAt: intOr(parsed.updatedAt, Date.now())
      };
    } catch (_) {
      return null;
    }
  }

  function getRawSecretKey() {
    const raw = String(storageGet(LS_SECRET_KEY) || "").trim();
    if (!raw || raw.toUpperCase() === "DEMO") return "";
    return raw;
  }

  let state = null;

  function saveLocalState() {
    if (!state) return;
    delete state.apiKey;
    delete state.secretKey;
    storageSet(LS_STATE_KEY, JSON.stringify(state));
    cookieSetVaultBackup(state);
    if (state.isPaired || state.gateActivated || intOr(state.stepsTotal, 0) > 0) {
      requestPersistentStorageOnce();
    }
  }

  function bootstrapStateFromEnvironment() {
    const pairInfo = parsePairParams();
    const existingLocal = loadLocalState();

    if (pairInfo && pairInfo.vaultId) {
      // Never mark "phone_qr" connected merely from opening the URL; wait for confirmed sync
      if (state && state.vaultId === pairInfo.vaultId) {
        if (pairInfo.fieldToken) state.fieldToken = pairInfo.fieldToken;
      } else if (!existingLocal || existingLocal.vaultId !== pairInfo.vaultId) {
        state = createFreshState({
          vaultId: pairInfo.vaultId,
          fieldToken: pairInfo.fieldToken || "",
          fieldTokenHash: "",
          stepsTotal: 0,
          tokensBurned: 0,
          isPaired: true,
          isConnected: false,
          devices: []
        });
      } else {
        state = existingLocal;
        if (pairInfo.fieldToken) state.fieldToken = pairInfo.fieldToken;
        if (!pairInfo.isSync) {
          state.isPaired = true;
        }
      }
      saveLocalState();
      return;
    }

    if (state && state.vaultId) {
      saveLocalState();
      return;
    }

    if (existingLocal) {
      state = existingLocal;
    } else {
      state = createFreshState();
      saveLocalState();
    }
  }

  bootstrapStateFromEnvironment();

  function getState() {
    const stepsTotal = intOr(state.stepsTotal, 0);
    const tokensPerStep = Math.max(1, intOr(state.tokensPerStep, DEFAULT_TOKENS_PER_STEP));
    const tokensEarned = stepsTotal * tokensPerStep;
    const tokensBurned = intOr(state.tokensBurned, 0);
    const tokensAvailable = Math.max(0, tokensEarned - tokensBurned);
    const turnsLeftApprox =
      tokensAvailable > 0 ? Math.ceil(tokensAvailable / TOKENS_PER_TURN_APPROX) : 0;
    const rawKey = getRawSecretKey();
    const hasKey = Boolean(rawKey && state.provider !== "demo");
    const effectiveProvider = hasKey ? state.provider : "demo";

    const usdPerStep = Number((tokensPerStep * USD_PER_TOKEN).toFixed(5));
    const mintedInfo = getMintedKeyInfo();
    const hasMinted = Boolean(mintedInfo && (mintedInfo.mintedKey || mintedInfo.hash));
    const gatePath = state.gatePath || (hasMinted ? "openrouter" : "ide");

    // Decouple real OpenRouter USD spend from local token scaling so rate switches stay 100% exact
    const creditEarnedUsd = Number((tokensEarned * USD_PER_TOKEN).toFixed(4));
    let creditBurnedUsd = Number((tokensBurned * USD_PER_TOKEN).toFixed(4));
    let creditAvailableUsd = Number((tokensAvailable * USD_PER_TOKEN).toFixed(4));
    let isLocked = tokensAvailable <= 0;

    if (gatePath === "openrouter" && hasMinted) {
      const liveUsage = Math.max(0, Number(mintedInfo.liveUsageUsd || 0));
      const baseline = Math.max(0, Number(mintedInfo.baselineUsageUsd || 0));
      const realOrSpentUsd = Math.max(0, liveUsage - baseline);
      creditBurnedUsd = Number(realOrSpentUsd.toFixed(4));
      creditAvailableUsd = Number(Math.max(0, creditEarnedUsd - realOrSpentUsd).toFixed(4));
      isLocked = creditAvailableUsd <= 0;
    }

    const devices = uniqueStrings(state.devices);
    const realDevices = devices.filter(
      (d) => !/^(demo|manual|test)$/i.test(String(d || "").trim())
    );
    const isConnected = Boolean(
      realDevices.length > 0 ||
        (gatePath === "openrouter" && hasMinted) ||
        intOr(state.turnsCompleted, 0) > 0
    );

    return {
      vaultId: state.vaultId,
      stepsTotal,
      tokensPerStep,
      difficulty: inferDifficulty(tokensPerStep),
      tokensEarned,
      tokensBurned,
      tokensAvailable,
      usdPerStep,
      creditEarnedUsd,
      creditBurnedUsd,
      creditAvailableUsd,
      turnsLeftApprox,
      turnsCompleted: intOr(state.turnsCompleted, 0),
      isLocked,
      devices,
      provider: effectiveProvider,
      hasKey,
      hasMintedKey: hasMinted,
      orSyncError: (mintedInfo && mintedInfo.syncError) || "",
      gatePath,
      selectedIde: state.selectedIde || "auto",
      gateActivated: Boolean(state.gateActivated),
      isConnected,
      gatedKey: state.gatedKey || buildGatedKey(state.vaultId, state.shortRand),
      maskedUpstreamKey: hasKey ? maskSecretKey(rawKey) : "",
      updatedAt: intOr(state.updatedAt, Date.now()),
      isPaired: Boolean(state.isPaired),
      pairedAt: intOr(state.pairedAt, 0),
      fieldToken: state.fieldToken
    };
  }

  function emitChange() {
    if (typeof syncOpenRouterKeyLimit === "function") {
      try {
        syncOpenRouterKeyLimit();
      } catch (_) {}
    }
    const snapshot = getState();
    try {
      if (
        typeof root !== "undefined" &&
        typeof root.dispatchEvent === "function" &&
        typeof CustomEvent === "function"
      ) {
        root.dispatchEvent(new CustomEvent("rt:change", { detail: snapshot }));
      }
    } catch (_) {}
    return snapshot;
  }

  /* ---------------- Cloud Firestore REST Operations ---------------- */
  async function fetchCloudVaultDoc(vaultId) {
    if (typeof fetch !== "function" || !vaultId) return { status: 0, doc: null };
    const docName =
      "projects/" +
      FS_PROJECT +
      "/databases/(default)/documents/" +
      FS_COLLECTION +
      "/" +
      vaultId;
    try {
      const res = await fetch(FS_BASE + ":batchGet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documents: [docName] })
      });
      if (res.status === 200) {
        const arr = await res.json();
        const first = Array.isArray(arr) ? arr[0] : arr;
        if (first && first.found) {
          return { status: 200, doc: docToObj(first.found) };
        }
        if (first && first.missing) {
          return { status: 404, doc: null };
        }
      }
      return { status: res.status, doc: null };
    } catch (_) {
      return { status: 0, doc: null };
    }
  }

  async function patchCloudVaultDoc(vaultId, rawPayload, replaceDoc = false) {
    if (typeof fetch !== "function" || !vaultId) return null;
    const safePayload = sanitizeCloudObject(rawPayload);
    const keys = Object.keys(safePayload);
    if (!keys.length) return null;

    const maskQuery = replaceDoc
      ? ""
      : "?" + keys.map((k) => "updateMask.fieldPaths=" + encodeURIComponent(k)).join("&");
    const docUrl =
      FS_BASE + "/" + FS_COLLECTION + "/" + encodeURIComponent(vaultId) + maskQuery;

    try {
      const bodyStr = JSON.stringify({ fields: toFsVal(safePayload).mapValue.fields });
      const res = await fetch(docUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: bodyStr,
        keepalive: bodyStr.length < 60000
      });
      if (!res.ok) return null;
      return docToObj(await res.json());
    } catch (_) {
      return null;
    }
  }

  async function ensureFieldTokenHash() {
    if (!state.fieldToken && !state.isPaired) {
      state.fieldToken = "ft_" + randHex(8);
    }
    if (!state.fieldTokenHash && state.fieldToken && !state.isPaired) {
      state.fieldTokenHash = await sha256Hex(state.fieldToken);
    }
    return state.fieldTokenHash;
  }

  async function buildCloudPayloadFromState() {
    await ensureFieldTokenHash();
    state.dailySyncMap = pruneDailySyncMap(state.dailySyncMap);
    const s = getState();
    const payload = {
      vaultId: s.vaultId,
      stepsTotal: s.stepsTotal,
      tokensPerStep: s.tokensPerStep,
      tokensEarned: s.tokensEarned,
      tokensBurned: s.tokensBurned,
      tokensAvailable: s.tokensAvailable,
      turnsCompleted: s.turnsCompleted,
      resetEpoch: intOr(state.resetEpoch, 0),
      rateUpdatedAt: intOr(state.rateUpdatedAt, 0),
      devices: s.devices,
      dailySyncJson: JSON.stringify(state.dailySyncMap || {}),
      provider: s.provider,
      gatedKeyMask: maskGatedKey(s.gatedKey),
      updatedAt: s.updatedAt
    };
    if (state.fieldTokenHash) {
      payload.fieldTokenHash = state.fieldTokenHash;
    }
    if (intOr(state.pairedAt, 0) > 0) {
      payload.pairedAt = intOr(state.pairedAt, 0);
    }
    return payload;
  }

  function normalizeRemoteVault(remote) {
    const rRate = Math.max(
      1,
      intOr(remote.tokensPerStep ?? remote.rateTokensPerStep, DEFAULT_TOKENS_PER_STEP)
    );
    const rBurned = intOr(remote.tokensBurned, 0);
    let rSteps = remote.stepsTotal ?? remote.stepsBanked;
    if (rSteps === undefined || rSteps === null) {
      if (typeof remote.tokensAvailable === "number") {
        rSteps = Math.ceil((Math.max(0, remote.tokensAvailable) + rBurned) / rRate);
      } else {
        rSteps = 0;
      }
    }
    return {
      stepsTotal: intOr(rSteps, 0),
      tokensPerStep: rRate,
      tokensBurned: rBurned,
      turnsCompleted: intOr(remote.turnsCompleted, 0),
      resetEpoch: intOr(remote.resetEpoch, 0),
      rateUpdatedAt: intOr(remote.rateUpdatedAt, 0),
      devices: uniqueStrings(remote.devices || remote.connectedDevices || []),
      dailySyncJson: typeof remote.dailySyncJson === "string" ? remote.dailySyncJson : "{}",
      provider: typeof remote.provider === "string" ? remote.provider : "",
      fieldTokenHash: typeof remote.fieldTokenHash === "string" ? remote.fieldTokenHash : "",
      pairedAt: intOr(remote.pairedAt, 0),
      updatedAt: intOr(remote.updatedAt, 0)
    };
  }

  function mergeRemoteIntoLocal(remoteRaw) {
    if (!remoteRaw) return false;
    const remote = normalizeRemoteVault(remoteRaw);
    let changed = false;

    const localEpoch = intOr(state.resetEpoch, 0);
    const remoteEpoch = remote.resetEpoch;

    if (remoteEpoch > localEpoch) {
      state.resetEpoch = remoteEpoch;
      state.stepsTotal = remote.stepsTotal;
      state.tokensBurned = remote.tokensBurned;
      state.tokensPerStep = remote.tokensPerStep;
      state.rateUpdatedAt = Math.max(intOr(state.rateUpdatedAt, 0), remote.rateUpdatedAt);
      state.turnsCompleted = Math.max(intOr(state.turnsCompleted, 0), remote.turnsCompleted);
      changed = true;
    } else if (remoteEpoch === localEpoch) {
      let adoptedRemoteScaledBurn = false;
      if (remote.rateUpdatedAt > intOr(state.rateUpdatedAt, 0)) {
        const oldRate = Math.max(1, intOr(state.tokensPerStep, DEFAULT_TOKENS_PER_STEP));
        state.tokensPerStep = remote.tokensPerStep;
        state.rateUpdatedAt = remote.rateUpdatedAt;
        if (remote.tokensPerStep !== oldRate) {
          if (remote.tokensBurned > 0) {
            state.tokensBurned = remote.tokensBurned;
            adoptedRemoteScaledBurn = true;
          } else if (state.tokensBurned > 0) {
            state.tokensBurned = Math.round((state.tokensBurned / oldRate) * remote.tokensPerStep);
            adoptedRemoteScaledBurn = true;
          }
        }
        changed = true;
      }
      const mergedSteps = Math.max(intOr(state.stepsTotal, 0), remote.stepsTotal);
      const mergedBurned = adoptedRemoteScaledBurn
        ? state.tokensBurned
        : Math.max(intOr(state.tokensBurned, 0), remote.tokensBurned);
      const mergedTurns = Math.max(intOr(state.turnsCompleted, 0), remote.turnsCompleted);
      if (
        mergedSteps !== state.stepsTotal ||
        mergedBurned !== state.tokensBurned ||
        mergedTurns !== state.turnsCompleted
      ) {
        state.stepsTotal = mergedSteps;
        state.tokensBurned = mergedBurned;
        state.turnsCompleted = mergedTurns;
        changed = true;
      }
    }

    const mergedDevices = uniqueStrings([].concat(state.devices || [], remote.devices || []));
    if (mergedDevices.length !== (state.devices || []).length) {
      state.devices = mergedDevices;
      changed = true;
    }

    try {
      const rMap = pruneDailySyncMap(JSON.parse(remote.dailySyncJson || "{}"));
      state.dailySyncMap = pruneDailySyncMap(state.dailySyncMap);
      Object.keys(rMap).forEach((k) => {
        const rv = intOr(rMap[k], 0);
        if (rv > intOr(state.dailySyncMap[k], 0)) {
          state.dailySyncMap[k] = rv;
          changed = true;
        }
      });
    } catch (_) {}

    if (remote.fieldTokenHash && !state.fieldTokenHash) {
      state.fieldTokenHash = remote.fieldTokenHash;
      changed = true;
    }

    if (remote.pairedAt > intOr(state.pairedAt, 0)) {
      state.pairedAt = remote.pairedAt;
      changed = true;
    }

    if (changed) {
      state.updatedAt = Math.max(intOr(state.updatedAt, 0), remote.updatedAt, Date.now());
      saveLocalState();
    }
    return changed;
  }

  /* ---------------- Public API Methods ---------------- */
  function syncFromCloud() {
    if (syncFromCloudPromise) return syncFromCloudPromise;
    syncFromCloudPromise = _syncFromCloudImpl().finally(() => {
      syncFromCloudPromise = null;
    });
    return syncFromCloudPromise;
  }

  async function _syncFromCloudImpl() {
    const res = await fetchCloudVaultDoc(state.vaultId);
    if (res.status === 200 && res.doc) {
      const localAheadEpoch = intOr(state.resetEpoch, 0) > intOr(res.doc.resetEpoch, 0);
      const localAheadSteps =
        intOr(state.resetEpoch, 0) === intOr(res.doc.resetEpoch, 0) &&
        (intOr(state.stepsTotal, 0) > intOr(res.doc.stepsTotal ?? res.doc.stepsBanked, 0) ||
          intOr(state.tokensBurned, 0) > intOr(res.doc.tokensBurned, 0));

      mergeRemoteIntoLocal(res.doc);

      if (localAheadEpoch || localAheadSteps) {
        const payload = await buildCloudPayloadFromState();
        await patchCloudVaultDoc(state.vaultId, payload, true);
      }
    } else if (res.status === 404 && !state.isPaired) {
      const payload = await buildCloudPayloadFromState();
      await patchCloudVaultDoc(state.vaultId, payload, true);
    }

    const minted = getMintedKeyInfo();
    if (minted && minted.hash && minted.mgmtKey) {
      await refreshOpenRouterUsage();
      await syncOpenRouterKeyLimit().catch(() => {});
    }
    saveLocalState();
    return emitChange();
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPolling(intervalMs = 2500, callback) {
    stopPolling();
    if (typeof callback === "function") {
      pollCallback = callback;
    }
    const ms = Math.max(800, Number(intervalMs) || 2500);

    pollTimer = setInterval(async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      const next = await syncFromCloud();
      if (typeof pollCallback === "function") {
        try {
          pollCallback(next);
        } catch (_) {}
      }
    }, ms);

    if (!visibilityBound && typeof document !== "undefined" && document.addEventListener) {
      visibilityBound = true;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          syncFromCloud().then((next) => {
            if (typeof pollCallback === "function") {
              try {
                pollCallback(next);
              } catch (_) {}
            }
          });
        }
      });
    }

    return stopPolling;
  }

  async function init(options) {
    bootstrapStateFromEnvironment();
    if (!state.isPaired) {
      await ensureFieldTokenHash();
      saveLocalState();
    }

    await syncFromCloud();

    if (options && options.poll !== false && options.intervalMs) {
      startPolling(options.intervalMs, options.onUpdate);
    }

    return getState();
  }

  async function addSteps(steps, deviceId = "demo") {
    const delta = Math.max(0, Math.floor(Number(steps) || 0));
    const dev = String(deviceId || "demo").trim() || "demo";
    if (delta <= 0) return getState();

    if (state.isPaired) {
      await postFieldSteps(state.vaultId, state.fieldToken, delta, dev);
      return getState();
    }

    const baseBefore = intOr(state.stepsTotal, 0);
    state.stepsTotal = baseBefore + delta;
    state.devices = uniqueStrings([].concat(state.devices, [dev]));
    state.updatedAt = Date.now();
    saveLocalState();
    emitChange();

    const cloud = await fetchCloudVaultDoc(state.vaultId);
    if (cloud.status === 200 && cloud.doc) {
      const rNorm = normalizeRemoteVault(cloud.doc);
      if (rNorm.stepsTotal > baseBefore) {
        state.stepsTotal = rNorm.stepsTotal + delta;
      }
    }
    state.devices = uniqueStrings([].concat(state.devices, [dev]));
    state.updatedAt = Date.now();
    saveLocalState();
    emitChange();

    const payload = await buildCloudPayloadFromState();
    await patchCloudVaultDoc(state.vaultId, payload, true);
    return emitChange();
  }

  let fieldStepChain = Promise.resolve();

  function postFieldSteps(vaultId, fieldToken, steps, deviceId = "phone_qr") {
    const run = () => _postFieldStepsSerial(vaultId, fieldToken, steps, deviceId);
    fieldStepChain = fieldStepChain.then(run, run);
    return fieldStepChain;
  }

  async function _postFieldStepsSerial(vaultId, fieldToken, steps, deviceId = "phone_qr") {
    const targetVaultId = sanitizeSafeId(vaultId || state.vaultId, "");
    const delta = Math.max(0, Math.floor(Number(steps) || 0));
    const dev = String(deviceId || "phone_qr").trim() || "phone_qr";

    if (!targetVaultId) {
      throw new Error("Missing or invalid vaultId for postFieldSteps");
    }
    if (delta <= 0) {
      return { ok: true, vaultId: targetVaultId, stepsAdded: 0, state: getState() };
    }

    const cloud = await fetchCloudVaultDoc(targetVaultId);
    if (cloud.status === 0) {
      const netErr = new Error("Connection offline -- steps saved on your phone and will sync automatically");
      netErr.code = "NETWORK_ERROR";
      throw netErr;
    }

    const remoteNorm =
      cloud.status === 200 && cloud.doc
        ? normalizeRemoteVault(cloud.doc)
        : {
            stepsTotal: targetVaultId === state.vaultId ? intOr(state.stepsTotal, 0) : 0,
            tokensPerStep:
              targetVaultId === state.vaultId
                ? Math.max(1, intOr(state.tokensPerStep, DEFAULT_TOKENS_PER_STEP))
                : DEFAULT_TOKENS_PER_STEP,
            tokensBurned: targetVaultId === state.vaultId ? intOr(state.tokensBurned, 0) : 0,
            turnsCompleted: targetVaultId === state.vaultId ? intOr(state.turnsCompleted, 0) : 0,
            resetEpoch: targetVaultId === state.vaultId ? intOr(state.resetEpoch, 0) : 0,
            rateUpdatedAt: targetVaultId === state.vaultId ? intOr(state.rateUpdatedAt, 0) : 0,
            devices: [],
            fieldTokenHash: ""
          };

    // Strict authentication: if vault has fieldTokenHash, empty or wrong fieldToken MUST fail 403
    if (remoteNorm.fieldTokenHash) {
      const candidateHash = fieldToken ? await sha256Hex(fieldToken) : "";
      if (!candidateHash || candidateHash !== remoteNorm.fieldTokenHash) {
        const err = new Error("Phone link expired -- scan the fresh QR code on your computer");
        err.status = 403;
        err.code = "FIELD_TOKEN_MISMATCH";
        throw err;
      }
    }

    const nextStepsTotal = remoteNorm.stepsTotal + delta;
    const rate = Math.max(1, remoteNorm.tokensPerStep || DEFAULT_TOKENS_PER_STEP);
    const tokensEarned = nextStepsTotal * rate;
    const tokensBurned = remoteNorm.tokensBurned;
    const tokensAvailable = Math.max(0, tokensEarned - tokensBurned);
    const nextDevices = uniqueStrings([].concat(remoteNorm.devices || [], [dev]));
    const now = Date.now();

    const payload = {
      vaultId: targetVaultId,
      stepsTotal: nextStepsTotal,
      tokensPerStep: rate,
      tokensEarned,
      tokensBurned,
      tokensAvailable,
      turnsCompleted: remoteNorm.turnsCompleted,
      resetEpoch: remoteNorm.resetEpoch,
      rateUpdatedAt: remoteNorm.rateUpdatedAt,
      devices: nextDevices,
      updatedAt: now
    };

    if (!remoteNorm.fieldTokenHash && fieldToken) {
      payload.fieldTokenHash = await sha256Hex(fieldToken);
    }

    const updated = await patchCloudVaultDoc(targetVaultId, payload, false);
    if (!updated) {
      const writeErr = new Error("Couldn't save steps right now -- retrying automatically");
      writeErr.code = "CLOUD_WRITE_FAILED";
      throw writeErr;
    }

    if (targetVaultId === state.vaultId) {
      state.stepsTotal = nextStepsTotal;
      state.tokensBurned = tokensBurned;
      state.tokensPerStep = rate;
      state.resetEpoch = remoteNorm.resetEpoch;
      state.rateUpdatedAt = remoteNorm.rateUpdatedAt;
      state.turnsCompleted = remoteNorm.turnsCompleted;
      state.devices = uniqueStrings([].concat(state.devices, nextDevices));
      state.isConnected = true;
      state.updatedAt = now;
      saveLocalState();
      emitChange();
    }

    return {
      ok: true,
      vaultId: targetVaultId,
      stepsAdded: delta,
      stepsTotal: nextStepsTotal,
      tokensPerStep: rate,
      tokensAvailable,
      devices: nextDevices,
      state: targetVaultId === state.vaultId ? getState() : null
    };
  }

  async function drainTokens(amount) {
    const now = Date.now();
    const maxEarned =
      intOr(state.stepsTotal, 0) * Math.max(1, intOr(state.tokensPerStep, DEFAULT_TOKENS_PER_STEP));
    const numericAmt = Number(amount);
    if (Number.isFinite(numericAmt) && numericAmt > 0) {
      state.tokensBurned = Math.min(maxEarned, intOr(state.tokensBurned, 0) + Math.floor(numericAmt));
    } else {
      state.resetEpoch = now;
      state.tokensBurned = maxEarned;
    }
    state.updatedAt = now;
    saveLocalState();
    emitChange();

    const payload = await buildCloudPayloadFromState();
    await patchCloudVaultDoc(state.vaultId, payload, true);
    return emitChange();
  }

  async function resetToZero() {
    // Refresh live OpenRouter usage BEFORE snapshotting baseline so unpolled spend isn't absorbed into new walks
    const preOr = getMintedKeyInfo();
    if (preOr && preOr.hash && preOr.mgmtKey) {
      await refreshOpenRouterUsage().catch(() => {});
      const freshOr = getMintedKeyInfo();
      if (freshOr && freshOr.hash) {
        const nextBaseline = Math.max(
          Number(freshOr.liveUsageUsd || 0),
          Number(freshOr.baselineUsageUsd || 0)
        );
        writeMintedKeyInfoMerged({
          baselineUsageUsd: nextBaseline,
          syncError: ""
        });
        lastSyncedOrLimit = -1;
        lastSyncedOrDisabled = null;
      }
    }

    const now = Date.now();
    state.resetEpoch = now;
    state.stepsTotal = 0;
    state.tokensBurned = 0;
    // Preserve today's cumulative Apple/Google Health high-water mark so pre-reset steps never flood back in!
    state.dailySyncMap = pruneDailySyncMap(state.dailySyncMap);
    state.updatedAt = now;
    saveLocalState();
    emitChange();

    const payload = await buildCloudPayloadFromState();
    await patchCloudVaultDoc(state.vaultId, payload, true);
    await syncOpenRouterKeyLimit().catch(() => {});
    return emitChange();
  }

  async function setRate(tokensPerStep) {
    // Sync latest cloud state first without bumping resetEpoch so unpolled steps/burns are never clobbered
    try {
      const cloud = await fetchCloudVaultDoc(state.vaultId);
      if (cloud.status === 200 && cloud.doc) {
        mergeRemoteIntoLocal(cloud.doc);
      }
    } catch (_) {}

    const oldRate = Math.max(1, intOr(state.tokensPerStep, DEFAULT_TOKENS_PER_STEP));
    const nextRate = Math.max(1, Math.round(Number(tokensPerStep) || DEFAULT_TOKENS_PER_STEP));
    const now = Date.now();

    const oldBurned = intOr(state.tokensBurned, 0);
    const scaledBurned = Math.round((oldBurned / oldRate) * nextRate);

    state.tokensPerStep = nextRate;
    state.tokensBurned = Math.max(0, scaledBurned);
    state.rateUpdatedAt = now;
    state.updatedAt = now;
    saveLocalState();
    emitChange();

    const payload = await buildCloudPayloadFromState();
    await patchCloudVaultDoc(state.vaultId, payload, true);
    await syncOpenRouterKeyLimit().catch(() => {});
    return emitChange();
  }

  function saveKey(input = {}) {
    const opts =
      typeof input === "string"
        ? { provider: "auto", apiKey: input }
        : input || {};
    const rawKey = String(opts.apiKey || "").trim();

    if (!state.shortRand) state.shortRand = randHex(2);
    if (!state.gatedKey) state.gatedKey = buildGatedKey(state.vaultId, state.shortRand);

    if (!rawKey || rawKey.toUpperCase() === "DEMO") {
      storageRemove(LS_SECRET_KEY);
      state.provider = "demo";
    } else {
      const detected = detectProvider(opts.provider, rawKey);
      storageSet(LS_SECRET_KEY, rawKey);
      state.provider = detected;
    }

    state.updatedAt = Date.now();
    saveLocalState();
    const snapshot = emitChange();

    buildCloudPayloadFromState()
      .then((payload) => patchCloudVaultDoc(state.vaultId, payload, true))
      .catch(() => {});

    return snapshot;
  }

  function getDifficultyPresets() {
    return JSON.parse(JSON.stringify(DIFFICULTY_PRESETS));
  }

  function calculateSteps(stepsInput, rateOverride) {
    const steps = Math.max(0, Math.round(Number(stepsInput) || 0));
    const rate = Math.max(
      1,
      Math.round(Number(rateOverride || (state && state.tokensPerStep) || DEFAULT_TOKENS_PER_STEP))
    );
    const tokens = steps * rate;
    const rawTurns = tokens / TOKENS_PER_TURN_APPROX;
    const turns = rawTurns >= 10 ? Math.round(rawTurns) : Number(rawTurns.toFixed(1));
    const usd = Number((tokens * USD_PER_TOKEN).toFixed(4));
    const minutesApprox = steps <= 0 ? 0 : Math.max(1, Math.round(steps / 100));
    const kcalApprox = Math.round(steps * 0.045);
    const kmApprox = Number((steps * 0.00078).toFixed(1));
    return {
      steps,
      tokensPerStep: rate,
      difficulty: inferDifficulty(rate),
      tokens,
      turns,
      usd,
      minutesApprox,
      kcalApprox,
      kmApprox
    };
  }

  async function setDifficulty(level) {
    const key = String(level || "standard").toLowerCase();
    const preset = DIFFICULTY_PRESETS[key] || DIFFICULTY_PRESETS.standard;
    return setRate(preset.tokensPerStep);
  }

  function setGateConfig(cfg = {}) {
    if (cfg.gatePath !== undefined) {
      state.gatePath = String(cfg.gatePath || "");
    }
    if (cfg.selectedIde !== undefined) {
      state.selectedIde = String(cfg.selectedIde || "auto");
    }
    if (cfg.gateActivated !== undefined) {
      state.gateActivated = Boolean(cfg.gateActivated);
    }
    if (cfg.isConnected !== undefined) {
      state.isConnected = Boolean(cfg.isConnected);
    }
    state.updatedAt = Date.now();
    saveLocalState();
    return emitChange();
  }

  async function disconnectGate() {
    state.isConnected = false;
    state.gateActivated = false;
    state.devices = [];
    state.updatedAt = Date.now();
    await clearMintedKey();
    saveKey({ provider: "demo", apiKey: "" });
    saveLocalState();
    try {
      const payload = await buildCloudPayloadFromState();
      await patchCloudVaultDoc(state.vaultId, payload, true);
    } catch (_) {}
    return emitChange();
  }

  function getUninstallCommand(originOverride) {
    const origin = currentOrigin(originOverride);
    return `node ~/.runtime/gate.js --uninstall 2>/dev/null || (curl -fsSL ${origin}/gate.js | node - --uninstall)`;
  }

  function getSnippets(originOverride) {
    const origin = currentOrigin(originOverride);
    if (!state.fieldToken && !state.isPaired) {
      state.fieldToken = "ft_" + randHex(8);
      saveLocalState();
    }
    const s = getState();
    const keyId = sanitizeSafeId(s.vaultId, "vlt_cli_default");
    const ftClean = sanitizeSafeId(state.fieldToken, "");
    const ftFlag = ftClean ? ` --ft ${ftClean}` : "";
    const originFlag = origin !== DEFAULT_PROD_ORIGIN ? ` --origin ${origin}` : "";
    return {
      auto: `curl -fsSL ${origin}/gate.js | node - --install auto --vault ${keyId}${ftFlag}${originFlag}`,
      antigravity: `curl -fsSL ${origin}/gate.js | node - --install antigravity --vault ${keyId}${ftFlag}${originFlag}`,
      claude: `curl -fsSL ${origin}/gate.js | node - --install claude --vault ${keyId}${ftFlag}${originFlag}`,
      cursor: `curl -fsSL ${origin}/gate.js | node - --install cursor --vault ${keyId}${ftFlag}${originFlag}`,
      codex: `curl -fsSL ${origin}/gate.js | node - --install codex --vault ${keyId}${ftFlag}${originFlag}`,
      status: `node ~/.runtime/gate.js --status --vault ${keyId}${ftFlag}${originFlag} 2>/dev/null || (curl -fsSL ${origin}/gate.js | node - --status --vault ${keyId}${ftFlag}${originFlag})`,
      uninstall: getUninstallCommand(originOverride)
    };
  }

  function getPairUrl(originOverride) {
    const origin = currentOrigin(originOverride);
    if (!state.fieldToken && !state.isPaired) {
      state.fieldToken = "ft_" + randHex(8);
      saveLocalState();
    }
    const ftPart = state.fieldToken
      ? "&ft=" + encodeURIComponent(state.fieldToken)
      : "";
    return origin + "/?pair=" + encodeURIComponent(state.vaultId) + ftPart + "#walk";
  }

  function getHealthSyncUrl(source = "apple_health", originOverride) {
    const origin = currentOrigin(originOverride);
    if (!state.fieldToken && !state.isPaired) {
      state.fieldToken = "ft_" + randHex(8);
      saveLocalState();
    }
    const cleanSource =
      String(source || "apple_health")
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "_") || "apple_health";
    const ftPart = state.fieldToken
      ? "&ft=" + encodeURIComponent(state.fieldToken)
      : "";
    return (
      origin +
      "/?sync=" +
      encodeURIComponent(state.vaultId) +
      ftPart +
      "&source=" +
      encodeURIComponent(cleanSource) +
      "&steps="
    );
  }

  function parseSingleLocalizedStepToken(line) {
    let s = String(line || "")
      .trim()
      .replace(/(\d)[,\s\u00A0\u202F'’](?=\d{3}(\D|$))/g, "$1")
      .replace(/(\d)[,\s\u00A0\u202F'’](?=\d{3}(\D|$))/g, "$1");
    // EU/DE/ES/FR thousands separator: "4.523" or "12.345" or "1.234.567" (3 digits after dot, no comma decimal)
    const euMatch = s.match(/-?\d{1,3}(?:\.\d{3})+(?!\d)/);
    if (euMatch) {
      const vEu = Number(euMatch[0].replace(/\./g, ""));
      if (Number.isFinite(vEu)) return vEu;
    }
    // EU decimal comma: "4523,0"
    s = s.replace(/(-?\d+),(\d{1,2})(?!\d)/, "$1.$2");
    const m = s.match(/-?\d+(?:\.\d+)?/);
    if (!m) return 0;
    const v = Number(m[0]);
    return Number.isFinite(v) ? v : 0;
  }

  function parseReportedSteps(rawInput) {
    if (typeof rawInput === "number") {
      return Number.isFinite(rawInput) ? Math.max(0, Math.floor(rawInput)) : 0;
    }
    const rawStr = String(rawInput === undefined || rawInput === null ? "" : rawInput).trim();
    if (!rawStr) return 0;
    const lines = rawStr
      .split(/[\r\n;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length > 1) {
      let sum = 0;
      lines.forEach((line) => {
        const v = parseSingleLocalizedStepToken(line);
        if (v > 0) sum += v;
      });
      return Math.max(0, Math.floor(sum));
    }
    const val = parseSingleLocalizedStepToken(lines[0]);
    return Number.isFinite(val) ? Math.max(0, Math.floor(val)) : 0;
  }

  const STEPS_PER_ACTIVE_KCAL = 20; // 100 active kcal = 2,000 steps = 50,000 tokens (Standard)
  const STEPS_PER_KM = 1280;
  const STEPS_PER_MILE = 2060;
  const WHOOP_RESTING_DAY_KCAL_FLOOR = 1300;

  function convertEffortToSteps(amount, unit = "steps") {
    const num = typeof amount === "number" ? amount : parseSingleLocalizedStepToken(String(amount || ""));
    if (!Number.isFinite(num) || num <= 0) return 0;
    const u = String(unit || "steps").trim().toLowerCase();
    if (u === "calories" || u === "kcal" || u === "cal") {
      return Math.max(1, Math.round(num * STEPS_PER_ACTIVE_KCAL));
    }
    if (u === "day_calories") {
      const activeKcal = Math.max(100, num - WHOOP_RESTING_DAY_KCAL_FLOOR);
      return Math.max(1, Math.round(activeKcal * STEPS_PER_ACTIVE_KCAL));
    }
    if (u === "kj" || u === "kilojoules") {
      return Math.max(1, Math.round((num / 4.184) * STEPS_PER_ACTIVE_KCAL));
    }
    if (u === "km" || u === "kilometer" || u === "kilometers") {
      return Math.max(1, Math.round(num * STEPS_PER_KM));
    }
    if (u === "mi" || u === "mile" || u === "miles") {
      return Math.max(1, Math.round(num * STEPS_PER_MILE));
    }
    if (u === "strain") {
      return Math.max(1, Math.round(num * 600));
    }
    return Math.max(0, Math.round(num));
  }

  function parseCleanIntToken(tok) {
    return Math.round(parseSingleLocalizedStepToken(String(tok || "")));
  }

  function parseCleanFloatToken(tok) {
    const s = String(tok || "").trim().replace(",", ".");
    const m = s.match(/\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : 0;
  }

  function parseFitnessStatsFromText(rawText) {
    const text = String(rawText || "").replace(/\u00A0/g, " ");
    if (!text.trim()) return null;

    const lower = text.toLowerCase();
    const isWhoop = /\bwhoop\b|\bstrain\b|\brecovery\b/i.test(text);
    const isStrava = /\bstrava\b|\bpace\b/i.test(text);
    const isGarmin = /\bgarmin\b/i.test(text);
    const isSamsung = /\bsamsung\b/i.test(text);
    const baseSrc = isWhoop
      ? "whoop"
      : isStrava
        ? "strava"
        : isGarmin
          ? "garmin"
          : isSamsung
            ? "samsung_health"
            : "health_scan";

    // 1.STEPS — Handle "6,420 / 10,000 steps" or "6,420 of 10,000 steps" FIRST so goal is never picked!
    const slashSteps = text.match(
      /(\d{1,3}(?:[.,\s']\d{3})+|\d{2,6})\s*(?:\/|of)\s*(?:\d{1,3}(?:[.,\s']\d{3})+|\d{3,6})\s*(?:steps?|schritte|pasos)\b/i
    );
    if (slashSteps) {
      const sVal = parseCleanIntToken(slashSteps[1]);
      if (sVal >= 20 && sVal <= 150000) {
        return {
          metric: "steps",
          rawValue: sVal,
          stepsEquivalent: sVal,
          mode: "daily",
          source: baseSrc,
          summary: sVal.toLocaleString("en-US") + " STEPS"
        };
      }
    }

    const stepCandidates = [];
    const stepReBefore = /(\d{1,3}(?:[.,' ]\d{3})+|\d{2,6})\s*(?:\r?\n\s*)?(?:steps?|schritte|pasos)\b/gi;
    const stepReAfter = /\b(?:steps?|step\s*count)\b[\s:·\-]*(?:\r?\n\s*)?(\d{1,3}(?:[.,' ]\d{3})+|\d{2,6})/gi;
    let m;
    while ((m = stepReBefore.exec(text)) !== null) {
      const v = parseCleanIntToken(m[1]);
      if (v >= 20 && v <= 150000) stepCandidates.push(v);
    }
    while ((m = stepReAfter.exec(text)) !== null) {
      const v = parseCleanIntToken(m[1]);
      if (v >= 20 && v <= 150000) stepCandidates.push(v);
    }
    if (stepCandidates.length > 0) {
      const bestSteps = Math.max.apply(null, stepCandidates);
      return {
        metric: "steps",
        rawValue: bestSteps,
        stepsEquivalent: bestSteps,
        mode: "daily",
        source: baseSrc,
        summary: bestSteps.toLocaleString("en-US") + " STEPS"
      };
    }

    // 2. CALORIES / KILOJOULES — Handle "420 / 600 CAL" Move ring first, then standard WHOOP / workout calories
    const slashCal = text.match(
      /(\d{1,3}(?:[.,]\d{3})+|\d{2,5})\s*(?:\/|of)\s*(?:\d{1,3}(?:[.,]\d{3})+|\d{2,5})\s*(?:kcal|cal(?:ories)?)\b/i
    );
    if (slashCal) {
      const cVal = parseCleanIntToken(slashCal[1]);
      if (cVal >= 15 && cVal <= 6000) {
        const stepsEq = convertEffortToSteps(cVal, "calories");
        return {
          metric: "calories",
          rawValue: cVal,
          stepsEquivalent: stepsEq,
          mode: "daily",
          source: baseSrc + "_cal",
          summary: cVal.toLocaleString("en-US") + " CAL (" + stepsEq.toLocaleString("en-US") + " STEPS)"
        };
      }
    }

    const calCandidates = [];
    const calReBefore = /(\d{1,3}(?:[.,]\d{3})+|\d{2,5})\s*(?:\r?\n\s*)?(?:kcal|cal(?:ories)?)\b/gi;
    const calReAfter = /\b(?:active\s+calories|calories|kcal|cal)\b[\s:·\-]*(?:\r?\n\s*)?(\d{1,3}(?:[.,]\d{3})+|\d{2,5})/gi;
    while ((m = calReBefore.exec(text)) !== null) {
      const v = parseCleanIntToken(m[1]);
      if (v >= 15 && v <= 9000) calCandidates.push(v);
    }
    while ((m = calReAfter.exec(text)) !== null) {
      const v = parseCleanIntToken(m[1]);
      if (v >= 15 && v <= 9000) calCandidates.push(v);
    }
    const kjMatch = text.match(/(\d{1,3}(?:[.,]\d{3})+|\d{3,5})\s*(?:\r?\n\s*)?(?:kj|kilojoules?)\b/i);
    if (kjMatch && calCandidates.length === 0) {
      const kj = parseCleanIntToken(kjMatch[1]);
      if (kj >= 60 && kj <= 35000) {
        calCandidates.push(Math.round(kj / 4.184));
      }
    }

    if (calCandidates.length > 0) {
      const bestCal = Math.max.apply(null, calCandidates);
      // Full-day WHOOP Cycle total calories (>= 1,400 kcal) includes resting BMR (~1,300 kcal)
      const isFullDayCycle = bestCal >= 1400 && !/workout|activity|running|walking|cycling|rowing/i.test(lower);
      const stepsEq = isFullDayCycle
        ? convertEffortToSteps(bestCal, "day_calories")
        : convertEffortToSteps(bestCal, "calories");
      return {
        metric: isFullDayCycle ? "day_calories" : "calories",
        rawValue: bestCal,
        stepsEquivalent: stepsEq,
        mode: isFullDayCycle ? "daily" : "workout",
        source: isFullDayCycle ? baseSrc + "_day" : baseSrc,
        summary:
          bestCal.toLocaleString("en-US") +
          (isFullDayCycle ? " DAY CAL (" : " CAL (") +
          stepsEq.toLocaleString("en-US") +
          " STEPS)"
      };
    }

    // 3. DISTANCE (km / miles)
    const kmMatch = text.match(/(\d{1,2}(?:[.,]\d{1,2})?|\d{1,3})\s*(?:\r?\n\s*)?(?:km|kilometers?|kilometres?)\b/i);
    if (kmMatch) {
      const km = parseCleanFloatToken(kmMatch[1]);
      if (km >= 0.2 && km <= 120) {
        const stepsEq = convertEffortToSteps(km, "km");
        return {
          metric: "km",
          rawValue: km,
          stepsEquivalent: stepsEq,
          mode: "workout",
          source: baseSrc,
          summary: km + " KM (" + stepsEq.toLocaleString("en-US") + " STEPS)"
        };
      }
    }
    const miMatch = text.match(/(\d{1,2}(?:[.,]\d{1,2})?|\d{1,2})\s*(?:\r?\n\s*)?(?:mi|miles?)\b/i);
    if (miMatch) {
      const mi = parseCleanFloatToken(miMatch[1]);
      if (mi >= 0.2 && mi <= 80) {
        const stepsEq = convertEffortToSteps(mi, "mi");
        return {
          metric: "mi",
          rawValue: mi,
          stepsEquivalent: stepsEq,
          mode: "workout",
          source: baseSrc,
          summary: mi + " MI (" + stepsEq.toLocaleString("en-US") + " STEPS)"
        };
      }
    }

    // 4. WHOOP STRAIN (when Strain-only share card has e.g. "12.4 STRAIN")
    const strainBefore = text.match(/(\d{1,2}\.\d)\s*(?:\r?\n\s*)?strain\b/i);
    const strainAfter = text.match(/\bstrain\b[\s:·\-]*(?:\r?\n\s*)?(\d{1,2}\.\d)/i);
    const strainRaw = strainBefore ? strainBefore[1] : strainAfter ? strainAfter[1] : "";
    if (strainRaw) {
      const stVal = parseCleanFloatToken(strainRaw);
      if (stVal >= 2.0 && stVal <= 21.0) {
        const stepsEq = convertEffortToSteps(stVal, "strain");
        return {
          metric: "strain",
          rawValue: stVal,
          stepsEquivalent: stepsEq,
          mode: "daily",
          source: "whoop_strain",
          summary: stVal.toFixed(1) + " STRAIN (" + stepsEq.toLocaleString("en-US") + " STEPS)"
        };
      }
    }

    return null;
  }

  async function recordPairVisit(vaultId, fieldToken) {
    const targetVaultId = sanitizeSafeId(vaultId || state.vaultId, "");
    if (!targetVaultId || !fieldToken) return false;
    try {
      const cloud = await fetchCloudVaultDoc(targetVaultId);
      if (cloud.status !== 200 || !cloud.doc) return false;
      const remoteNorm = normalizeRemoteVault(cloud.doc);
      if (remoteNorm.fieldTokenHash) {
        const candidateHash = await sha256Hex(fieldToken);
        if (!candidateHash || candidateHash !== remoteNorm.fieldTokenHash) {
          return false;
        }
      }
      const now = Date.now();
      await patchCloudVaultDoc(
        targetVaultId,
        { pairedAt: now, updatedAt: now },
        false
      );
      if (targetVaultId === state.vaultId) {
        state.pairedAt = now;
        saveLocalState();
        emitChange();
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  async function syncDailySteps(
    targetVaultId,
    fieldToken,
    totalTodaySteps,
    source = "apple_health"
  ) {
    const vId = sanitizeSafeId(targetVaultId || state.vaultId, "");
    if (!vId) {
      throw new Error("Missing or invalid vault ID for health sync");
    }
    const cleanSource =
      String(source || "apple_health")
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "_") || "apple_health";
    const reported = parseReportedSteps(totalTodaySteps);
    const dayKey = todayIsoLocal() + ":" + cleanSource;

    const cloud = await fetchCloudVaultDoc(vId);
    if (cloud.status === 0) {
      throw new Error("Connection offline -- try syncing your steps again in a moment");
    }
    const remoteNorm =
      cloud.status === 200 && cloud.doc ? normalizeRemoteVault(cloud.doc) : null;

    if (remoteNorm && remoteNorm.fieldTokenHash) {
      const candidateHash = fieldToken ? await sha256Hex(fieldToken) : "";
      if (!candidateHash || candidateHash !== remoteNorm.fieldTokenHash) {
        const err = new Error("Sync link expired -- copy a fresh sync link in Step 1");
        err.status = 403;
        err.code = "FIELD_TOKEN_MISMATCH";
        throw err;
      }
    }

    let syncMap = {};
    try {
      const localMap = vId === state.vaultId ? pruneDailySyncMap(state.dailySyncMap) : {};
      const remoteMap = remoteNorm
        ? pruneDailySyncMap(JSON.parse(remoteNorm.dailySyncJson || "{}"))
        : {};
      syncMap = Object.assign({}, localMap);
      Object.keys(remoteMap).forEach((k) => {
        syncMap[k] = Math.max(intOr(syncMap[k], 0), intOr(remoteMap[k], 0));
      });
    } catch (_) {}

    const prevSynced = intOr(syncMap[dayKey], 0);
    const delta = Math.max(0, reported - prevSynced);
    syncMap[dayKey] = Math.max(prevSynced, reported);

    const baseSteps = remoteNorm
      ? remoteNorm.stepsTotal
      : vId === state.vaultId
        ? intOr(state.stepsTotal, 0)
        : 0;
    const rate = remoteNorm
      ? Math.max(1, remoteNorm.tokensPerStep || DEFAULT_TOKENS_PER_STEP)
      : Math.max(1, intOr(state.tokensPerStep, DEFAULT_TOKENS_PER_STEP));
    const burned = remoteNorm
      ? remoteNorm.tokensBurned
      : vId === state.vaultId
        ? intOr(state.tokensBurned, 0)
        : 0;
    const turns = remoteNorm
      ? remoteNorm.turnsCompleted
      : vId === state.vaultId
        ? intOr(state.turnsCompleted, 0)
        : 0;
    const resetEpoch = remoteNorm
      ? remoteNorm.resetEpoch
      : vId === state.vaultId
        ? intOr(state.resetEpoch, 0)
        : 0;
    const rateUpdatedAt = remoteNorm
      ? remoteNorm.rateUpdatedAt
      : vId === state.vaultId
        ? intOr(state.rateUpdatedAt, 0)
        : 0;

    const nextStepsTotal = baseSteps + delta;
    const tokensEarned = nextStepsTotal * rate;
    const tokensAvailable = Math.max(0, tokensEarned - burned);
    const nextDevices = uniqueStrings(
      [].concat(remoteNorm ? remoteNorm.devices : state.devices || [], [cleanSource])
    );
    const now = Date.now();

    const payload = {
      vaultId: vId,
      stepsTotal: nextStepsTotal,
      tokensPerStep: rate,
      tokensEarned,
      tokensBurned: burned,
      tokensAvailable,
      turnsCompleted: turns,
      resetEpoch,
      rateUpdatedAt,
      devices: nextDevices,
      dailySyncJson: JSON.stringify(syncMap),
      updatedAt: now
    };
    if ((!remoteNorm || !remoteNorm.fieldTokenHash) && fieldToken) {
      payload.fieldTokenHash = await sha256Hex(fieldToken);
    }

    const updated = await patchCloudVaultDoc(vId, payload, false);
    if (!updated) {
      throw new Error("Couldn't save your health steps right now -- try again in a moment");
    }

    if (vId === state.vaultId) {
      state.stepsTotal = nextStepsTotal;
      state.tokensPerStep = rate;
      state.tokensBurned = burned;
      state.turnsCompleted = turns;
      state.resetEpoch = resetEpoch;
      state.rateUpdatedAt = rateUpdatedAt;
      state.devices = nextDevices;
      state.dailySyncMap = syncMap;
      state.isConnected = true;
      state.updatedAt = now;
      saveLocalState();
      emitChange();
    }

    return {
      ok: true,
      vaultId: vId,
      source: cleanSource,
      reportedToday: reported,
      stepsAdded: delta,
      stepsTotal: nextStepsTotal,
      tokensPerStep: rate,
      tokensAvailable
    };
  }

  function getDeviceWebhookCommand(deviceName = "ios_shortcut") {
    const safeDevice =
      String(deviceName || "ios_shortcut")
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "_")
        .slice(0, 24) || "ios_shortcut";
    const docName =
      "projects/" +
      FS_PROJECT +
      "/databases/(default)/documents/" +
      FS_COLLECTION +
      "/" +
      state.vaultId;
    const commitUrl = FS_BASE + ":commit";
    const body = JSON.stringify({
      writes: [
        {
          update: {
            name: docName,
            fields: { vaultId: { stringValue: state.vaultId } }
          },
          updateMask: { fieldPaths: ["vaultId"] },
          updateTransforms: [
            { fieldPath: "stepsTotal", increment: { integerValue: "__STEPS_VAR__" } },
            {
              fieldPath: "devices",
              appendMissingElements: { values: [{ stringValue: safeDevice }] }
            }
          ]
        }
      ]
    }).replace('"__STEPS_VAR__"', '"\'"$STEPS"\'"');
    return (
      'STEPS="${STEPS:-1000}"\ncurl -sS -X POST "' +
      commitUrl +
      '" -H "Content-Type: application/json" -d \'' +
      body +
      "'"
    );
  }

  /* ---------------- Demo Code Generator + Real Upstream BYOK Burn ---------------- */
  function buildDemoResponseText(promptText) {
    const cleanPrompt = String(promptText || "Write some code").trim();
    const lower = cleanPrompt.toLowerCase();

    if (/python|rich|nap|sleep|money/.test(lower)) {
      return `# get_rich_while_napping.py
# Gated by RUNTIME: 1 step = 25 tokens. Sit still and I die mid-line.

import time

def print_money_in_sleep(pillow_temp="cold"):
    bank = 0.00
    strategies = [
        ("Shorting energy drinks during marathon season", 420.69),
        ("Selling artisanal grass to indoor programmers", 1337.00),
        ("Charging lazy devs $0 to lock their own API keys", 9000.00),
    ]
    for idea, profit in strategies:
        time.sleep(0.1)
        bank += profit
        print(f"[CHA-CHING] {idea} -> +\${profit:,.2f}")
    return f"Woke up jacked and up \${bank:,.2f}. Go walk another lap."

if __name__ == "__main__":
    print(print_money_in_sleep())
`;
    }

    if (/flappy|bird|game|js|canvas/.test(lower)) {
      return `// flappy_legs.js — playable 20-line Flappy Bird
const c = document.body.appendChild(document.createElement("canvas"));
const ctx = c.getContext("2d");
c.width = 400; c.height = 500;
let y = 200, vy = 0, pipeX = 400, gapY = 180, score = 0;

window.onclick = () => (vy = -7);
setInterval(() => {
  vy += 0.45; y += vy; pipeX -= 3.5;
  if (pipeX < -50) { pipeX = 400; gapY = 80 + Math.random() * 240; score++; }
  if (y > 500 || y < 0 || (pipeX < 90 && pipeX > 20 && (y < gapY || y > gapY + 120))) {
    y = 200; vy = 0; pipeX = 400; score = 0;
  }
  ctx.fillStyle = "#0a0a0a"; ctx.fillRect(0, 0, 400, 500);
  ctx.fillStyle = "#ff1900"; ctx.fillRect(50, y, 28, 28);
  ctx.fillStyle = "#ff0400";
  ctx.fillRect(pipeX, 0, 46, gapY);
  ctx.fillRect(pipeX, gapY + 120, 46, 500);
  ctx.fillText("SCORE: " + score, 16, 28);
}, 16);
`;
    }

    if (/roast|lazy|chair|sit/.test(lower)) {
      return `OBSERVATION LOG // SUBJECT: CHAIR-BOUND DEVELOPER

1. Posture check: shaped like a boiled shrimp over a $3,000 laptop.
2. Distance traveled today: 14 feet (desk -> fridge -> desk).
3. You asked AI to do your thinking AND refused to walk 100 steps for the tokens.
4. Your Apple Watch stopped sending Stand Reminders out of sheer embarrassment.

PRESCRIPTION:
Close the lid. Lace up. Hit the sidewalk for 5 minutes and earn fresh tokens.
`;
    }

    return `-- gym_bro_query.sql
-- Every JOIN is a superset. Never skip leg day or index day.

WITH heavy_sets AS (
  SELECT
    lifter_id,
    SUM(reps * weight_kg) AS total_volume_kg
  FROM squat_rack_sessions
  WHERE depth_below_parallel = TRUE -- quarter squats return HTTP 402
  GROUP BY lifter_id
)
SELECT
  u.handle,
  h.total_volume_kg,
  (h.total_volume_kg * 25) AS unlocked_ai_tokens
FROM users u
INNER JOIN heavy_sets h ON h.lifter_id = u.id
ORDER BY unlocked_ai_tokens DESC
LIMIT 10;
`;
  }

  function tokenizeIntoChunks(text) {
    return String(text || "").match(/\S+\s*|\s+/g) || [];
  }

  function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function make402Error() {
    const err = new Error(
      "HTTP 402 PAYMENT REQUIRED — 0 TOKENS LEFT. HIT THE PAVEMENT, PUNK!"
    );
    err.status = 402;
    err.code = "HTTP_402_WALK_LAZY";
    return err;
  }

  async function callUpstreamByok(provider, apiKey, promptText, maxOutputTokens) {
    const cappedMax = Math.min(450, Math.max(1, Math.floor(maxOutputTokens)));

    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model: "claude-3-5-haiku-latest",
          max_tokens: cappedMax,
          messages: [{ role: "user", content: promptText }]
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          (data && data.error && data.error.message) || "Anthropic error " + res.status;
        throw new Error(msg);
      }
      const text = Array.isArray(data.content)
        ? data.content.map((c) => c.text || "").join("")
        : "";
      const used =
        intOr(data.usage && data.usage.input_tokens, 0) +
        intOr(data.usage && data.usage.output_tokens, 0);
      return {
        text,
        reportedTokens: used || Math.max(1, Math.ceil(text.length / 3.5)),
        hitMaxTokens: data.stop_reason === "max_tokens"
      };
    }

    if (provider === "gemini") {
      const url =
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
        encodeURIComponent(apiKey);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: promptText }] }],
          generationConfig: { maxOutputTokens: cappedMax }
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          (data && data.error && data.error.message) || "Gemini error " + res.status;
        throw new Error(msg);
      }
      const parts =
        (data.candidates &&
          data.candidates[0] &&
          data.candidates[0].content &&
          data.candidates[0].content.parts) ||
        [];
      const text = parts.map((p) => p.text || "").join("");
      const used = intOr(data.usageMetadata && data.usageMetadata.totalTokenCount, 0);
      const finish =
        data.candidates && data.candidates[0] && data.candidates[0].finishReason;
      return {
        text,
        reportedTokens: used || Math.max(1, Math.ceil(text.length / 3.5)),
        hitMaxTokens: finish === "MAX_TOKENS"
      };
    }

    const endpoint =
      provider === "openrouter"
        ? "https://openrouter.ai/api/v1/chat/completions"
        : "https://api.openai.com/v1/chat/completions";
    const model = provider === "openrouter" ? "openai/gpt-4o-mini" : "gpt-4o-mini";

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey
      },
      body: JSON.stringify({
        model,
        max_tokens: cappedMax,
        messages: [
          {
            role: "system",
            content:
              "You are a concise, sharp senior software engineer. Respond with working code and punchy explanations."
          },
          { role: "user", content: promptText }
        ]
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        (data && data.error && data.error.message) || "Upstream LLM error " + res.status;
      throw new Error(msg);
    }
    const choice = data.choices && data.choices[0];
    const text = (choice && choice.message && choice.message.content) || "";
    const used =
      intOr(data.usage && data.usage.total_tokens, 0) ||
      intOr(data.usage && data.usage.prompt_tokens, 0) +
        intOr(data.usage && data.usage.completion_tokens, 0);
    return {
      text,
      reportedTokens: used || Math.max(1, Math.ceil(text.length / 3.5)),
      hitMaxTokens: Boolean(choice && choice.finish_reason === "length")
    };
  }

  async function burnPrompt(promptText, options = {}) {
    const onToken = typeof options.onToken === "function" ? options.onToken : null;
    const chunkDelayMs =
      typeof options.chunkDelayMs === "number" && options.chunkDelayMs >= 0
        ? options.chunkDelayMs
        : 22;

    try {
      const cloud = await fetchCloudVaultDoc(state.vaultId);
      if (cloud.status === 200 && cloud.doc) {
        mergeRemoteIntoLocal(cloud.doc);
      }
    } catch (_) {}

    const initialSnap = getState();
    const budget = initialSnap.tokensAvailable;
    if (budget <= 0) {
      throw make402Error();
    }

    const prompt =
      String(promptText || "Build me a fast app").trim() || "Build me a fast app";
    const rawKey = getRawSecretKey();
    const activeProvider = rawKey && state.provider !== "demo" ? state.provider : "demo";
    const baseBurned = intOr(state.tokensBurned, 0);

    if (activeProvider !== "demo" && rawKey) {
      const upstream = await callUpstreamByok(activeProvider, rawKey, prompt, budget);
      const chunks = tokenizeIntoChunks(upstream.text || "// (empty response)");
      const totalToBurn = Math.min(budget, Math.max(1, upstream.reportedTokens));
      const cutOff = upstream.reportedTokens >= budget || upstream.hitMaxTokens;

      let outText = "";
      let burnedSoFar = 0;
      const totalChunks = Math.max(1, chunks.length);

      for (let i = 0; i < chunks.length; i++) {
        const piece = chunks[i];
        outText += piece;
        burnedSoFar =
          i === chunks.length - 1
            ? totalToBurn
            : Math.min(
                totalToBurn,
                Math.max(1, Math.round(((i + 1) / totalChunks) * totalToBurn))
              );

        state.tokensBurned = baseBurned + burnedSoFar;
        state.updatedAt = Date.now();
        if (onToken) {
          onToken(piece, burnedSoFar, getState());
        }
        if (i % 4 === 0 || i === chunks.length - 1) {
          emitChange();
        }
        if (chunkDelayMs > 0) {
          await sleepMs(Math.min(18, chunkDelayMs));
        }
      }

      if (cutOff) {
        const banner =
          "\n\n// [0 TOKENS LEFT — GO WALK, LAZY!]";
        outText += banner;
        state.tokensBurned = baseBurned + budget;
        if (onToken) {
          onToken(banner, budget, getState());
        }
      } else {
        state.turnsCompleted = intOr(state.turnsCompleted, 0) + 1;
      }

      state.updatedAt = Date.now();
      saveLocalState();
      emitChange();

      const payload = await buildCloudPayloadFromState();
      await patchCloudVaultDoc(state.vaultId, payload, true);
      emitChange();

      return {
        text: outText,
        tokensUsed: cutOff ? budget : totalToBurn,
        cutOff,
        provider: activeProvider,
        state: getState()
      };
    }

    const fullDemoText = buildDemoResponseText(prompt);
    const chunks = tokenizeIntoChunks(fullDemoText);
    const TOKENS_PER_CHUNK = 4;

    let assembled = "";
    let burnedSoFar = 0;
    let cutOff = false;

    for (let i = 0; i < chunks.length; i++) {
      const remaining = budget - burnedSoFar;
      if (remaining <= 0) {
        cutOff = true;
        break;
      }

      let piece = chunks[i];
      const cost = Math.min(remaining, TOKENS_PER_CHUNK);

      if (burnedSoFar + cost >= budget && i < chunks.length - 1) {
        if (piece.length > 3) {
          piece = piece.slice(0, Math.max(2, Math.ceil(piece.length * 0.6)));
        }
        assembled += piece;
        burnedSoFar = budget;
        state.tokensBurned = baseBurned + burnedSoFar;
        state.updatedAt = Date.now();
        if (onToken) {
          onToken(piece, burnedSoFar, getState());
        }
        cutOff = true;
        break;
      }

      assembled += piece;
      burnedSoFar += cost;
      state.tokensBurned = baseBurned + burnedSoFar;
      state.updatedAt = Date.now();

      if (onToken) {
        onToken(piece, burnedSoFar, getState());
      }
      if (i % 3 === 0 || i === chunks.length - 1) {
        emitChange();
      }
      if (chunkDelayMs > 0) {
        await sleepMs(chunkDelayMs);
      }
    }

    if (cutOff) {
      const cutoffBanner =
        "\n\n// [0 TOKENS REMAINING — GO WALK TO FINISH THIS FILE!]";
      assembled += cutoffBanner;
      state.tokensBurned = baseBurned + budget;
      state.updatedAt = Date.now();
      if (onToken) {
        onToken(cutoffBanner, budget, getState());
      }
    } else {
      state.turnsCompleted = intOr(state.turnsCompleted, 0) + 1;
    }

    saveLocalState();
    emitChange();

    const payload = await buildCloudPayloadFromState();
    await patchCloudVaultDoc(state.vaultId, payload, true);
    emitChange();

    return {
      text: assembled,
      tokensUsed: cutOff ? budget : burnedSoFar,
      cutOff,
      provider: "demo",
      state: getState()
    };
  }

  /* ---------------- Real OpenRouter Step-Capped Key Minting ---------------- */
  async function revokeRemoteOpenRouterKey(info) {
    if (!info || !info.mgmtKey || !info.hash || typeof fetch !== "function") return false;
    const keyUrl =
      "https://openrouter.ai/api/v1/keys/" + encodeURIComponent(info.hash);
    try {
      const delRes = await fetch(keyUrl, {
        method: "DELETE",
        headers: { Authorization: "Bearer " + info.mgmtKey }
      });
      if (delRes.ok || delRes.status === 404) return true;
    } catch (_) {}
    try {
      const patchRes = await fetch(keyUrl, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer " + info.mgmtKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ disabled: true, limit: MIN_OR_LIMIT_USD })
      });
      return Boolean(patchRes && patchRes.ok);
    } catch (_) {
      return false;
    }
  }

  function clearMintedKey() {
    const existing = getMintedKeyInfo();
    storageRemove(LS_OR_MINT_KEY);
    lastSyncedOrLimit = -1;
    lastSyncedOrDisabled = null;
    if (existing && existing.hash && existing.mgmtKey) {
      revokeRemoteOpenRouterKey(existing).catch(() => {});
    }
    return emitChange();
  }

  function refreshOpenRouterUsage() {
    if (orUsagePollPromise) return orUsagePollPromise;
    const info = getMintedKeyInfo();
    if (!info || !info.mgmtKey || !info.hash || typeof fetch !== "function") {
      return Promise.resolve(null);
    }
    orUsagePollPromise = (async () => {
      try {
        const res = await fetch(
          "https://openrouter.ai/api/v1/keys/" + encodeURIComponent(info.hash),
          {
            method: "GET",
            headers: { Authorization: "Bearer " + info.mgmtKey }
          }
        );
        if (res.ok) {
          const body = await res.json().catch(() => ({}));
          const kd = (body && body.data) || body || {};
          if (typeof kd.usage === "number" && Number.isFinite(kd.usage)) {
            const liveUsage = Math.max(0, Number(kd.usage));
            writeMintedKeyInfoMerged({ liveUsageUsd: liveUsage });
          }
        }
      } catch (_) {
      } finally {
        orUsagePollPromise = null;
      }
      return getMintedKeyInfo();
    })();
    return orUsagePollPromise;
  }

  function syncOpenRouterKeyLimit() {
    const run = () => _syncOpenRouterKeyLimitSerial();
    orSyncChain = orSyncChain.then(run, run);
    return orSyncChain;
  }

  async function _syncOpenRouterKeyLimitSerial() {
    const info = getMintedKeyInfo();
    if (!info || !info.mgmtKey || !info.hash || typeof fetch !== "function") {
      return null;
    }
    const stepsTotal = intOr(state.stepsTotal, 0);
    const tokensPerStep = Math.max(
      1,
      intOr(state.tokensPerStep, DEFAULT_TOKENS_PER_STEP)
    );
    const earnedUsd = Number((stepsTotal * tokensPerStep * USD_PER_TOKEN).toFixed(4));
    const baseline = Math.max(0, Number(info.baselineUsageUsd || 0));
    const liveUsage = Math.max(0, Number(info.liveUsageUsd || 0));
    const realSpentUsd = Math.max(0, liveUsage - baseline);
    const availUsd = Number(Math.max(0, earnedUsd - realSpentUsd).toFixed(4));

    const targetDisabled = availUsd <= 0;
    const targetLimit = Math.max(
      MIN_OR_LIMIT_USD,
      Number((baseline + earnedUsd).toFixed(4))
    );

    if (
      targetLimit === lastSyncedOrLimit &&
      targetDisabled === lastSyncedOrDisabled &&
      !info.syncError
    ) {
      return info;
    }

    try {
      const res = await fetch(
        "https://openrouter.ai/api/v1/keys/" + encodeURIComponent(info.hash),
        {
          method: "PATCH",
          headers: {
            Authorization: "Bearer " + info.mgmtKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ limit: targetLimit, disabled: targetDisabled })
        }
      );
      if (res.ok) {
        lastSyncedOrLimit = targetLimit;
        lastSyncedOrDisabled = targetDisabled;
        return writeMintedKeyInfoMerged({
          limitUsd: targetLimit,
          disabled: targetDisabled,
          syncError: ""
        });
      }
      const errBody = await res.json().catch(() => ({}));
      const errMsg =
        (errBody && errBody.error && errBody.error.message) ||
        "OpenRouter cap sync HTTP " + res.status;
      return writeMintedKeyInfoMerged({ syncError: errMsg });
    } catch (err) {
      return writeMintedKeyInfoMerged({
        syncError: String((err && err.message) || "OpenRouter cap sync failed")
      });
    }
  }

  async function mintOpenRouterKey(mgmtKeyInput) {
    const mgmtKey = String(mgmtKeyInput || "").trim();
    if (!mgmtKey) throw new Error("Paste an OpenRouter Provisioning Key first.");

    // Revoke any previously minted key so old keys aren't orphaned on OpenRouter
    const prevMinted = getMintedKeyInfo();
    if (prevMinted && prevMinted.hash && prevMinted.mgmtKey) {
      await revokeRemoteOpenRouterKey(prevMinted).catch(() => {});
    }

    const stepsTotal = intOr(state.stepsTotal, 0);
    const tokensPerStep = Math.max(
      1,
      intOr(state.tokensPerStep, DEFAULT_TOKENS_PER_STEP)
    );
    const earnedUsd = Number((stepsTotal * tokensPerStep * USD_PER_TOKEN).toFixed(4));
    const initialDisabled = earnedUsd <= 0;
    // OpenRouter POST /api/v1/keys only accepts creation fields (no `disabled`), and `limit` must be > 0
    const createLimit = Math.max(MIN_OR_LIMIT_USD, earnedUsd);

    const res = await fetch("https://openrouter.ai/api/v1/keys", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + mgmtKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: "RUNTIME — WALK-GATED (" + state.vaultId + ")",
        limit: createLimit
      })
    });
    const data = await res.json().catch(() => ({}));
    const createdKey =
      (data && (data.key || (data.data && data.data.key))) || "";
    const hash =
      (data && ((data.data && data.data.hash) || data.hash)) || "";

    if (!res.ok || !createdKey || !hash) {
      const msg =
        (data && data.error && data.error.message) ||
        "OpenRouter HTTP " +
          res.status +
          " — use an OpenRouter Provisioning Key from openrouter.ai/settings/provisioning-keys";
      const err = new Error(msg);
      err.status = res.status;
      if (data && data.error && data.error.code) {
        err.errorCode = data.error.code;
      }
      throw err;
    }

    const label = (data.data && data.data.label) || data.label || "";
    const initialUsage = Math.max(
      0,
      Number((data.data && data.data.usage) || data.usage || 0)
    );

    // CRITICAL: When starting at 0 steps ($0.00), immediately PATCH { disabled: true } BEFORE returning key!
    if (initialDisabled) {
      let lockedOk = false;
      try {
        const lockRes = await fetch(
          "https://openrouter.ai/api/v1/keys/" + encodeURIComponent(hash),
          {
            method: "PATCH",
            headers: {
              Authorization: "Bearer " + mgmtKey,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              limit: MIN_OR_LIMIT_USD,
              disabled: true
            })
          }
        );
        lockedOk = Boolean(lockRes && lockRes.ok);
      } catch (_) {
        lockedOk = false;
      }
      if (!lockedOk) {
        await revokeRemoteOpenRouterKey({ mgmtKey, hash }).catch(() => {});
        throw new Error(
          "Failed to lock newly minted OpenRouter key at $0.00 — revoked key for safety."
        );
      }
    }

    const info = {
      mgmtKey,
      mintedKey: createdKey,
      hash,
      label,
      limitUsd: createLimit,
      baselineUsageUsd: initialUsage,
      liveUsageUsd: initialUsage,
      disabled: initialDisabled,
      syncError: "",
      createdAt: Date.now()
    };
    storageSet(LS_OR_MINT_KEY, JSON.stringify(info));
    lastSyncedOrLimit = createLimit;
    lastSyncedOrDisabled = initialDisabled;

    state.gatePath = "openrouter";
    state.gateActivated = true;
    state.isConnected = true;
    saveLocalState();
    saveKey({ provider: "openrouter", apiKey: createdKey });
    emitChange();
    return info;
  }

  async function connectAnyKey(rawInput) {
    const trimmed = String(rawInput || "").trim();
    if (!trimmed || trimmed.toUpperCase() === "DEMO") {
      clearMintedKey();
      saveKey({ apiKey: "" });
      return { mode: "sandbox", state: getState() };
    }

    if (trimmed.startsWith("sk-or-")) {
      try {
        const info = await mintOpenRouterKey(trimmed);
        return { mode: "openrouter_minted", minted: info, state: getState() };
      } catch (err) {
        const status = Number((err && (err.status || err.errorCode)) || 0);
        const msg = String((err && err.message) || "");
        const isRegularInferenceKey =
          status === 401 ||
          status === 403 ||
          /\b(401|403)\b/.test(msg) ||
          /provisioning|management key|unauthorized|forbidden/i.test(msg);
        if (isRegularInferenceKey) {
          clearMintedKey();
          saveKey({ provider: "openrouter", apiKey: trimmed });
          return { mode: "wrapped", state: getState() };
        }
        throw err;
      }
    }

    clearMintedKey();
    saveKey({ apiKey: trimmed });
    return { mode: "wrapped", state: getState() };
  }

  const RuntimeGate = {
    init,
    getState,
    syncFromCloud,
    startPolling,
    stopPolling,
    addSteps,
    postFieldSteps,
    drainTokens,
    resetToZero,
    setRate,
    setDifficulty,
    getDifficultyPresets,
    calculateSteps,
    setGateConfig,
    disconnectGate,
    saveKey,
    connectAnyKey,
    getSnippets,
    getUninstallCommand,
    getPairUrl,
    recordPairVisit,
    getHealthSyncUrl,
    syncDailySteps,
    parseReportedSteps,
    convertEffortToSteps,
    parseFitnessStatsFromText,
    getDeviceWebhookCommand,
    burnPrompt,
    mintOpenRouterKey,
    getMintedKeyInfo,
    clearMintedKey,
    refreshOpenRouterUsage,
    syncOpenRouterKeyLimit
  };

  if (typeof window !== "undefined") {
    window.RuntimeGate = RuntimeGate;
  }
  if (typeof globalThis !== "undefined") {
    globalThis.RuntimeGate = RuntimeGate;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = RuntimeGate;
  }
})(typeof window !== "undefined" ? window : globalThis);
