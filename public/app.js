/* ==========================================================================
   RUNTIME v16 — Linear Step-by-Step Controller & Character Block-ASCII Engine
   - Landing: Sprinter chasing TWO-ARMED runaway CRT monitor (zero text in bay)
   - How It Works: 3-Act character comic strip (Walk -> Unlock -> Lock at Zero)
   - Step Calculator: Calibrated steps-to-tokens & $ rate preview
   - Step 1 of 2: Connect Your Steps (Desktop QR above fold / Mobile direct 1-tap)
   - Step 2 of 2: Connect Your Gate (Solid boxes, plain English, strict OR guard)
   - Live Tracker: Crisp 1-bit HUD + dynamic fuel bar + focus-trapped QR modal
   - Step Counter: Pauseable phone pedometer + accurate iOS/Android Health sync
   ========================================================================== */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const ALL_SCREENS = ["landing", "how", "rate", "steps", "gate", "console", "walk"];

  let currentScreen = "landing";
  let howReturnScreen = "landing";
  let rateReturnScreen = "how";
  let gateSubView = "picker"; // "picker" | "walkthrough"
  let walkOpenedFromSteps = false;
  let activePath = "ide"; // "ide" (Local Agent) | "openrouter" (OpenRouter Key)
  let activeIde = "auto";
  let walkQuickUnit = "steps"; // "steps" | "calories" | "km"
  let ocrWorkerPromise = null;
  let ocrScriptPromise = null;
  let pocketDimActive = false;
  let lastPocketDimTapAt = 0;
  let linearAccelSensor = null;
  let calcStepsPreview = 1000;
  let chaseTick = 0;
  let chaseTurboTicks = 0;
  let pairVisitSent = false;
  let howTick = 0;
  let gateTick = 0;
  let toastTimer = null;
  let waveHistory = [];
  let cachedChaseCols = 0;
  let lastMeasuredBayWidth = 0;
  let orStatusOverride = "";
  let prevRenderedSteps = null;
  let prevRenderedPrimary = null;
  let prevRenderedIsOrView = null;
  let prevStepSourceConnected = false;
  let hwAudioCtx = null;
  let qrModalReturnFocusEl = null;

  // Phone Companion mode & OS switcher state
  let walkActiveMode = "phone"; // "phone" | "health"
  let walkHealthOs =
    typeof navigator !== "undefined" && /android/i.test(navigator.userAgent || "")
      ? "android"
      : "ios";
  let healthLinkCopiedTimer = null;

  // Paired session context preserved even after URL query params are cleaned
  let sessionPairContext = {
    pairVaultId: "",
    syncVaultId: "",
    fieldToken: "",
    sourceParam: ""
  };

  // Live Phone Pedometer state (EMA gravity filter + hysteresis + batched cloud sync)
  let motionActive = false;
  let wakeLockSentinel = null;
  let syncedWalkSteps = 0;
  let pendingWalkSteps = 0;
  let walkFlushTimer = null;
  let walkFlushInFlight = false;
  let gEst = 0;
  let lastMotionSampleAt = 0;
  let stepArmed = false;
  let lastPeakTime = 0;
  let warmupBufferedSteps = 0;
  let inWalkingCadence = false;
  let numericMotionSampleSeen = false;

  /* ---------------- Pure Text-Free Character & Pixel Animations ---------------- */

  // Human sprinter (14 cols x 7 rows, crisp 2-col neck + separated limbs on all 4 poses)
  const MAN_POSES = [
    [
      "  ·   ▄██▄    ",
      "   ·  ▀██▀  ▄ ",
      "    ▄▀████▀▀█ ",
      "    ▀ ▐██▌    ",
      "     ▄█▀▀█▄   ",
      "    ▄▀    ▀▄  ",
      " · ▀▀      ▀▀ "
    ],
    [
      " ·    ·       ",
      "      ▄██▄    ",
      "  ·   ▀██▀ ▄  ",
      "     ▄████▀▀  ",
      "     ▀▐███▄   ",
      "     ▄▀██ ▀   ",
      "  ·  ▀ ▀▀▀    "
    ],
    [
      " ·    ▄██▄    ",
      "   ·  ▀██▀    ",
      "   ▀▄▄████▀▀▄ ",
      "      ▐██▌  ▀ ",
      "    ▄▄█▀▀█▄   ",
      "   ▄▀     ▀▄  ",
      " · ▀       ▀▀ "
    ],
    [
      "  ·     ·     ",
      "      ▄██▄    ",
      "   ·  ▀██▀    ",
      "    ▄▀████▀▄  ",
      "      ▐██▌    ",
      "     ▄█▌▐█▄   ",
      " ·   ▀▀  ▀▀▀  "
    ]
  ];

  // TWO-ARMED runaway CRT monitor (15 cols x 7 rows — both ╣ and ╠ arms pumping + centered eyes)
  const COMP_POSES = [
    [
      "   ╔═══════╗   ",
      "▀══╣ ▐▌ ▐▌ ╠══▄",
      " · ║  ▄▄▄  ║   ",
      "   ╚═╦═══╦═╝   ",
      "    ▄▀   ▀▄    ",
      "   ▄▀     ▀▄   ",
      "  ▀▀       ▀▀  "
    ],
    [
      "  ·         ·  ",
      "   ╔═══════╗   ",
      "▄══╣ ▐▌ ▐▌ ╠══▀",
      " · ║  ▄▄▄  ║   ",
      "   ╚═╦═══╦═╝   ",
      "     █▌ ▐█     ",
      "     ▀▀ ▀▀     "
    ],
    [
      "   ╔═══════╗   ",
      "▀══╣ ▐▌ ▐▌ ╠══▀",
      " · ║  ▄█▄  ║   ",
      "   ╚═╦═══╦═╝   ",
      "   ▄▀     ▀▄   ",
      "  ▀▀       ▀▀  ",
      " ·             "
    ],
    [
      " ·           · ",
      "   ╔═══════╗   ",
      "▄══╣ ▐▌ ▐▌ ╠══▀",
      " · ║  ▄▄▄  ║   ",
      "   ╚═╦═══╦═╝   ",
      "    ▄█▀ ▀█▄    ",
      "    ▀▀   ▀▀    "
    ]
  ];

  // HOW IT WORKS 01: WALK — True side-profile brisk walker with 2-col neck & pumping L-arms (24 x 10)
  const HOW_WALK_FRAMES = [
    [
      "         ▄████▄         ",
      "   ·      ▀██▀          ",
      "        ▄██████▄  ▄     ",
      "      ▄██▀████▀▀██▀     ",
      "     ██▀  ████          ",
      "     ▀    ████          ",
      "         ██▀▀██▄        ",
      "       ▄██    ▀██       ",
      "  ·   ██▀      ███▄     ",
      "════──════──════──════──"
    ],
    [
      "         ▄████▄         ",
      "    ·     ▀██▀          ",
      "        ▄██████▄        ",
      "       ██▀████▀██▄      ",
      "       ▀▄ ████  ▀█      ",
      "          ████          ",
      "         ▄█▀▀██         ",
      "       ▄██   ██         ",
      "   ·   ▀     ███▄       ",
      "═══──════──════──════──═"
    ],
    [
      "         ▄████▄         ",
      "     ·    ▀██▀          ",
      "        ▄██████▄        ",
      "       ▐█▌████▀██       ",
      "        ▀▀████  ▀       ",
      "          ████▄         ",
      "          ██████▄       ",
      "          ██  ██        ",
      "    ·     ███▄ ▀▄       ",
      "══──════──════──════──══"
    ],
    [
      "         ▄████▄         ",
      "  ·       ▀██▀          ",
      "        ▄██████▄  ▄     ",
      "      ▄██▀████▀▀██▀     ",
      "     ▐█▀  ████          ",
      "          ████          ",
      "        ▄██▀▀██▄        ",
      "       ██▀    ▀██       ",
      " ·    ██▄      ███▄     ",
      "═──════──════──════──══─"
    ],
    [
      "         ▄████▄         ",
      "   ·      ▀██▀          ",
      "        ▄██████▄        ",
      "       ▄█▀████▀█▄       ",
      "      ▐█▌ ████ ▀██      ",
      "       ▀  ████   ▀      ",
      "         ██▀▀██▄        ",
      "        ██    ██        ",
      "  ·    ███▄    ▀▄       ",
      "──════──════──════──══──"
    ],
    [
      "         ▄████▄         ",
      "    ·     ▀██▀          ",
      "        ▄██████▄        ",
      "      ▄██▀████▀▀█▄      ",
      "     ▐█▀  ████  ▀█      ",
      "          ████          ",
      "       ▄ ▐████▄         ",
      "       ▀██▀  ██         ",
      "   ·         ███▄       ",
      "─════──════──════──══──═"
    ]
  ];

  // HOW IT WORKS 02: PROMPT — Bilaterally symmetric 2-armed jumping computer ONLY (24 x 10, dead-center, zero battery)
  const HOW_COMPUTE_FRAMES = [
    [
      "                        ",
      "                        ",
      "       ╔════════╗       ",
      "    ▀══╣ ▀▀  ▀▀ ╠══▀    ",
      "       ║ ▀▄▄▄▄▀ ║       ",
      "       ╚══╦══╦══╝       ",
      "        ▄▀    ▀▄        ",
      "       ▀▀      ▀▀       ",
      "                        ",
      "                        "
    ],
    [
      "                        ",
      "    ·  ╔════════╗  ·    ",
      "    ▀══╣ ▀▀  ▀▀ ╠══▀    ",
      "       ║ ▀▄▄▄▄▀ ║       ",
      "       ╚══╦══╦══╝       ",
      "       ▄▀      ▀▄       ",
      "      ▀▀        ▀▀      ",
      "                        ",
      "                        ",
      "                        "
    ],
    [
      "                        ",
      "       ╔════════╗       ",
      "    ═══╣ ▀▀  ▀▀ ╠═══    ",
      "       ║  ▄▄▄▄  ║       ",
      "       ╚══╦══╦══╝       ",
      "        ▄▀    ▀▄        ",
      "        ▀▀    ▀▀        ",
      "                        ",
      "                        ",
      "                        "
    ],
    [
      "                        ",
      "                        ",
      "       ╔════════╗       ",
      "    ▄══╣ ██  ██ ╠══▄    ",
      "       ║  ▄▄▄▄  ║       ",
      "       ╚══╦══╦══╝       ",
      "          ║  ║          ",
      "         ▀▀  ▀▀         ",
      "                        ",
      "                        "
    ],
    [
      "                        ",
      "                        ",
      "                        ",
      "       ╔════════╗       ",
      "    ▄══╣ ██  ██ ╠══▄    ",
      "       ║  ▄▄▄▄  ║       ",
      "       ╚══╦══╦══╝       ",
      "         ▄█  █▄         ",
      "        ▀▀    ▀▀        ",
      "                        "
    ],
    [
      "                        ",
      "                        ",
      "       ╔════════╗       ",
      "    ═══╣ ▀▀  ▀▀ ╠═══    ",
      "       ║ ▀▄▄▄▄▀ ║       ",
      "       ╚══╦══╦══╝       ",
      "         █▌  ▐█         ",
      "         ▀▀  ▀▀         ",
      "                        ",
      "                        "
    ]
  ];

  // HOW IT WORKS 03: UH-OH — Centered padlock ONLY (24 x 10, cols 6..17 dead-center, shackle slam + locked shudder)
  const HOW_REPEAT_FRAMES = [
    [
      "                        ",
      "        ▄██████▄        ",
      "       ██▀    ▀██       ",
      "       ██      ██       ",
      "      ████████████      ",
      "      █████▀▀█████      ",
      "      █████  █████      ",
      "      █████▄▄█████      ",
      "      ▀██████████▀      ",
      "                        "
    ],
    [
      "                        ",
      "       ▄██████▄         ",
      "      ██▀    ▀██        ",
      "      ██      ██        ",
      "     ████████████       ",
      "     █████▀▀█████       ",
      "     █████  █████       ",
      "     █████▄▄█████       ",
      "     ▀██████████▀       ",
      "                        "
    ],
    [
      "                        ",
      "         ▄██████▄       ",
      "        ██▀    ▀██      ",
      "        ██      ██      ",
      "       ████████████     ",
      "       █████▀▀█████     ",
      "       █████  █████     ",
      "       █████▄▄█████     ",
      "       ▀██████████▀     ",
      "                        "
    ],
    [
      "        ▄██████▄        ",
      "       ██▀    ▀██       ",
      "       ▀▀      ██       ",
      "               ██       ",
      "      ████████████      ",
      "      █████▀▀█████      ",
      "      █████  █████      ",
      "      █████▄▄█████      ",
      "      ▀██████████▀      ",
      "                        "
    ],
    [
      "                        ",
      "        ▄██████▄        ",
      "       ██▀    ▀██       ",
      "       ▀       ██       ",
      "      ████████████      ",
      "      █████▀▀█████      ",
      "      █████  █████      ",
      "      █████▄▄█████      ",
      "      ▀██████████▀      ",
      "                        "
    ],
    [
      "                        ",
      "        ▄██████▄        ",
      "       ██▀    ▀██       ",
      "    ·  ██      ██  ·    ",
      "      ████████████      ",
      "      █████▀▀█████      ",
      "      █████  █████      ",
      "      █████▄▄█████      ",
      "      ▀██████████▀      ",
      "                        "
    ]
  ];

  // STEP 2 CARD A: Big X inside a solid circle morphing into a friendly winking smiley (24 x 11)
  const GATE_LOCAL_FRAMES = [
    [
      "      ▄▄████████▄▄      ",
      "   ▄██▀▀        ▀▀██▄   ",
      "  ██▀  ██▄    ▄██  ▀██  ",
      " ██     ▀██▄▄██▀     ██ ",
      "██        ████        ██",
      "██        ████        ██",
      "██       ▄████▄       ██",
      " ██    ▄██▀  ▀██▄    ██ ",
      "  ██▄  ▀▀      ▀▀  ▄██  ",
      "   ▀██▄▄        ▄▄██▀   ",
      "      ▀▀████████▀▀      "
    ],
    [
      "      ▄▄████████▄▄      ",
      "   ▄██▀▀        ▀▀██▄   ",
      "  ██▀  ██▄    ▄██  ▀██  ",
      " ██     ▀██▄▄██▀     ██ ",
      "██        ████        ██",
      "██        ████        ██",
      "██       ▄████▄       ██",
      " ██    ▄██▀  ▀██▄    ██ ",
      "  ██▄  ▀▀      ▀▀  ▄██  ",
      "   ▀██▄▄        ▄▄██▀   ",
      "      ▀▀████████▀▀      "
    ],
    [
      "      ▄▄████████▄▄      ",
      "   ▄██▀▀        ▀▀██▄   ",
      "  ██▀              ▀██  ",
      " ██     ██▄  ▄██     ██ ",
      "██       ▀████▀       ██",
      "██        ████        ██",
      "██       ▄████▄       ██",
      " ██     ██▀  ▀██     ██ ",
      "  ██▄              ▄██  ",
      "   ▀██▄▄        ▄▄██▀   ",
      "      ▀▀████████▀▀      "
    ],
    [
      "      ▄▄████████▄▄      ",
      "   ▄██▀▀        ▀▀██▄   ",
      "  ██▀              ▀██  ",
      " ██    ██      ██    ██ ",
      "██     ██      ██     ██",
      "██                    ██",
      "██     ██▄    ▄██     ██",
      " ██     ▀██████▀     ██ ",
      "  ██▄              ▄██  ",
      "   ▀██▄▄        ▄▄██▀   ",
      "      ▀▀████████▀▀      "
    ],
    [
      "      ▄▄████████▄▄      ",
      "   ▄██▀▀        ▀▀██▄   ",
      "  ██▀              ▀██  ",
      " ██    ██      ██    ██ ",
      "██     ██      ██     ██",
      "██                    ██",
      "██    ▀██▄    ▄██▀    ██",
      " ██     ▀██████▀     ██ ",
      "  ██▄              ▄██  ",
      "   ▀██▄▄        ▄▄██▀   ",
      "      ▀▀████████▀▀      "
    ],
    [
      "      ▄▄████████▄▄      ",
      "   ▄██▀▀        ▀▀██▄   ",
      "  ██▀              ▀██  ",
      " ██    ▄▄      ▄▄    ██ ",
      "██     ▀▀      ▀▀     ██",
      "██                    ██",
      "██    ▀██▄    ▄██▀    ██",
      " ██     ▀██████▀     ██ ",
      "  ██▄              ▄██  ",
      "   ▀██▄▄        ▄▄██▀   ",
      "      ▀▀████████▀▀      "
    ],
    [
      "      ▄▄████████▄▄      ",
      "   ▄██▀▀        ▀▀██▄   ",
      "  ██▀              ▀██  ",
      " ██    ██      ██    ██ ",
      "██     ██      ██     ██",
      "██                    ██",
      "██    ▀██▄    ▄██▀    ██",
      " ██     ▀██████▀     ██ ",
      "  ██▄              ▄██  ",
      "   ▀██▄▄        ▄▄██▀   ",
      "      ▀▀████████▀▀      "
    ],
    [
      "      ▄▄████████▄▄      ",
      "   ▄██▀▀        ▀▀██▄   ",
      "  ██▀              ▀██  ",
      " ██     ██▄  ▄██     ██ ",
      "██       ▀████▀       ██",
      "██        ████        ██",
      "██       ▄████▄       ██",
      " ██     ██▀  ▀██     ██ ",
      "  ██▄              ▄██  ",
      "   ▀██▄▄        ▄▄██▀   ",
      "      ▀▀████████▀▀      "
    ]
  ];

  // STEP 2 CARD B: Centered Lock (cols 11..20 on 32 x 11) + Key entering from left (cols 0..10) -> twists -> pops shackle open
  const GATE_KEY_FRAMES = [
    [
      "                                ",
      "             ▄████▄             ",
      "            ██▀  ▀██            ",
      "            ██    ██            ",
      " ▄██▄      ██████████           ",
      "██▀▀██     ████▀▀████           ",
      "██  ██████ ████  ████           ",
      "██▄▄██ █ █ ████▄▄████           ",
      " ▀██▀  ▀ ▀ ██████████           ",
      "           ▀████████▀           ",
      "                                "
    ],
    [
      "                                ",
      "             ▄████▄             ",
      "            ██▀  ▀██            ",
      "            ██    ██            ",
      "    ▄██▄   ██████████           ",
      "   ██▀▀██  ████▀▀████           ",
      "   ██  ████████  ████           ",
      "   ██▄▄██ █████▄▄████           ",
      "    ▀██▀  ▀██████████           ",
      "           ▀████████▀           ",
      "                                "
    ],
    [
      "                                ",
      "             ▄████▄             ",
      "            ██▀  ▀██            ",
      "            ██    ██            ",
      "      ▄██▄ ██████████           ",
      "     ██▀▀██████▀▀████           ",
      "     ██  ███████ ████           ",
      "     ██▄▄██████▄▄████           ",
      "      ▀██▀ ██████████           ",
      "           ▀████████▀           ",
      "                                "
    ],
    [
      "                                ",
      "             ▄████▄             ",
      "            ██▀  ▀██            ",
      "            ██    ██            ",
      "           ██████████           ",
      "      ▄██▄ ████▀▀████           ",
      "     ██  ████████████           ",
      "      ▀██▀ ████▄▄████           ",
      "           ██████████           ",
      "           ▀████████▀           ",
      "                                "
    ],
    [
      "          ·  ▄████▄  ·          ",
      "            ██▀  ▀██            ",
      "            ▀▀    ██            ",
      "                  ██            ",
      "           ██████████           ",
      "      ▄▄▄▄ ████▀▀████           ",
      "     ████████████████           ",
      "      ▀▀▀▀ ████▄▄████           ",
      "           ██████████           ",
      "           ▀████████▀           ",
      "                                "
    ],
    [
      "         ·   ▄████▄   ·         ",
      "            ██▀  ▀██            ",
      "            ▀▀    ██            ",
      "                  ██            ",
      "           ██████████           ",
      "      ▄▄▄▄ ████▀▀████           ",
      "     ████████████████           ",
      "      ▀▀▀▀ ████▄▄████           ",
      "           ██████████           ",
      "           ▀████████▀           ",
      "                                "
    ],
    [
      "             ▄████▄             ",
      "            ██▀  ▀██            ",
      "            ▀▀    ██            ",
      "                  ██            ",
      "    ▄██▄   ██████████           ",
      "   ██▀▀██  ████▀▀████           ",
      "   ██  ████████  ████           ",
      "   ██▄▄██ █████▄▄████           ",
      "    ▀██▀  ▀██████████           ",
      "           ▀████████▀           ",
      "                                "
    ],
    [
      "                                ",
      "             ▄████▄             ",
      "            ██▀  ▀██            ",
      "            ██    ██            ",
      "  ▄██▄     ██████████           ",
      " ██▀▀██    ████▀▀████           ",
      " ██  ██████████  ████           ",
      " ██▄▄██ █ █████▄▄████           ",
      "  ▀██▀  ▀ ▀██████████           ",
      "           ▀████████▀           ",
      "                                "
    ]
  ];

  const IDE_EXPLANATIONS = {
    auto:
      "Automatically finds Antigravity, Claude Code, Cursor, and Codex on your computer and locks them when your token balance hits zero.",
    antigravity:
      "Stops Antigravity from running new actions when your token balance hits zero, and unlocks as soon as you walk.",
    claude:
      "Stops Claude Code from sending new prompts when your token balance hits zero, and unlocks as soon as you walk.",
    cursor:
      "Stops Cursor from sending new chat or agent prompts when your token balance hits zero, and unlocks as soon as you walk.",
    codex:
      "Stops Codex from running new prompts when your token balance hits zero, and unlocks as soon as you walk."
  };

  const IDE_TECH_NOTES = {
    auto: "Checks ~/.gemini, ~/.claude, ~/.cursor, and ~/.codex (existing settings stay untouched)",
    antigravity: "Config file: ~/.gemini/config/hooks.json (existing settings stay untouched)",
    claude: "Config file: ~/.claude/settings.json (existing settings stay untouched)",
    cursor: "Config file: ~/.cursor/hooks.json (existing settings stay untouched)",
    codex: "Config file: ~/.codex/hooks.json (existing settings stay untouched)"
  };

  function prefersReducedMotion() {
    try {
      return Boolean(
        window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
      );
    } catch (_) {
      return false;
    }
  }

  function playHwTick(freq = 880, durMs = 9) {
    if (prefersReducedMotion()) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!hwAudioCtx) hwAudioCtx = new AC();
      if (hwAudioCtx.state === "suspended") {
        hwAudioCtx.resume().catch(() => {});
      }
      if (hwAudioCtx.state !== "running") return;
      const now = hwAudioCtx.currentTime;
      const osc = hwAudioCtx.createOscillator();
      const gain = hwAudioCtx.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(0.016, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + durMs / 1000);
      osc.connect(gain);
      gain.connect(hwAudioCtx.destination);
      osc.start(now);
      osc.stop(now + durMs / 1000 + 0.004);
    } catch (_) {}
  }

  function flashElement(el) {
    if (!el || prefersReducedMotion()) return;
    el.classList.remove("is-flashing");
    void el.offsetWidth;
    el.classList.add("is-flashing");
  }

  function buildAsciiBar(ratio, width) {
    const len = Math.max(10, Math.floor(width || 20));
    const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
    const filled = Math.round(clamped * len);
    return "[" + "█".repeat(filled) + "░".repeat(len - filled) + "]";
  }

  function buildChaseFrame(tick, width) {
    const W = Math.max(32, Math.floor(width || 68));
    const grid = [
      new Array(W).fill(" "),
      new Array(W).fill(" "),
      new Array(W).fill(" "),
      new Array(W).fill(" "),
      new Array(W).fill(" "),
      new Array(W).fill(" "),
      new Array(W).fill(" "),
      new Array(W).fill("═")
    ];

    const speedMult = chaseTurboTicks > 0 ? 3 : 2;
    for (let x = 0; x < W; x++) {
      if ((x + tick * speedMult) % 15 === 0) grid[0][x] = "·";
      if ((x + tick * (speedMult + 1) + 7) % 23 === 0) grid[4][x] = "·";
      if ((x + tick * speedMult) % 8 === 0) grid[7][x] = "╤";
    }

    // Camera-follow treadmill: sprinter on left ALWAYS chases 2-armed CRT on right, 100% unclipped on every viewport
    const manW = 14;
    const compW = 15;
    const slack = Math.max(3, W - (manW + compW));
    const baseGap = Math.max(3, Math.min(14, Math.floor(slack * 0.22)));
    const pairSpan = manW + baseGap + compW;
    const baseLeft = Math.max(0, Math.floor((W - pairSpan) / 2));

    const manWave = W >= 42 ? [0, 1, 2, 1, 0, -1, 0, 1][tick % 8] : 0;
    const compWave = W >= 42 ? [0, 0, 1, 2, 1, 0, -1, 0][tick % 8] : 0;
    const manX = Math.max(0, Math.min(W - compW - manW - 2, baseLeft + manWave));
    const compX = Math.max(manX + manW + 2, Math.min(W - compW, baseLeft + manW + baseGap + compWave));

    const manSprite = MAN_POSES[tick % MAN_POSES.length];
    const compSprite = COMP_POSES[tick % COMP_POSES.length];

    const stamp = (sprite, baseX) => {
      for (let r = 0; r < sprite.length; r++) {
        const rowStr = sprite[r];
        for (let c = 0; c < rowStr.length; c++) {
          const ch = rowStr[c];
          if (ch !== " ") {
            const x = baseX + c;
            if (x >= 0 && x < W) {
              grid[r][x] = ch;
            }
          }
        }
      }
    };

    stamp(manSprite, manX);
    stamp(compSprite, compX);

    return grid.map((r) => r.join("")).join("\n");
  }

  const SVG_SPRITE_CACHE = new Map();
  const GLYPH_RECTS_6X12 = {
    "█": [[0, 0, 6, 12]],
    "▀": [[0, 0, 6, 6]],
    "▄": [[0, 6, 6, 6]],
    "▌": [[0, 0, 3, 12]],
    "▐": [[3, 0, 3, 12]],
    "·": [[2, 5, 2, 2]],
    "─": [[0, 5, 6, 2]],
    "═": [[0, 3, 6, 2], [0, 7, 6, 2]],
    "║": [[0, 0, 2, 12], [4, 0, 2, 12]],
    "╔": [[0, 3, 6, 2], [0, 3, 2, 9], [4, 7, 2, 5]],
    "╗": [[0, 3, 6, 2], [4, 3, 2, 9], [0, 7, 2, 5]],
    "╚": [[0, 7, 6, 2], [0, 0, 2, 9], [4, 0, 2, 5]],
    "╝": [[0, 7, 6, 2], [4, 0, 2, 9], [0, 0, 2, 5]],
    "╠": [[0, 0, 2, 12], [4, 0, 2, 5], [4, 7, 2, 5], [4, 3, 2, 2]],
    "╣": [[4, 0, 2, 12], [0, 0, 2, 5], [0, 7, 2, 5], [0, 3, 2, 2]],
    "╦": [[0, 3, 6, 2], [0, 7, 2, 5], [4, 7, 2, 5]],
    "╤": [[0, 3, 6, 2], [0, 7, 6, 2], [2, 9, 2, 3]]
  };

  function rowsToCrispSvg(rows, modClass) {
    const key = modClass + "|" + rows.join("\n");
    const hit = SVG_SPRITE_CACHE.get(key);
    if (hit) return hit;

    const R = rows.length;
    let C = 0;
    for (let r = 0; r < R; r++) {
      if (rows[r].length > C) C = rows[r].length;
    }
    const W = Math.max(6, C * 6);
    const H = Math.max(12, R * 12);
    const bmp = new Uint8Array(W * H);

    for (let r = 0; r < R; r++) {
      const rowStr = rows[r];
      const by = r * 12;
      for (let c = 0; c < rowStr.length; c++) {
        const ch = rowStr[c];
        if (ch === " ") continue;
        const rects = GLYPH_RECTS_6X12[ch];
        if (!rects) continue;
        const bx = c * 6;
        for (let k = 0; k < rects.length; k++) {
          const [rx, ry, rw, rh] = rects[k];
          for (let py = by + ry; py < by + ry + rh; py++) {
            const off = py * W;
            for (let px = bx + rx; px < bx + rx + rw; px++) {
              bmp[off + px] = 1;
            }
          }
        }
      }
    }

    // Merge horizontal runs AND vertical identical spans into solid seamless subpaths
    const rowRuns = new Array(H);
    for (let y = 0; y < H; y++) {
      const runs = [];
      const off = y * W;
      let x = 0;
      while (x < W) {
        if (bmp[off + x]) {
          const x0 = x;
          while (x < W && bmp[off + x]) x++;
          runs.push([x0, x - x0]);
        } else {
          x++;
        }
      }
      rowRuns[y] = runs;
    }

    let d = "";
    const active = new Map();
    for (let y = 0; y <= H; y++) {
      const nextKeys = new Set();
      if (y < H) {
        const runs = rowRuns[y];
        for (let i = 0; i < runs.length; i++) {
          const [x0, w] = runs[i];
          const rk = x0 + ":" + w;
          nextKeys.add(rk);
          if (!active.has(rk)) {
            active.set(rk, { x: x0, w, y0: y });
          }
        }
      }
      for (const [rk, rect] of Array.from(active.entries())) {
        if (!nextKeys.has(rk)) {
          const h = y - rect.y0;
          d += "M" + rect.x + " " + rect.y0 + "h" + rect.w + "v" + h + "H" + rect.x + "Z";
          active.delete(rk);
        }
      }
    }

    const spec = { W, H, d };
    if (SVG_SPRITE_CACHE.size > 256) SVG_SPRITE_CACHE.clear();
    SVG_SPRITE_CACHE.set(key, spec);
    return spec;
  }

  function renderSpriteInto(el, rows, modClass) {
    if (!el) return;
    const spec = rowsToCrispSvg(rows, modClass);
    if (el.__lastSpec === spec && el.__svgEl && el.__svgEl.parentNode === el) return;
    el.__lastSpec = spec;
    const vb = "0 0 " + spec.W + " " + spec.H;
    const cls = "pixel-sprite-svg " + modClass;
    if (!el.__svgEl || !el.__pathEl || el.__svgEl.parentNode !== el) {
      const ns = "http://www.w3.org/2000/svg";
      const svgEl = document.createElementNS(ns, "svg");
      svgEl.setAttribute("class", cls);
      svgEl.setAttribute("viewBox", vb);
      svgEl.setAttribute("shape-rendering", "crispEdges");
      svgEl.setAttribute("aria-hidden", "true");
      const pathEl = document.createElementNS(ns, "path");
      pathEl.setAttribute("fill", "currentColor");
      pathEl.setAttribute("d", spec.d);
      svgEl.appendChild(pathEl);
      el.textContent = "";
      el.appendChild(svgEl);
      el.__svgEl = svgEl;
      el.__pathEl = pathEl;
      el.__lastVb = vb;
      el.__lastCls = cls;
      return;
    }
    if (el.__lastCls !== cls) {
      el.__svgEl.setAttribute("class", cls);
      el.__lastCls = cls;
    }
    if (el.__lastVb !== vb) {
      el.__svgEl.setAttribute("viewBox", vb);
      el.__lastVb = vb;
    }
    el.__pathEl.setAttribute("d", spec.d);
  }

  function measureChaseCols(el) {
    const bay = el.parentElement;
    if (!bay) return 96;
    const availPx = Math.max(180, bay.clientWidth || 0);
    if (cachedChaseCols > 0 && Math.abs(availPx - lastMeasuredBayWidth) < 2) {
      return cachedChaseCols;
    }
    const vw = window.innerWidth || 1440;
    const targetHeightPx = vw <= 374 ? 84 : vw <= 560 ? 92 : vw <= 920 ? 104 : 114;
    lastMeasuredBayWidth = availPx;
    cachedChaseCols = Math.max(36, Math.min(180, Math.round((availPx * 16) / targetHeightPx)));
    return cachedChaseCols;
  }

  function renderChaseFrame() {
    const el = $("hero-ascii-art");
    if (!el) return;
    const w = measureChaseCols(el);
    const rows = buildChaseFrame(chaseTick, w).split("\n");
    renderSpriteInto(el, rows, "pixel-sprite-svg--chase");
  }

  function renderHowFrames() {
    const walkEl = $("how-ascii-walk");
    const earnEl = $("how-ascii-earn");
    const repEl = $("how-ascii-repeat");
    const idx = howTick % HOW_WALK_FRAMES.length;
    renderSpriteInto(walkEl, HOW_WALK_FRAMES[idx], "pixel-sprite-svg--how");
    renderSpriteInto(earnEl, HOW_COMPUTE_FRAMES[idx], "pixel-sprite-svg--how");
    renderSpriteInto(repEl, HOW_REPEAT_FRAMES[idx], "pixel-sprite-svg--how");
  }

  function renderGatePickerFrames() {
    const localEl = $("gate-ascii-local");
    const keyEl = $("gate-ascii-key");
    const idx = gateTick % GATE_LOCAL_FRAMES.length;
    renderSpriteInto(localEl, GATE_LOCAL_FRAMES[idx], "pixel-sprite-svg--gate");
    renderSpriteInto(keyEl, GATE_KEY_FRAMES[idx], "pixel-sprite-svg--gate");
  }

  function formatInt(n) {
    return Math.max(0, Math.floor(Number(n) || 0)).toLocaleString("en-US");
  }

  function formatUsd(val) {
    const n = Math.max(0, Number(val) || 0);
    if (n <= 0) return "$0.00";
    if (n < 0.001) return "$" + n.toFixed(4);
    if (n < 0.01) return "$" + n.toFixed(3);
    return "$" + n.toFixed(2);
  }

  function shortMask(keyStr) {
    const s = String(keyStr || "").trim();
    if (!s) return "";
    if (s.length <= 18) return s;
    return s.slice(0, 13) + "..." + s.slice(-4);
  }

  function formatSourceName(src) {
    return String(src || "")
      .replace(/_/g, " ")
      .toUpperCase();
  }

  function getMintedKeyInfoSafe() {
    if (!window.RuntimeGate || typeof window.RuntimeGate.getMintedKeyInfo !== "function") {
      return null;
    }
    try {
      return window.RuntimeGate.getMintedKeyInfo();
    } catch (_) {
      return null;
    }
  }

  function showToast(msg) {
    const el = $("toast");
    if (!el) return;
    el.textContent = "";
    void el.offsetWidth;
    el.textContent = msg;
    el.classList.add("is-visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove("is-visible");
      el.textContent = "";
    }, 2600);
  }

  function copyText(text, label) {
    if (!text) return;
    playHwTick(1040, 8);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => showToast(label || "COPIED"),
        () => fallbackCopy(text, label)
      );
    } else {
      fallbackCopy(text, label);
    }
  }

  function fallbackCopy(text, label) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (_) {}
    document.body.removeChild(ta);
    showToast(label || "COPIED");
  }

  function getUrlSyncAndPairParams() {
    try {
      const sp = new URLSearchParams(window.location.search || "");
      let pairVaultId = (sp.get("pair") || "").trim();
      let syncVaultId = (sp.get("sync") || "").trim();
      let fieldToken = (sp.get("ft") || "").trim();
      let stepsParam = sp.get("steps");
      let calParam = sp.get("calories") || sp.get("kcal") || sp.get("cal");
      let kmParam = sp.get("km") || sp.get("distance");
      let sharedParam = sp.get("shared");
      let hasStepsKey = sp.has("steps");
      let sourceParam = (sp.get("source") || "").trim();
      if (!pairVaultId && !syncVaultId && window.location.hash && window.location.hash.includes("?")) {
        const q = window.location.hash.split("?")[1] || "";
        const hp = new URLSearchParams(q);
        pairVaultId = (hp.get("pair") || "").trim();
        syncVaultId = (hp.get("sync") || "").trim();
        fieldToken = fieldToken || (hp.get("ft") || "").trim();
        stepsParam = stepsParam !== null ? stepsParam : hp.get("steps");
        calParam = calParam !== null ? calParam : (hp.get("calories") || hp.get("kcal") || hp.get("cal"));
        kmParam = kmParam !== null ? kmParam : (hp.get("km") || hp.get("distance"));
        sharedParam = sharedParam !== null ? sharedParam : hp.get("shared");
        hasStepsKey = hasStepsKey || hp.has("steps");
        sourceParam = (hp.get("source") || sourceParam).trim();
      }
      if (pairVaultId) sessionPairContext.pairVaultId = pairVaultId;
      if (syncVaultId) sessionPairContext.syncVaultId = syncVaultId;
      if (fieldToken) sessionPairContext.fieldToken = fieldToken;
      if (sourceParam) sessionPairContext.sourceParam = sourceParam;
      return {
        pairVaultId: pairVaultId || sessionPairContext.pairVaultId,
        syncVaultId: syncVaultId || sessionPairContext.syncVaultId,
        rawUrlSyncVaultId: syncVaultId,
        rawUrlPairVaultId: pairVaultId,
        fieldToken: fieldToken || sessionPairContext.fieldToken,
        stepsParam,
        calParam,
        kmParam,
        sharedParam,
        hasStepsKey,
        sourceParam: sourceParam || sessionPairContext.sourceParam || ""
      };
    } catch (_) {
      return {
        pairVaultId: sessionPairContext.pairVaultId,
        syncVaultId: sessionPairContext.syncVaultId,
        rawUrlSyncVaultId: "",
        rawUrlPairVaultId: "",
        fieldToken: sessionPairContext.fieldToken,
        stepsParam: null,
        calParam: null,
        kmParam: null,
        sharedParam: null,
        hasStepsKey: false,
        sourceParam: sessionPairContext.sourceParam || ""
      };
    }
  }

  // Strict 2-color (#000000 on #ff0400) QR with 4-module quiet zone
  function renderMonochromeQR(targetEl, customUrl) {
    if (!targetEl || !window.RuntimeQR || !window.RuntimeGate) return;
    const url = customUrl || window.RuntimeGate.getPairUrl();
    targetEl.innerHTML = window.RuntimeQR.renderQRSVG(url, {
      fg: "#000000",
      bg: "var(--red)",
      margin: 4
    });
  }

  function renderAllStepQrSlots() {
    renderMonochromeQR($("setup-qr-slot"));
    renderMonochromeQR($("setup-qr-slot-mobile"));
  }

  function setBackgroundInert(isInert) {
    const topbar = document.querySelector(".topbar");
    const main = document.querySelector("main");
    [topbar, main].forEach((node) => {
      if (!node) return;
      try {
        node.inert = Boolean(isInert);
      } catch (_) {}
      if (isInert) node.setAttribute("aria-hidden", "true");
      else node.removeAttribute("aria-hidden");
    });
  }

  function openQrModal() {
    const modal = $("qr-modal");
    if (!modal) return;
    qrModalReturnFocusEl = document.activeElement;
    playHwTick(960, 10);
    renderMonochromeQR($("modal-qr-slot"));
    setBackgroundInert(true);
    modal.hidden = false;
    const closeBtn = $("qr-modal-close-btn");
    if (closeBtn) closeBtn.focus();
  }

  function closeQrModal() {
    const modal = $("qr-modal");
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    setBackgroundInert(false);
    if (qrModalReturnFocusEl && typeof qrModalReturnFocusEl.focus === "function") {
      try {
        qrModalReturnFocusEl.focus();
      } catch (_) {}
      qrModalReturnFocusEl = null;
    }
  }

  function renderGateView() {
    const isWalkthrough = gateSubView === "walkthrough";
    const isOr = activePath === "openrouter";

    if ($("gate-picker-view")) $("gate-picker-view").hidden = isWalkthrough;
    if ($("gate-walkthrough-view")) $("gate-walkthrough-view").hidden = !isWalkthrough;

    if ($("gate-picker-lead")) {
      $("gate-picker-lead").textContent = !isWalkthrough
        ? "When your steps hit zero, RUNTIME stops your AI. Pick how you want to gate it:"
        : isOr
          ? "Create an OpenRouter key whose spending limit goes up as you walk and cuts off at $0.00."
          : "Block your local coding agent when your step balance hits zero — works with your existing subscription.";
    }

    if ($("gate-title")) {
      if (!isWalkthrough) {
        $("gate-title").textContent = "CONNECT YOUR GATE";
      } else {
        $("gate-title").textContent = isOr ? "MINT API KEY" : "BLOCK LOCAL AGENT";
      }
    }

    if ($("gate-back-btn")) {
      $("gate-back-btn").innerHTML = isWalkthrough
        ? '<span class="btn-lbl"><span class="nw">[ &lt;-</span> PICK DIFFERENT <span class="nw">GATE ]</span></span>'
        : '<span class="btn-lbl"><span class="nw">[ &lt;-</span> STEP 1: <span class="nw">STEPS ]</span></span>';
    }

    if ($("setup-ide-block")) $("setup-ide-block").hidden = isOr;
    if ($("setup-or-block")) $("setup-or-block").hidden = !isOr;

    if (!isWalkthrough) {
      renderGatePickerFrames();
    } else {
      renderIdeSnippets();
    }
  }

  function openGatePicker(pushHistory) {
    gateSubView = "picker";
    showScreen("gate", pushHistory);
  }

  function openGateWalkthrough(pathKind, pushHistory) {
    activePath = pathKind === "openrouter" ? "openrouter" : "ide";
    gateSubView = "walkthrough";
    if (window.RuntimeGate) {
      window.RuntimeGate.setGateConfig({ gatePath: activePath });
    }
    showScreen("gate", pushHistory);
  }

  function computeTargetHash(target) {
    if (target === "landing") return "";
    if (target === "gate" && gateSubView === "walkthrough") {
      return activePath === "openrouter" ? "#gate/key" : "#gate/local";
    }
    return "#" + target;
  }

  function showScreen(name, pushHistory) {
    closeQrModal();
    const target = ALL_SCREENS.includes(name) ? name : "landing";
    currentScreen = target;

    ALL_SCREENS.forEach((s) => {
      const el = $("screen-" + s);
      if (el) el.hidden = s !== target;
    });

    if ($("topbar-setup-btn")) {
      $("topbar-setup-btn").hidden =
        target === "landing" ||
        target === "steps" ||
        target === "gate" ||
        target === "console" ||
        target === "walk";
    }

    if ($("how-back-btn")) {
      $("how-back-btn").innerHTML =
        howReturnScreen === "console"
          ? '<span class="btn-lbl"><span class="nw">[ &lt;-</span> LIVE <span class="nw">TRACKER ]</span></span>'
          : '<span class="btn-lbl"><span class="nw">[ &lt;-</span> <span class="nw">BACK ]</span></span>';
    }

    if ($("rate-back-btn")) {
      $("rate-back-btn").innerHTML =
        rateReturnScreen === "console"
          ? '<span class="btn-lbl"><span class="nw">[ &lt;-</span> LIVE <span class="nw">TRACKER ]</span></span>'
          : '<span class="btn-lbl"><span class="nw">[ &lt;-</span> HOW IT <span class="nw">WORKS ]</span></span>';
    }

    if ($("rate-next-btn")) {
      $("rate-next-btn").innerHTML =
        rateReturnScreen === "console"
          ? '<span class="btn-lbl"><span class="nw">[ &lt;-</span> BACK TO LIVE <span class="nw">TRACKER ]</span></span>'
          : '<span class="btn-lbl"><span class="nw">[ STEP 1:</span> CONNECT YOUR <span class="nw">STEPS -&gt; ]</span></span>';
    }

    const isPairedStandalonePhone =
      Boolean(sessionPairContext.pairVaultId || sessionPairContext.syncVaultId) &&
      !walkOpenedFromSteps;

    if ($("walk-back-btn")) {
      $("walk-back-btn").hidden = isPairedStandalonePhone;
      $("walk-back-btn").innerHTML = walkOpenedFromSteps
        ? '<span class="btn-lbl"><span class="nw">[ &lt;-</span> <span class="nw">STEP 1 ]</span></span>'
        : '<span class="btn-lbl"><span class="nw">[ &lt;-</span> <span class="nw">TRACKER ]</span></span>';
    }
    if ($("walk-continue-wrap")) {
      $("walk-continue-wrap").hidden = !walkOpenedFromSteps;
    }

    if (pushHistory) {
      const targetHash = computeTargetHash(target);
      const keepSearch = target === "walk" ? window.location.search : "";
      const nextUrl = window.location.pathname + keepSearch + targetHash;
      const curUrl = window.location.pathname + window.location.search + window.location.hash;
      if (nextUrl !== curUrl) {
        history.pushState({ screen: target, gateSubView, activePath }, "", nextUrl);
      }
    }

    if (target === "landing") {
      cachedChaseCols = 0;
      renderChaseFrame();
    } else if (target === "how") {
      renderHowFrames();
    } else if (target === "rate") {
      renderCalculator();
    } else if (target === "steps") {
      renderAllStepQrSlots();
      if (window.RuntimeGate) renderState(window.RuntimeGate.getState());
    } else if (target === "gate") {
      renderGateView();
      if (window.RuntimeGate) renderState(window.RuntimeGate.getState());
    } else if (target === "console") {
      if (window.RuntimeGate) renderState(window.RuntimeGate.getState());
    }

    window.scrollTo({ top: 0, behavior: "instant" });
    syncStickyDockVisibility();

    if (pushHistory) {
      const headingMap = {
        landing: "get-steppin-btn",
        how: "how-title",
        rate: "rate-title",
        steps: "steps-title",
        gate: "gate-title",
        console: "gate-status-stamp",
        walk: "walk-heading"
      };
      const hEl = $(headingMap[target]);
      if (hEl && typeof hEl.focus === "function") {
        try {
          hEl.focus({ preventScroll: true });
        } catch (_) {}
      }
    }
  }

  function renderCalculator() {
    if (!window.RuntimeGate || typeof window.RuntimeGate.calculateSteps !== "function") return;
    const st = window.RuntimeGate.getState();
    const c = window.RuntimeGate.calculateSteps(calcStepsPreview, st.tokensPerStep);
    const diffLabel = (c.difficulty || "standard").toUpperCase();
    const per1k = window.RuntimeGate.calculateSteps(1000, st.tokensPerStep);

    if ($("how-calc-slider")) {
      if (Number($("how-calc-slider").value) !== c.steps) {
        $("how-calc-slider").value = String(c.steps);
      }
      $("how-calc-slider").setAttribute(
        "aria-valuetext",
        formatInt(c.steps) +
          " steps: " +
          formatInt(c.tokens) +
          " tokens or " +
          formatUsd(c.usd) +
          " OpenRouter credit"
      );
    }

    document.querySelectorAll(".preset-btn[data-difficulty]").forEach((btn) => {
      const active = btn.dataset.difficulty === c.difficulty;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-checked", active ? "true" : "false");
      btn.setAttribute("tabindex", active ? "0" : "-1");
    });

    if ($("how-calc-effort")) {
      $("how-calc-effort").textContent =
        formatInt(c.steps) + " STEPS (~" + c.minutesApprox + " MIN WALK · " + c.kcalApprox + " CAL)";
    }
    if ($("how-calc-meter")) {
      const pct = Math.max(2, Math.min(100, Math.round((c.steps / 20000) * 100)));
      const barCols = window.innerWidth <= 480 ? 14 : 20;
      const barStr = buildAsciiBar(c.steps / 20000, barCols);
      const barSpan = $("how-calc-meter").querySelector(".calc-meter-bar");
      const txtSpan = $("how-calc-meter").querySelector(".calc-meter-text");
      if (barSpan && txtSpan) {
        barSpan.textContent = barStr;
        txtSpan.textContent = pct + "% OF 20,000 STEPS";
      } else {
        $("how-calc-meter").textContent = barStr + " " + pct + "% OF 20,000 STEPS";
      }
    }
    if ($("how-calc-steps")) $("how-calc-steps").textContent = formatInt(c.steps);
    if ($("how-calc-time")) {
      $("how-calc-time").textContent =
        "STEPS (~" + c.minutesApprox + " MIN · " + c.kmApprox + " KM)";
    }
    if ($("how-calc-tokens")) {
      $("how-calc-tokens").textContent = formatInt(c.tokens);
    }
    if ($("how-calc-turns")) {
      $("how-calc-turns").textContent = "TOKENS (~" + c.turns + " AGENT TURNS)";
    }
    if ($("how-calc-usd")) {
      $("how-calc-usd").textContent = formatUsd(c.usd);
    }
    if ($("how-calc-rate-note")) {
      $("how-calc-rate-note").textContent =
        diffLabel +
        ": 1,000 STEPS = " +
        formatInt(per1k.tokens) +
        " TOKENS (~" +
        per1k.turns +
        " TURNS) OR " +
        formatUsd(per1k.usd) +
        " CREDIT";
    }
  }

  function renderIdeSnippets() {
    if (!window.RuntimeGate) return;
    const snippets = window.RuntimeGate.getSnippets();
    const cmd = snippets[activeIde] || snippets.auto || snippets.antigravity || "";

    if ($("setup-ide-cmd")) $("setup-ide-cmd").textContent = cmd;
    if ($("setup-ide-explain")) {
      $("setup-ide-explain").textContent =
        IDE_EXPLANATIONS[activeIde] || IDE_EXPLANATIONS.auto;
    }
    if ($("setup-ide-tech-note")) {
      $("setup-ide-tech-note").textContent =
        IDE_TECH_NOTES[activeIde] || IDE_TECH_NOTES.auto;
    }

    document.querySelectorAll(".setup-ide-tab").forEach((tab) => {
      const active = tab.dataset.ide === activeIde;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-checked", active ? "true" : "false");
      tab.setAttribute("tabindex", active ? "0" : "-1");
    });
  }

  function formatOpenRouterError(err) {
    const status = err && Number(err.status) ? Number(err.status) : 0;
    const rawMsg = err && err.message ? String(err.message) : String(err || "");

    if (status === 401 || status === 403 || /invalid|unauthorized|401|403|provisioning/i.test(rawMsg)) {
      return "ERROR: OpenRouter rejected that key. Make sure you created a Provisioning Key from Step 1 — regular chat keys won't work.";
    }
    if (status === 429 || status >= 500) {
      return "ERROR: OpenRouter is temporarily unavailable (HTTP " + status + "). Wait a moment and try again.";
    }
    if (/failed to fetch|networkerror|load failed/i.test(rawMsg)) {
      return "ERROR: Couldn't reach OpenRouter. Check your internet connection and try again.";
    }
    return "ERROR: " + rawMsg.replace(/^error:\s*/i, "");
  }

  // Note #14: High-contrast hardware fuel spectrum (>= 5.26:1 to 13.8:1 contrast vs #000000 at every point)
  const FUEL_COLOR_STOPS = [
    { r: 0.0, rgb: [255, 4, 0] },     // #ff0400 — 0 tokens (Locked Red)
    { r: 0.2, rgb: [255, 94, 0] },    // #ff5e00 — Warming Orange
    { r: 0.45, rgb: [255, 208, 0] },  // #ffd000 — Solar Yellow
    { r: 0.72, rgb: [134, 232, 36] }, // #86e824 — Electric Lime
    { r: 1.0, rgb: [30, 230, 86] },   // #1ee656 — 100% Tank Bright Green (Ready to Code!)
    { r: 1.25, rgb: [28, 226, 184] }, // #1ce2b8 — Luminous Mint-Aqua
    { r: 1.5, rgb: [56, 203, 255] }   // #38cbff — 150%+ Overcharged Sky Blue
  ];

  let lastAppliedFuelHex = "";

  function computeFuelColorHex(tankRatio) {
    const ratio = Number.isFinite(tankRatio) ? tankRatio : 0;
    if (ratio <= 0) return "#ff0400";
    const last = FUEL_COLOR_STOPS[FUEL_COLOR_STOPS.length - 1];
    if (ratio >= last.r) {
      return (
        "#" +
        last.rgb.map((v) => v.toString(16).padStart(2, "0")).join("")
      );
    }
    for (let i = 0; i < FUEL_COLOR_STOPS.length - 1; i++) {
      const a = FUEL_COLOR_STOPS[i];
      const b = FUEL_COLOR_STOPS[i + 1];
      if (ratio >= a.r && ratio <= b.r) {
        const span = Math.max(0.0001, b.r - a.r);
        const t = Math.max(0, Math.min(1, (ratio - a.r) / span));
        const rgb = [
          Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * t),
          Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * t),
          Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * t)
        ];
        return "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
      }
    }
    return "#ff0400";
  }

  function syncThemeFuelColor(st) {
    if (!st || typeof document === "undefined" || !document.documentElement) return;
    const isOrView = activePath === "openrouter" || st.gatePath === "openrouter";
    const per1k =
      window.RuntimeGate && typeof window.RuntimeGate.calculateSteps === "function"
        ? window.RuntimeGate.calculateSteps(1000, st.tokensPerStep)
        : { tokens: 25000, usd: 0.5 };
    const pendingExtra = Math.max(0, Number(pendingWalkSteps) || 0);
    let avail = 0;
    let fullTank = 1;
    if (isOrView) {
      avail =
        Math.max(0, Number(st.creditAvailableUsd || 0)) +
        pendingExtra * Number(st.usdPerStep || 0.0005);
      fullTank = Math.max(0.05, Number(per1k.usd || 0.5));
    } else {
      avail =
        Math.max(0, Number(st.tokensAvailable || 0)) +
        pendingExtra * Math.max(1, Number(st.tokensPerStep || 25));
      fullTank = Math.max(2500, Number(per1k.tokens || 25000));
    }
    const ratio = avail <= 0 ? 0 : avail / fullTank;
    const nextHex = computeFuelColorHex(ratio);
    if (nextHex !== lastAppliedFuelHex) {
      lastAppliedFuelHex = nextHex;
      document.documentElement.style.setProperty("--red", nextHex);
    }
  }

  function renderFuelTank(st, isOrView, per1k) {
    const barEl = $("hud-fuel-bar");
    const lblEl = $("hud-fuel-label");
    if (!barEl || !lblEl) return;

    const fullTankUnits = isOrView ? Math.max(0.05, per1k.usd) : Math.max(2500, per1k.tokens);
    const currentAvail = isOrView ? Number(st.creditAvailableUsd || 0) : Number(st.tokensAvailable || 0);
    const rawPct = fullTankUnits > 0 ? Math.round((currentAvail / fullTankUnits) * 100) : 0;
    const barCols = window.innerWidth <= 560 ? 16 : 28;
    const barStr = buildAsciiBar(currentAvail / fullTankUnits, barCols);
    barEl.textContent = barStr;

    if (currentAvail <= 0) {
      lblEl.textContent = "0% TANK · EMPTY — GO WALK";
    } else if (rawPct >= 100) {
      lblEl.textContent = "100% TANK (1,000+ STEPS) · FULL — GO CODE";
    } else {
      lblEl.textContent = rawPct + "% TANK · UNLOCKED";
    }
  }

  function renderStepsConnectionBox(st) {
    const stepDevs = Array.isArray(st.devices)
      ? st.devices.filter(
          (d) => !/^(demo|manual|test)$/i.test(String(d || "").trim()) && !/^agent_/i.test(String(d || "").trim())
        )
      : [];
    const hasStepsOrDevice = stepDevs.length > 0 || Number(st.stepsTotal || 0) > 0;
    const phoneOpenedAtDesk = !hasStepsOrDevice && Number(st.pairedAt || 0) > 0;
    const isMobileViewport = typeof window !== "undefined" && window.innerWidth <= 768;

    const connLabel = $("steps-conn-label");
    const connSub = $("steps-conn-sub");
    const liveBox = connLabel ? connLabel.closest(".steps-live-box") : null;

    if (liveBox) {
      liveBox.classList.toggle("is-linked", hasStepsOrDevice || phoneOpenedAtDesk);
    }

    if (hasStepsOrDevice) {
      if (!prevStepSourceConnected && currentScreen === "steps") {
        playHwTick(1320, 14);
      }
      prevStepSourceConnected = true;
      const srcList = stepDevs.length
        ? stepDevs.map(formatSourceName).join(", ")
        : "STEP COUNTER";
      if (connLabel) {
        connLabel.textContent = "CONNECTED · " + formatInt(st.stepsTotal) + " STEPS SYNCED";
      }
      if (connSub) {
        connSub.textContent =
          "Source: " + srcList + " · Ready for Step 2 (Connect Your Gate).";
      }
    } else if (phoneOpenedAtDesk) {
      if (!prevStepSourceConnected && currentScreen === "steps") {
        playHwTick(1180, 12);
      }
      prevStepSourceConnected = true;
      if (connLabel) {
        connLabel.textContent = "PHONE OPENED — READY TO WALK";
      }
      if (connSub) {
        connSub.textContent =
          "Tap [ START WALKING ] on your phone — or click Next below to finish Step 2 right now.";
      }
    } else {
      prevStepSourceConnected = false;
      if (connLabel) {
        connLabel.textContent = isMobileViewport
          ? "NO STEPS COUNTED YET"
          : "WAITING FOR PHONE...";
      }
      if (connSub) {
        connSub.textContent = isMobileViewport
          ? "Start your pocket counter or WHOOP check-in above, or jump straight to Step 2."
          : "0 steps synced yet · Set up Step 2 now, or log a WHOOP or watch workout below.";
      }
    }
  }

  function renderState(st) {
    if (!st) return;

    if (st.selectedIde && IDE_EXPLANATIONS[st.selectedIde]) {
      activeIde = st.selectedIde;
    }

    const connected = Boolean(st.isConnected);
    const statusBtn = $("topbar-status-btn");
    const statusLabel = $("topbar-status-label");
    if (statusBtn && statusLabel) {
      statusBtn.classList.toggle("is-connected", connected);
      statusLabel.textContent = connected ? "CONNECTED" : "DISCONNECTED";
    }

    // Live Note #7: ONLY show [ LIVE TRACKER -> ] on Landing when user has actually connected!
    if ($("landing-tracker-btn")) {
      $("landing-tracker-btn").hidden = !connected;
    }

    renderStepsConnectionBox(st);

    const stepsText = formatInt(st.stepsTotal);
    const tokText = formatInt(st.tokensAvailable);
    const usdText = formatUsd(st.creditAvailableUsd);
    const minted = getMintedKeyInfoSafe();
    const isOrView = activePath === "openrouter";

    const statusEl = $("or-key-status");
    const hasMintedKey = Boolean(minted && (minted.mintedKey || minted.label));
    const inputVal = ($("or-prov-key-input") ? $("or-prov-key-input").value : "").trim();
    if ($("clear-or-key-btn")) {
      $("clear-or-key-btn").hidden = !(hasMintedKey || inputVal.length > 0);
    }

    if (statusEl) {
      const isErr = Boolean(orStatusOverride && orStatusOverride.startsWith("ERROR:"));
      statusEl.classList.toggle("is-error", isErr);
      if ($("or-prov-key-input")) {
        $("or-prov-key-input").setAttribute("aria-invalid", isErr ? "true" : "false");
      }

      if (orStatusOverride) {
        statusEl.textContent = orStatusOverride;
      } else if (hasMintedKey) {
        const capInfo = st.orSyncError
          ? " — SYNC WARNING: " + st.orSyncError
          : " · Current spend limit: " + usdText;
        statusEl.textContent =
          "KEY READY: " + shortMask(minted.mintedKey || minted.label) + capInfo;
      } else {
        statusEl.textContent =
          "Paste your Provisioning Key above. It stays in this browser and is never sent to our servers.";
      }
    }

    const showMintedBox = Boolean(minted && minted.mintedKey);
    if ($("setup-minted-box")) $("setup-minted-box").hidden = !showMintedBox;
    if ($("setup-minted-placeholder")) $("setup-minted-placeholder").hidden = showMintedBox;
    if ($("setup-minted-val")) {
      $("setup-minted-val").textContent = showMintedBox ? shortMask(minted.mintedKey) : "";
    }
    if ($("console-copy-key-btn")) {
      $("console-copy-key-btn").hidden = !(isOrView && showMintedBox);
    }

    const per1k = window.RuntimeGate.calculateSteps(1000, st.tokensPerStep);
    if ($("hud-mode-rate")) {
      $("hud-mode-rate").textContent = isOrView
        ? "OPENROUTER KEY · 1,000 STEPS = " + formatUsd(per1k.usd)
        : "LOCAL AGENT · 1,000 STEPS = " + formatInt(per1k.tokens) + " TOKENS";
    }

    const canFlashHud =
      currentScreen === "console" &&
      prevRenderedIsOrView !== null &&
      prevRenderedIsOrView === isOrView;

    const stepsEl = $("steps-banked-num");
    if (stepsEl) {
      if (canFlashHud && prevRenderedSteps !== null && prevRenderedSteps !== stepsText) {
        flashElement(stepsEl);
      } else {
        stepsEl.classList.remove("is-flashing");
      }
      stepsEl.textContent = stepsText;
      prevRenderedSteps = stepsText;
    }

    const primaryEl = $("balance-primary-num");
    const primaryLbl = $("balance-primary-label");
    if (primaryEl && primaryLbl) {
      const nextPrimary = isOrView ? usdText : tokText;
      if (canFlashHud && prevRenderedPrimary !== null && prevRenderedPrimary !== nextPrimary) {
        flashElement(primaryEl);
      } else {
        primaryEl.classList.remove("is-flashing");
      }
      primaryEl.textContent = nextPrimary;
      primaryLbl.textContent = isOrView ? "CREDIT AVAILABLE" : "TOKENS AVAILABLE";
      prevRenderedPrimary = nextPrimary;
    }
    prevRenderedIsOrView = isOrView;

    renderFuelTank(st, isOrView, per1k);
    syncThemeFuelColor(st);

    if ($("console-sub-meta")) {
      $("console-sub-meta").textContent = isOrView
        ? formatUsd(st.creditEarnedUsd) + " EARNED · " + formatUsd(st.creditBurnedUsd) + " SPENT"
        : "~" + formatInt(st.turnsLeftApprox) + " TURNS LEFT · " + formatInt(st.tokensBurned) + " TOKENS BURNED";
    }

    const stamp = $("gate-status-stamp");
    if (stamp) {
      if (st.isLocked) {
        stamp.textContent = "[ LOCKED — GO WALK ]";
        stamp.classList.add("is-locked");
        stamp.classList.remove("is-unlocked");
      } else {
        stamp.textContent = "[ UNLOCKED ]";
        stamp.classList.remove("is-locked");
        stamp.classList.add("is-unlocked");
      }
    }

    if ($("console-device-status")) {
      const stepDevs = Array.isArray(st.devices)
        ? st.devices.filter(
            (d) => !/^(demo|manual|test)$/i.test(String(d || "").trim()) && !/^agent_/i.test(String(d || "").trim())
          )
        : [];
      const devs = stepDevs.length
        ? stepDevs.map(formatSourceName).join(", ")
        : Number(st.pairedAt || 0) > 0
          ? "PHONE OPENED — WALK TO UNLOCK"
          : "NOT CONNECTED YET";
      $("console-device-status").textContent = "STEP SOURCE: " + devs;
      const qrBtn = $("console-qr-btn");
      if (qrBtn) {
        const hasPhonePaired = stepDevs.length > 0 || Number(st.pairedAt || 0) > 0 || Number(st.stepsTotal || 0) > 0;
        qrBtn.className = hasPhonePaired ? "hw-btn--blackwire" : "hw-btn";
        qrBtn.innerHTML = hasPhonePaired
          ? '<span class="btn-lbl"><span class="nw">[ PHONE</span> <span class="nw">QR ]</span></span>'
          : '<span class="btn-lbl"><span class="nw">[ SCAN</span> PHONE <span class="nw">QR ]</span></span>';
      }
    }

    const ideLiveEl = $("setup-ide-live-status");
    if (ideLiveEl) {
      const agentDevs = Array.isArray(st.devices)
        ? st.devices.filter((d) => /^agent_/i.test(String(d || "").trim()))
        : [];
      if (agentDevs.length > 0) {
        const names = agentDevs
          .map((d) => String(d).replace(/^agent_/i, "").replace(/_/g, " ").toUpperCase())
          .join(", ");
        ideLiveEl.classList.add("is-installed");
        ideLiveEl.textContent = "CONNECTED — BLOCKER INSTALLED ON YOUR COMPUTER (" + names + ") \u2713";
      } else if (ideLiveEl.classList.contains("is-installed")) {
        ideLiveEl.classList.remove("is-installed");
        ideLiveEl.innerHTML =
          "On Mac, press <kbd>Cmd</kbd>+<kbd>Space</kbd>, type <strong>Terminal</strong>, paste, and press <kbd>Enter</kbd>.";
      }
    }

    if ($("walk-health-balance")) {
      $("walk-health-balance").textContent =
        formatInt(st.stepsTotal) +
        " STEPS BANKED \u00B7 " +
        (isOrView ? formatUsd(st.creditAvailableUsd) + " CREDIT" : formatInt(st.tokensAvailable) + " TOKENS") +
        " AVAILABLE";
    }

    if ($("pocket-dim-steps")) {
      const dimTotal = Math.max(syncedWalkSteps + pendingWalkSteps, Number(st.stepsTotal || 0));
      $("pocket-dim-steps").textContent = formatInt(dimTotal) + " STEPS";
    }

    renderIdeSnippets();
    renderCalculator();
  }

  /* ---------------- Phone Companion: Mode Switcher + Health Setup + Live Pedometer ---------------- */

  function resetHealthCopyButtonLabel() {
    if (healthLinkCopiedTimer) {
      clearTimeout(healthLinkCopiedTimer);
      healthLinkCopiedTimer = null;
    }
    const btn = $("walk-copy-health-btn");
    const lbl = $("walk-copy-health-label");
    if (btn) btn.classList.remove("is-copied");
    if (lbl) lbl.textContent = "[ COPY MY SYNC LINK ]";
  }

  let pauseConfirmArmedUntil = 0;
  let pauseConfirmResetTimer = null;

  function openPocketDimShield() {
    const shield = $("pocket-dim-shield");
    if (!shield) return;
    pocketDimActive = true;
    lastPocketDimTapAt = 0;
    const stNow = window.RuntimeGate ? window.RuntimeGate.getState() : null;
    if ($("pocket-dim-steps")) {
      const shown = Math.max(syncedWalkSteps + pendingWalkSteps, stNow ? Number(stNow.stepsTotal || 0) : 0);
      $("pocket-dim-steps").textContent = formatInt(shown) + " STEPS";
    }
    shield.hidden = false;
    setBackgroundInert(true);
    syncStickyDockVisibility();
    playHwTick(520, 8);
  }

  function closePocketDimShield() {
    const shield = $("pocket-dim-shield");
    if (!shield || shield.hidden) {
      pocketDimActive = false;
      return;
    }
    pocketDimActive = false;
    shield.hidden = true;
    setBackgroundInert(false);
    syncStickyDockVisibility();
    playHwTick(960, 10);
  }

  function syncStickyDockVisibility() {
    const hideDock = (currentScreen === "walk" && motionActive) || pocketDimActive;
    if (typeof document !== "undefined" && document.body) {
      document.body.classList.toggle("is-pocket-locked", pocketDimActive);
    }
    if ($("walk-pocket-dim-btn")) {
      $("walk-pocket-dim-btn").hidden = !(currentScreen === "walk" && walkActiveMode === "phone" && motionActive);
    }
    if (
      window.RuntimeStickyNotes &&
      typeof window.RuntimeStickyNotes.setDockHidden === "function"
    ) {
      window.RuntimeStickyNotes.setDockHidden(hideDock);
    }
  }

  function pendingWalkStorageKey() {
    const { pairVaultId, syncVaultId } = getUrlSyncAndPairParams();
    const vId =
      pairVaultId ||
      syncVaultId ||
      (window.RuntimeGate ? window.RuntimeGate.getState().vaultId : "default");
    return "rt_pending_walk_" + vId;
  }

  function savePendingWalkBackup() {
    try {
      const k = pendingWalkStorageKey();
      if (pendingWalkSteps > 0) {
        localStorage.setItem(k, String(pendingWalkSteps));
      } else {
        localStorage.removeItem(k);
      }
    } catch (_) {}
  }

  function loadPendingWalkBackup() {
    try {
      const raw = Number(localStorage.getItem(pendingWalkStorageKey()) || 0);
      if (Number.isFinite(raw) && raw > 0) {
        pendingWalkSteps = Math.max(pendingWalkSteps, Math.floor(raw));
      }
    } catch (_) {}
  }

  function setWalkMode(mode, moveFocus) {
    walkActiveMode = mode === "health" ? "health" : "phone";
    if (walkActiveMode === "health" && motionActive) {
      stopMotionPedometer();
    }
    const phoneBtn = $("walk-mode-phone-btn");
    const healthBtn = $("walk-mode-health-btn");
    const phonePanel = $("walk-panel-phone");
    const healthPanel = $("walk-panel-health");

    if (phoneBtn) {
      const isPhone = walkActiveMode === "phone";
      phoneBtn.classList.toggle("is-active", isPhone);
      phoneBtn.setAttribute("aria-selected", isPhone ? "true" : "false");
      phoneBtn.setAttribute("tabindex", isPhone ? "0" : "-1");
      if (moveFocus && isPhone) phoneBtn.focus();
    }
    if (healthBtn) {
      const isHealth = walkActiveMode === "health";
      healthBtn.classList.toggle("is-active", isHealth);
      healthBtn.setAttribute("aria-selected", isHealth ? "true" : "false");
      healthBtn.setAttribute("tabindex", isHealth ? "0" : "-1");
      if (moveFocus && isHealth) healthBtn.focus();
    }
    if (phonePanel) phonePanel.hidden = walkActiveMode !== "phone";
    if (healthPanel) healthPanel.hidden = walkActiveMode !== "health";
    syncStickyDockVisibility();
  }

  function setWalkQuickUnit(unit, moveFocus) {
    walkQuickUnit = unit === "calories" ? "calories" : unit === "km" ? "km" : "steps";
    const unitDefs = [
      { id: "walk-unit-steps-btn", key: "steps" },
      { id: "walk-unit-cal-btn", key: "calories" },
      { id: "walk-unit-km-btn", key: "km" }
    ];
    unitDefs.forEach((u) => {
      const btn = $(u.id);
      if (!btn) return;
      const active = walkQuickUnit === u.key;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-checked", active ? "true" : "false");
      btn.setAttribute("tabindex", active ? "0" : "-1");
      if (moveFocus && active) btn.focus();
    });

    const inp = $("walk-quick-input");
    const hint = $("walk-quick-hint");
    const goBtn = $("walk-quick-submit-btn");
    if (walkQuickUnit === "calories") {
      if (inp) inp.placeholder = "350 cal";
      if (hint) {
        hint.textContent =
          "WHOOP, Watch, or gym workout: 100 active cal = 2,000 steps (50,000 tokens).";
      }
      if (goBtn) goBtn.textContent = "[ + ADD ]";
    } else if (walkQuickUnit === "km") {
      if (inp) inp.placeholder = "4.5 km";
      if (hint) {
        hint.textContent = "1 km = 1,280 steps (32,000 tokens). Decimals like 3.5 work too.";
      }
      if (goBtn) goBtn.textContent = "[ + ADD ]";
    } else {
      if (inp) inp.placeholder = "6,400 steps";
      if (hint) {
        hint.textContent =
          "Syncs only new steps added today — enter your latest total anytime without double-counting.";
      }
      if (goBtn) goBtn.textContent = "[ SYNC ]";
    }
  }

  function buildWalkHealthSyncUrl() {
    const { pairVaultId, syncVaultId, fieldToken } = getUrlSyncAndPairParams();
    const src = walkHealthOs === "android" ? "whoop_android" : "apple_health";
    const pairedVault = pairVaultId || syncVaultId;
    if (pairedVault) {
      const ft = fieldToken || window.RuntimeGate.getState().fieldToken;
      const ftPart = ft ? "&ft=" + encodeURIComponent(ft) : "";
      return (
        window.location.origin +
        "/?sync=" +
        encodeURIComponent(pairedVault) +
        ftPart +
        "&source=" +
        encodeURIComponent(src) +
        "&steps="
      );
    }
    return window.RuntimeGate.getHealthSyncUrl(src);
  }

  function handleCopyWalkHealthLink() {
    const url = buildWalkHealthSyncUrl();
    copyText(url, "SYNC LINK COPIED");

    const btn = $("walk-copy-health-btn");
    const lbl = $("walk-copy-health-label");
    if (btn) btn.classList.add("is-copied");
    if (lbl) lbl.textContent = "[ LINK COPIED \u2713 ]";

    if (healthLinkCopiedTimer) clearTimeout(healthLinkCopiedTimer);
    healthLinkCopiedTimer = setTimeout(() => {
      healthLinkCopiedTimer = null;
      if (btn) btn.classList.remove("is-copied");
      if (lbl) lbl.textContent = "[ COPY MY SYNC LINK ]";
    }, 4000);
  }

  async function creditParsedEffort(spec) {
    if (!spec || !window.RuntimeGate) return null;
    const stepsEq = Math.max(0, Math.round(Number(spec.stepsEquivalent || 0)));
    if (stepsEq <= 0) return null;

    if (gateInitPromise) {
      await gateInitPromise.catch(() => {});
    }

    const { pairVaultId, syncVaultId, fieldToken } = getUrlSyncAndPairParams();
    const targetVault = pairVaultId || syncVaultId;
    const stBefore = window.RuntimeGate.getState();
    const effVault = targetVault || stBefore.vaultId;
    const effFt = fieldToken || stBefore.fieldToken;
    const src = spec.source || "whoop";

    if (spec.mode === "daily") {
      const res = await window.RuntimeGate.syncDailySteps(effVault, effFt, stepsEq, src);
      syncedWalkSteps = Math.max(syncedWalkSteps, Number(res.reportedToday || 0));
      const nextSt = window.RuntimeGate.getState();
      renderState(nextSt);
      renderWalkCounters(
        res.stepsAdded > 0
          ? spec.summary + " -> +" + formatInt(res.stepsAdded) + " NEW STEPS UNLOCKED"
          : spec.summary + " -> UP TO DATE TODAY"
      );
      playHwTick(1320, 14);
      return {
        stepsAdded: Number(res.stepsAdded || 0),
        reportedToday: Number(res.reportedToday || stepsEq),
        mode: "daily",
        summary: spec.summary || formatInt(stepsEq) + " STEPS"
      };
    }

    if (targetVault && window.RuntimeGate.postFieldSteps) {
      const res = await window.RuntimeGate.postFieldSteps(targetVault, effFt, stepsEq, src);
      syncedWalkSteps += stepsEq;
      if (res && res.state) renderState(res.state);
      else renderState(window.RuntimeGate.getState());
    } else {
      const nextSt = await window.RuntimeGate.addSteps(stepsEq, src);
      syncedWalkSteps += stepsEq;
      renderState(nextSt);
    }
    renderWalkCounters(spec.summary + " -> +" + formatInt(stepsEq) + " STEPS UNLOCKED");
    playHwTick(1320, 14);
    return {
      stepsAdded: stepsEq,
      reportedToday: syncedWalkSteps,
      mode: "workout",
      summary: spec.summary || "+" + formatInt(stepsEq) + " STEPS"
    };
  }

  async function handleQuickCheckInSubmit() {
    const inp = $("walk-quick-input");
    const hint = $("walk-quick-hint");
    const raw = String(inp ? inp.value : "").trim();
    if (!raw) {
      if (inp) inp.focus();
      showToast("ENTER A NUMBER FIRST");
      return;
    }

    let spec = null;
    if (/[a-zA-Z]/.test(raw) && window.RuntimeGate.parseFitnessStatsFromText) {
      spec = window.RuntimeGate.parseFitnessStatsFromText(raw);
    }
    if (!spec) {
      const cleanNum = Number(
        raw
          .replace(/(\d)[,\s\u00A0'](?!\d{1,2}$)(?=\d{3}(\D|$))/g, "$1")
          .replace(",", ".")
          .replace(/[^0-9.]/g, "")
      );
      if (!Number.isFinite(cleanNum) || cleanNum <= 0) {
        if (hint) hint.textContent = "Enter a valid number above zero (for example 6400 or 350).";
        showToast("ENTER A VALID NUMBER");
        return;
      }
      if (walkQuickUnit === "calories") {
        const stepsEq = window.RuntimeGate.convertEffortToSteps(cleanNum, "calories");
        spec = {
          metric: "calories",
          rawValue: cleanNum,
          stepsEquivalent: stepsEq,
          mode: "workout",
          source: "whoop_cal",
          summary: formatInt(cleanNum) + " CAL (" + formatInt(stepsEq) + " STEPS)"
        };
      } else if (walkQuickUnit === "km") {
        const stepsEq = window.RuntimeGate.convertEffortToSteps(cleanNum, "km");
        spec = {
          metric: "km",
          rawValue: cleanNum,
          stepsEquivalent: stepsEq,
          mode: "workout",
          source: "watch_km",
          summary: cleanNum + " KM (" + formatInt(stepsEq) + " STEPS)"
        };
      } else {
        const stepsEq = Math.round(cleanNum);
        spec = {
          metric: "steps",
          rawValue: stepsEq,
          stepsEquivalent: stepsEq,
          mode: "daily",
          source: walkHealthOs === "android" ? "android_steps" : "watch_steps",
          summary: formatInt(stepsEq) + " STEPS"
        };
      }
    }

    try {
      const outcome = await creditParsedEffort(spec);
      if (!outcome) return;
      if (inp) inp.value = "";
      if (hint) {
        hint.textContent =
          outcome.stepsAdded > 0
            ? "SYNCED: " + outcome.summary + " -> +" + formatInt(outcome.stepsAdded) + " STEPS UNLOCKED \u2713"
            : "UP TO DATE: " + formatInt(outcome.reportedToday) + " steps already banked today.";
      }
      showToast(
        outcome.stepsAdded > 0
          ? "+" + formatInt(outcome.stepsAdded) + " STEPS UNLOCKED"
          : "TODAY'S STEPS ALREADY UP TO DATE"
      );
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (hint) hint.textContent = "SYNC ERROR: " + msg;
      showToast("SYNC ERROR");
    }
  }

  async function handleQuickPresetClick(presetUnit, presetVal) {
    const val = Number(presetVal || 0);
    if (!Number.isFinite(val) || val <= 0 || !window.RuntimeGate) return;
    let spec = null;
    if (presetUnit === "calories") {
      const stepsEq = window.RuntimeGate.convertEffortToSteps(val, "calories");
      spec = {
        metric: "calories",
        rawValue: val,
        stepsEquivalent: stepsEq,
        mode: "workout",
        source: "whoop_cal",
        summary: "+" + formatInt(val) + " CAL (" + formatInt(stepsEq) + " STEPS)"
      };
    } else if (presetUnit === "km") {
      const stepsEq = window.RuntimeGate.convertEffortToSteps(val, "km");
      spec = {
        metric: "km",
        rawValue: val,
        stepsEquivalent: stepsEq,
        mode: "workout",
        source: "watch_km",
        summary: "+" + val + " KM (" + formatInt(stepsEq) + " STEPS)"
      };
    } else {
      spec = {
        metric: "steps",
        rawValue: val,
        stepsEquivalent: Math.round(val),
        mode: "workout",
        source: "quick_walk",
        summary: "+" + formatInt(val) + " STEPS"
      };
    }
    try {
      const outcome = await creditParsedEffort(spec);
      if (outcome && $("walk-quick-hint")) {
        $("walk-quick-hint").textContent =
          "ADDED: " + outcome.summary + " -> +" + formatInt(outcome.stepsAdded) + " STEPS UNLOCKED \u2713";
      }
      if (outcome) {
        showToast("+" + formatInt(outcome.stepsAdded) + " STEPS UNLOCKED");
      }
    } catch (_) {
      showToast("SYNC ERROR");
    }
  }

  /* ---------------- On-Device Screenshot Scanner (Native TextDetector + Local WASM OCR) ---------------- */

  function loadImageElementFromBlob(blob) {
    return new Promise((resolve, reject) => {
      if (typeof createImageBitmap === "function") {
        createImageBitmap(blob).then(resolve, () => {
          fallbackImgTag(blob, resolve, reject);
        });
      } else {
        fallbackImgTag(blob, resolve, reject);
      }
    });
  }

  function fallbackImgTag(blob, resolve, reject) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e || new Error("Could not decode image"));
    };
    img.src = url;
  }

  function buildOcrCanvases(imgSource) {
    const srcW = Math.max(1, Number(imgSource.width || imgSource.naturalWidth || 1));
    const srcH = Math.max(1, Number(imgSource.height || imgSource.naturalHeight || 1));
    const maxEdge = Math.max(srcW, srcH);
    let scale = 1;
    if (maxEdge > 1500) scale = 1500 / maxEdge;
    else if (maxEdge < 750) scale = Math.min(2.2, 1100 / maxEdge);

    const w = Math.max(16, Math.round(srcW * scale));
    const h = Math.max(16, Math.round(srcH * scale));

    const rawCanvas = document.createElement("canvas");
    rawCanvas.width = w;
    rawCanvas.height = h;
    const rawCtx = rawCanvas.getContext("2d", { willReadFrequently: true });
    rawCtx.fillStyle = "#ffffff";
    rawCtx.fillRect(0, 0, w, h);
    rawCtx.drawImage(imgSource, 0, 0, w, h);

    const cleanCanvas = document.createElement("canvas");
    cleanCanvas.width = w;
    cleanCanvas.height = h;
    const cleanCtx = cleanCanvas.getContext("2d", { willReadFrequently: true });
    const imgData = rawCtx.getImageData(0, 0, w, h);
    const data = imgData.data;

    let lumSum = 0;
    const pxCount = Math.max(1, w * h);
    for (let i = 0; i < data.length; i += 4) {
      lumSum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    const meanLum = lumSum / pxCount;
    const isDarkScreen = meanLum < 132;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const maxCh = Math.max(r, g, b);
      let lum = isDarkScreen
        ? Math.max(0.299 * r + 0.587 * g + 0.114 * b, maxCh * 0.88)
        : 0.299 * r + 0.587 * g + 0.114 * b;
      if (isDarkScreen) {
        lum = 255 - lum;
      }
      let stretched = (lum - 90) * 1.65 + 128;
      if (stretched < 0) stretched = 0;
      if (stretched > 255) stretched = 255;
      const v = Math.round(stretched);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
    cleanCtx.putImageData(imgData, 0, 0);
    return { rawCanvas, cleanCanvas, isDarkScreen };
  }

  function ensureTesseractScriptLoaded() {
    if (window.Tesseract && typeof window.Tesseract.createWorker === "function") {
      return Promise.resolve(window.Tesseract);
    }
    if (ocrScriptPromise) return ocrScriptPromise;
    ocrScriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/ocr/tesseract.min.js?v=24";
      s.async = true;
      s.onload = () => {
        if (window.Tesseract) resolve(window.Tesseract);
        else reject(new Error("OCR library failed to initialize"));
      };
      s.onerror = () => {
        ocrScriptPromise = null;
        reject(new Error("Could not load on-device OCR bundle"));
      };
      document.head.appendChild(s);
    });
    return ocrScriptPromise;
  }

  async function getLocalOcrWorker() {
    if (ocrWorkerPromise) return ocrWorkerPromise;
    ocrWorkerPromise = (async () => {
      const Tesseract = await ensureTesseractScriptLoaded();
      const baseOrigin = window.location.origin;
      return Tesseract.createWorker("eng", 1, {
        workerPath: baseOrigin + "/ocr/worker.min.js",
        corePath: baseOrigin + "/ocr",
        langPath: baseOrigin + "/ocr",
        gzip: true
      });
    })().catch((err) => {
      ocrWorkerPromise = null;
      throw err;
    });
    return ocrWorkerPromise;
  }

  async function scanHealthScreenshotFile(fileOrBlob) {
    if (!fileOrBlob || !window.RuntimeGate) return false;
    if (currentScreen !== "walk") {
      walkOpenedFromSteps = currentScreen === "steps";
      setWalkMode("health");
      showScreen("walk", true);
    } else if (walkActiveMode !== "health") {
      setWalkMode("health");
    }

    const scanBtn = $("walk-scan-btn");
    const scanLbl = $("walk-scan-btn-label");
    const statusEl = $("walk-scan-status");
    if (scanBtn) scanBtn.disabled = true;
    if (scanLbl) scanLbl.textContent = "[ READING SCREENSHOT... ]";
    if (statusEl) {
      statusEl.textContent = "Reading steps & calories privately on your device...";
    }

    try {
      const imgSource = await loadImageElementFromBlob(fileOrBlob);
      const { rawCanvas, cleanCanvas } = buildOcrCanvases(imgSource);
      if (typeof imgSource.close === "function") {
        try {
          imgSource.close();
        } catch (_) {}
      }

      let parsed = null;

      if (typeof window.TextDetector === "function") {
        try {
          const detector = new window.TextDetector();
          const rawBlocks = await detector.detect(rawCanvas);
          const rawText = Array.isArray(rawBlocks)
            ? rawBlocks.map((b) => b.rawValue || "").join("\n")
            : "";
          parsed = window.RuntimeGate.parseFitnessStatsFromText(rawText);
          if (!parsed) {
            const invBlocks = await detector.detect(cleanCanvas);
            const invText = Array.isArray(invBlocks)
              ? invBlocks.map((b) => b.rawValue || "").join("\n")
              : "";
            parsed = window.RuntimeGate.parseFitnessStatsFromText(invText);
          }
        } catch (_) {}
      }

      if (!parsed) {
        const worker = await getLocalOcrWorker();
        const resClean = await worker.recognize(cleanCanvas);
        const textClean = (resClean && resClean.data && resClean.data.text) || "";
        parsed = window.RuntimeGate.parseFitnessStatsFromText(textClean);
        if (!parsed) {
          const resRaw = await worker.recognize(rawCanvas);
          const textRaw = (resRaw && resRaw.data && resRaw.data.text) || "";
          parsed = window.RuntimeGate.parseFitnessStatsFromText(textRaw + "\n" + textClean);
        }
      }

      if (!parsed || !parsed.stepsEquivalent) {
        if (statusEl) {
          statusEl.textContent =
            "Couldn't spot steps, calories, or km in that screenshot — crop closer to the number or enter it in Box 2 below.";
        }
        showToast("ENTER NUMBER IN BOX 2 BELOW");
        return false;
      }

      const outcome = await creditParsedEffort(parsed);
      if (outcome && statusEl) {
        statusEl.textContent =
          outcome.stepsAdded > 0
            ? "SCANNED " + outcome.summary + " -> +" + formatInt(outcome.stepsAdded) + " STEPS UNLOCKED \u2713"
            : "SCANNED " + outcome.summary + " -> TODAY'S TOTAL ALREADY SYNCED (" + formatInt(outcome.reportedToday) + " STEPS)";
      }
      if (outcome) {
        showToast(
          outcome.stepsAdded > 0
            ? "+" + formatInt(outcome.stepsAdded) + " STEPS UNLOCKED"
            : "ALREADY UP TO DATE TODAY"
        );
      }
      return Boolean(outcome);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (statusEl) {
        statusEl.textContent = "SCAN ERROR: " + msg + " — enter your steps or calories in Box 2 below.";
      }
      showToast("COULDN'T SCAN — ENTER BELOW");
      return false;
    } finally {
      if (scanBtn) scanBtn.disabled = false;
      if (scanLbl) {
        scanLbl.innerHTML = '<span class="nw">[ SCAN</span> WHOOP / HEALTH <span class="nw">SCREENSHOT ]</span>';
      }
    }
  }

  async function consumeAndroidShareTargetIfPresent() {
    if (typeof caches === "undefined") return false;
    try {
      const cache = await caches.open("runtime-share-target-v1");
      const metaRes = await cache.match(new Request("/__shared_meta__"));
      const imgRes = await cache.match(new Request("/__shared_image__"));
      await cache.delete(new Request("/__shared_meta__"));
      await cache.delete(new Request("/__shared_image__"));

      setWalkMode("health");
      showScreen("walk", false);
      history.replaceState({ screen: "walk" }, "", window.location.pathname + "#walk");

      if (metaRes) {
        const meta = await metaRes.json().catch(() => null);
        if (meta && (meta.title || meta.text)) {
          const textParsed = window.RuntimeGate.parseFitnessStatsFromText(
            (meta.title || "") + "\n" + (meta.text || "")
          );
          if (textParsed && textParsed.stepsEquivalent > 0) {
            const outcome = await creditParsedEffort(textParsed);
            if (outcome && $("walk-scan-status")) {
              $("walk-scan-status").textContent =
                "SHARED " + outcome.summary + " -> +" + formatInt(outcome.stepsAdded) + " STEPS UNLOCKED \u2713";
            }
            if (outcome) showToast("+" + formatInt(outcome.stepsAdded) + " STEPS SHARED");
            return true;
          }
        }
      }

      if (imgRes) {
        const blob = await imgRes.blob();
        if (blob && blob.size > 0) {
          return await scanHealthScreenshotFile(blob);
        }
      }
    } catch (_) {}
    return false;
  }

  async function acquireScreenWakeLock() {
    if (!motionActive || typeof navigator === "undefined" || !navigator.wakeLock) return;
    try {
      if (wakeLockSentinel && !wakeLockSentinel.released) return;
      wakeLockSentinel = await navigator.wakeLock.request("screen");
    } catch (_) {
      if (motionActive && $("walk-pair-status")) {
        $("walk-pair-status").textContent =
          "COUNTING STEPS — DISABLE LOW POWER MODE SO SCREEN STAYS AWAKE";
      }
    }
  }

  function releaseScreenWakeLock() {
    if (wakeLockSentinel && typeof wakeLockSentinel.release === "function") {
      wakeLockSentinel.release().catch(() => {});
      wakeLockSentinel = null;
    }
  }

  function updateWalkWave(mag) {
    if (prefersReducedMotion()) return;
    const el = $("walk-ascii-wave");
    if (!el) return;
    const bars = "·▄█";
    const delta = Math.abs(mag - 9.81);
    const ch = delta > 2.2 ? bars[2] : delta > 0.8 ? bars[1] : bars[0];
    waveHistory.push(ch);
    if (waveHistory.length > 20) waveHistory.shift();
    const padded = waveHistory.join("").padEnd(20, "·");
    el.textContent = "[" + padded + "]";
  }

  function renderWalkCounters(syncNote) {
    const stNow = window.RuntimeGate.getState();
    syncThemeFuelColor(stNow);
    const totalShown = syncedWalkSteps + pendingWalkSteps;
    if ($("walk-step-count")) {
      $("walk-step-count").textContent = formatInt(totalShown);
    }
    if ($("pocket-dim-steps")) {
      const dimTotal = Math.max(totalShown, Number(stNow.stepsTotal || 0));
      $("pocket-dim-steps").textContent = formatInt(dimTotal) + " STEPS";
    }
    const confirmedCalc = window.RuntimeGate.calculateSteps(syncedWalkSteps, stNow.tokensPerStep);
    if ($("walk-credit-sent")) {
      if (pendingWalkSteps > 0) {
        $("walk-credit-sent").textContent =
          "+" +
          formatInt(confirmedCalc.tokens) +
          " TOK SYNCED (+" +
          formatInt(pendingWalkSteps) +
          " STEPS SYNCING...)";
      } else {
        $("walk-credit-sent").textContent =
          "+" + formatInt(confirmedCalc.tokens) + " TOK (" + formatUsd(confirmedCalc.usd) + ") UNLOCKED";
      }
    }
    if (syncNote && $("walk-pair-status")) {
      $("walk-pair-status").classList.remove("is-alert");
      $("walk-pair-status").textContent = syncNote;
    }
  }

  async function flushPendingWalkSteps() {
    if (walkFlushInFlight || pendingWalkSteps <= 0 || !window.RuntimeGate) return;
    walkFlushInFlight = true;
    const batch = pendingWalkSteps;
    pendingWalkSteps = 0;

    const { pairVaultId, syncVaultId, fieldToken } = getUrlSyncAndPairParams();
    const targetVault = pairVaultId || syncVaultId;

    try {
      if (targetVault && window.RuntimeGate.postFieldSteps) {
        const res = await window.RuntimeGate.postFieldSteps(
          targetVault,
          fieldToken,
          batch,
          "phone_qr"
        );
        syncedWalkSteps += batch;
        savePendingWalkBackup();
        if (res && res.state) renderState(res.state);
        renderWalkCounters("STEPS SYNCED LIVE TO YOUR COMPUTER");
      } else {
        const next = await window.RuntimeGate.addSteps(batch, "phone_qr");
        syncedWalkSteps += batch;
        savePendingWalkBackup();
        renderState(next);
        renderWalkCounters("STEPS SYNCED LIVE");
      }
    } catch (err) {
      const status = Number((err && err.status) || 0);
      if (status !== 403) {
        pendingWalkSteps += batch;
        savePendingWalkBackup();
      }
      const msg = err && err.message ? err.message : String(err);
      renderWalkCounters("SYNC ERROR: " + msg);
    } finally {
      walkFlushInFlight = false;
      if (pendingWalkSteps > 0 && !walkFlushTimer) {
        walkFlushTimer = setTimeout(() => {
          walkFlushTimer = null;
          flushPendingWalkSteps();
        }, 3500);
      }
    }
  }

  function queueDetectedWalkSteps(count) {
    pendingWalkSteps += count;
    savePendingWalkBackup();
    try {
      if (navigator.vibrate) navigator.vibrate(10);
    } catch (_) {}
    playHwTick(1160, 7);
    renderWalkCounters();
    if (!walkFlushTimer) {
      walkFlushTimer = setTimeout(() => {
        walkFlushTimer = null;
        flushPendingWalkSteps();
      }, 2400);
    }
  }

  function processDynamicStepDelta(dyn, waveMag) {
    const now = Date.now();
    updateWalkWave(waveMag);

    if (lastPeakTime > 0 && now - lastPeakTime > 2200) {
      inWalkingCadence = false;
      warmupBufferedSteps = 0;
      stepArmed = false;
    }

    if (!stepArmed && dyn > 1.15) {
      const dt = lastPeakTime > 0 ? now - lastPeakTime : 0;
      if (lastPeakTime === 0) {
        lastPeakTime = now;
        warmupBufferedSteps = 1;
        stepArmed = true;
      } else if (dt >= 260 && dt <= 1450) {
        lastPeakTime = now;
        stepArmed = true;
        if (!inWalkingCadence) {
          inWalkingCadence = true;
          const totalCredit = warmupBufferedSteps + 1;
          warmupBufferedSteps = 0;
          queueDetectedWalkSteps(totalCredit);
        } else {
          queueDetectedWalkSteps(1);
        }
      } else if (dt > 1450) {
        lastPeakTime = now;
        warmupBufferedSteps = 1;
        inWalkingCadence = false;
        stepArmed = true;
      }
    } else if (stepArmed && (dyn < -0.35 || (dyn < 0.25 && now - lastPeakTime >= 160))) {
      stepArmed = false;
    }
  }

  function handleMotionSample(ev) {
    if (linearAccelSensor && linearAccelSensor.__hasReading) return;
    const acc = ev && ev.accelerationIncludingGravity;
    if (
      !acc ||
      typeof acc.x !== "number" ||
      !Number.isFinite(acc.x) ||
      typeof acc.y !== "number" ||
      !Number.isFinite(acc.y) ||
      typeof acc.z !== "number" ||
      !Number.isFinite(acc.z)
    ) {
      return;
    }
    numericMotionSampleSeen = true;

    const mag = Math.sqrt(acc.x * acc.x + acc.y * acc.y + acc.z * acc.z);
    if (!Number.isFinite(mag) || mag <= 0.1) return;

    const now = Date.now();
    const dtSample =
      lastMotionSampleAt > 0
        ? Math.min(0.25, Math.max(0.005, (now - lastMotionSampleAt) / 1000))
        : 0.016;
    lastMotionSampleAt = now;

    if (gEst === 0) {
      gEst = mag;
    } else {
      const alpha = 1 - Math.exp(-dtSample / 0.8);
      gEst = (1 - alpha) * gEst + alpha * mag;
    }

    processDynamicStepDelta(mag - gEst, mag);
  }

  function attachLinearAccelSensorIfAvailable() {
    stopLinearAccelSensor();
    if (typeof window === "undefined" || typeof window.LinearAccelerationSensor !== "function") {
      return;
    }
    try {
      const sensor = new window.LinearAccelerationSensor({ frequency: 30 });
      sensor.__hasReading = false;
      sensor.addEventListener("reading", () => {
        if (!motionActive) return;
        const x = Number(sensor.x || 0);
        const y = Number(sensor.y || 0);
        const z = Number(sensor.z || 0);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
        sensor.__hasReading = true;
        numericMotionSampleSeen = true;
        const linMag = Math.sqrt(x * x + y * y + z * z);
        processDynamicStepDelta(linMag - 0.35, 9.81 + linMag);
      });
      sensor.addEventListener("error", () => {
        stopLinearAccelSensor();
      });
      sensor.start();
      linearAccelSensor = sensor;
    } catch (_) {
      linearAccelSensor = null;
    }
  }

  function stopLinearAccelSensor() {
    if (linearAccelSensor) {
      try {
        linearAccelSensor.stop();
      } catch (_) {}
      linearAccelSensor = null;
    }
  }

  function stopMotionPedometer() {
    if (!motionActive) return;
    motionActive = false;
    pauseConfirmArmedUntil = 0;
    if (pauseConfirmResetTimer) {
      clearTimeout(pauseConfirmResetTimer);
      pauseConfirmResetTimer = null;
    }
    closePocketDimShield();
    syncStickyDockVisibility();
    stopLinearAccelSensor();
    window.removeEventListener("devicemotion", handleMotionSample);
    releaseScreenWakeLock();
    flushPendingWalkSteps();
    playHwTick(720, 10);
    if ($("walk-sensor-label")) {
      $("walk-sensor-label").textContent = "[ PAUSED — TAP TO RESUME ]";
    }
    if ($("walk-pair-status")) {
      $("walk-pair-status").textContent = "STEP COUNTER PAUSED";
    }
    showToast("STEP COUNTER PAUSED");
  }

  function startMotionPedometerDirect(silentToast) {
    if (motionActive) return;
    motionActive = true;
    pauseConfirmArmedUntil = 0;
    numericMotionSampleSeen = false;
    syncStickyDockVisibility();
    if (!silentToast) playHwTick(1080, 12);
    if ($("walk-sensor-label")) {
      $("walk-sensor-label").textContent = "[ SENSOR LIVE — DOUBLE-TAP TO PAUSE ]";
    }
    if ($("walk-pair-status")) {
      $("walk-pair-status").classList.remove("is-alert");
      $("walk-pair-status").textContent = "COUNTING STEPS — TAP POCKET LOCK TO DIM SCREEN";
    }
    acquireScreenWakeLock();
    attachLinearAccelSensorIfAvailable();
    window.addEventListener("devicemotion", handleMotionSample);
    if (!silentToast) showToast("STEP COUNTER ON");

    setTimeout(async () => {
      if (!motionActive || numericMotionSampleSeen || !$("walk-pair-status")) return;
      const isMobileUa = /iphone|ipad|ipod|android/i.test(navigator.userAgent || "");
      if (!isMobileUa) {
        $("walk-pair-status").textContent =
          "NO MOTION SENSOR ON COMPUTER — SCAN QR WITH PHONE OR TAP WHOOP / WATCH ABOVE";
        return;
      }
      let denied = false;
      try {
        if (navigator.permissions && typeof navigator.permissions.query === "function") {
          const perm = await navigator.permissions.query({ name: "accelerometer" });
          if (perm && perm.state === "denied") denied = true;
        }
      } catch (_) {}
      $("walk-pair-status").textContent = denied
        ? "MOTION BLOCKED IN BROWSER — ALLOW MOTION IN SITE SETTINGS OR TAP WHOOP / WATCH ABOVE"
        : "READY — WALK WITH PHONE IN POCKET, OR TAP WHOOP / WATCH ABOVE";
    }, 1800);
  }

  function isIosMotionPermissionDevice() {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    return (
      /iphone|ipad|ipod/i.test(ua) ||
      (navigator.platform === "MacIntel" && Number(navigator.maxTouchPoints || 0) > 1)
    );
  }

  function startMotionPedometerAutoIfPermitted() {
    if (motionActive) return;
    const isAndroidUa = /android/i.test((typeof navigator !== "undefined" && navigator.userAgent) || "");
    if (isAndroidUa && !isIosMotionPermissionDevice()) {
      startMotionPedometerDirect(true);
    }
  }

  function toggleMotionPedometer() {
    if (motionActive) {
      const now = Date.now();
      if (now < pauseConfirmArmedUntil) {
        stopMotionPedometer();
        return;
      }
      pauseConfirmArmedUntil = now + 2000;
      playHwTick(640, 8);
      if ($("walk-sensor-label")) {
        $("walk-sensor-label").textContent = "[ SENSOR LIVE — TAP AGAIN TO PAUSE ]";
      }
      if (pauseConfirmResetTimer) clearTimeout(pauseConfirmResetTimer);
      pauseConfirmResetTimer = setTimeout(() => {
        pauseConfirmResetTimer = null;
        if (motionActive && $("walk-sensor-label")) {
          $("walk-sensor-label").textContent = "[ SENSOR LIVE — DOUBLE-TAP TO PAUSE ]";
        }
      }, 2000);
      return;
    }

    const onPermissionFailure = () => {
      motionActive = false;
      syncStickyDockVisibility();
      if ($("walk-sensor-label")) {
        $("walk-sensor-label").textContent = "[ ALLOW MOTION — TAP TO RETRY ]";
      }
      if ($("walk-pair-status")) {
        $("walk-pair-status").textContent =
          "ALLOW MOTION IN BROWSER SETTINGS, OR TAP WHOOP / WATCH ABOVE";
      }
      showToast("MOTION ACCESS NEEDED");
    };

    if (
      isIosMotionPermissionDevice() &&
      typeof DeviceMotionEvent !== "undefined" &&
      typeof DeviceMotionEvent.requestPermission === "function"
    ) {
      DeviceMotionEvent.requestPermission()
        .then((res) => {
          if (res === "granted" || res === "prompt") startMotionPedometerDirect(false);
          else onPermissionFailure();
        })
        .catch(() => onPermissionFailure());
    } else {
      startMotionPedometerDirect(false);
    }
  }

  async function handleMintOpenRouterKey() {
    const input = $("or-prov-key-input");
    const statusEl = $("or-key-status");
    const raw = (input ? input.value : "").trim();
    if (!raw) {
      orStatusOverride =
        "ERROR: Paste your OpenRouter Provisioning Key in Step 2 first to create your step-gated key.";
      if (statusEl) {
        statusEl.classList.add("is-error");
        statusEl.textContent = orStatusOverride;
      }
      if (input) {
        input.setAttribute("aria-invalid", "true");
        input.focus();
      }
      showToast("PASTE YOUR PROVISIONING KEY FIRST");
      return false;
    }
    orStatusOverride = "Creating your step-gated key with OpenRouter...";
    if (statusEl) {
      statusEl.classList.remove("is-error");
      statusEl.textContent = orStatusOverride;
    }
    try {
      const info = await window.RuntimeGate.mintOpenRouterKey(raw);
      orStatusOverride = "";
      if (input) {
        input.value = "";
        input.setAttribute("aria-invalid", "false");
      }
      activePath = "openrouter";
      window.RuntimeGate.setGateConfig({ gatePath: "openrouter", gateActivated: true });
      renderState(window.RuntimeGate.getState());
      playHwTick(1200, 12);
      if (info && info.mintedKey) {
        copyText(info.mintedKey, "GATED KEY CREATED & COPIED");
      } else {
        showToast("GATED KEY CREATED");
      }
      if (info && info.mintedKey && $("setup-minted-box")) {
        $("setup-minted-box").hidden = false;
        if ($("setup-minted-placeholder")) $("setup-minted-placeholder").hidden = true;
        if ($("setup-minted-val")) $("setup-minted-val").textContent = shortMask(info.mintedKey);
      }
      return true;
    } catch (err) {
      orStatusOverride = formatOpenRouterError(err);
      if (statusEl) {
        statusEl.classList.add("is-error");
        statusEl.textContent = orStatusOverride;
      }
      if (input) input.setAttribute("aria-invalid", "true");
      return false;
    }
  }

  function clearOpenRouterKey() {
    orStatusOverride = "";
    if ($("or-prov-key-input")) {
      $("or-prov-key-input").value = "";
      $("or-prov-key-input").setAttribute("aria-invalid", "false");
    }
    if ($("setup-minted-val")) $("setup-minted-val").textContent = "";
    if ($("setup-minted-box")) $("setup-minted-box").hidden = true;
    if ($("setup-minted-placeholder")) $("setup-minted-placeholder").hidden = false;
    if (window.RuntimeGate.clearMintedKey) window.RuntimeGate.clearMintedKey();
    window.RuntimeGate.saveKey({ provider: "demo", apiKey: "" });
    renderState(window.RuntimeGate.getState());
    showToast("KEY CLEARED");
  }

  let gateInitPromise = null;

  async function handleIncomingHealthSyncUrl() {
    const { rawUrlSyncVaultId, fieldToken, stepsParam, calParam, kmParam, sourceParam } =
      getUrlSyncAndPairParams();
    const hasSteps = stepsParam !== null && stepsParam !== "";
    const hasCal = calParam !== null && calParam !== "";
    const hasKm = kmParam !== null && kmParam !== "";
    if (!rawUrlSyncVaultId || (!hasSteps && !hasCal && !hasKm)) return false;

    const effectiveSource = sourceParam || (hasCal ? "whoop" : "apple_health");
    setWalkMode("phone");
    showScreen("walk", false);
    if ($("walk-pair-status")) {
      $("walk-pair-status").classList.remove("is-alert");
      $("walk-pair-status").textContent = "SYNCING " + formatSourceName(effectiveSource) + "...";
    }
    try {
      if (gateInitPromise) {
        await gateInitPromise.catch(() => {});
      }
      if (hasSteps) {
        const res = await window.RuntimeGate.syncDailySteps(
          rawUrlSyncVaultId,
          fieldToken,
          stepsParam,
          effectiveSource
        );
        syncedWalkSteps = res.reportedToday;
        renderState(window.RuntimeGate.getState());
        if ($("walk-step-count")) $("walk-step-count").textContent = formatInt(res.reportedToday);
        const calc = window.RuntimeGate.calculateSteps(res.stepsTotal, res.tokensPerStep);
        if ($("walk-credit-sent")) {
          $("walk-credit-sent").textContent =
            formatInt(calc.tokens) + " TOK (" + formatUsd(calc.usd) + ") TOTAL";
        }
        if ($("walk-pair-status")) {
          $("walk-pair-status").textContent =
            formatSourceName(effectiveSource) +
            " CONNECTED (+" +
            formatInt(res.stepsAdded) +
            " NEW STEPS)";
        }
      } else {
        const stepsEq = hasCal
          ? window.RuntimeGate.convertEffortToSteps(calParam, "calories")
          : window.RuntimeGate.convertEffortToSteps(kmParam, "km");
        const res = await window.RuntimeGate.postFieldSteps(
          rawUrlSyncVaultId,
          fieldToken,
          stepsEq,
          effectiveSource
        );
        syncedWalkSteps += stepsEq;
        if (res && res.state) renderState(res.state);
        if ($("walk-step-count")) $("walk-step-count").textContent = formatInt(syncedWalkSteps);
        const stAfter = window.RuntimeGate.getState();
        const calc = window.RuntimeGate.calculateSteps(stAfter.stepsTotal, stAfter.tokensPerStep);
        if ($("walk-credit-sent")) {
          $("walk-credit-sent").textContent =
            formatInt(calc.tokens) + " TOK (" + formatUsd(calc.usd) + ") TOTAL";
        }
        if ($("walk-pair-status")) {
          $("walk-pair-status").textContent =
            formatSourceName(effectiveSource) + " CONNECTED (+" + formatInt(stepsEq) + " STEPS)";
        }
      }
      showToast(formatSourceName(effectiveSource) + " SYNCED");
      history.replaceState({ screen: "walk" }, "", window.location.pathname + "#walk");
    } catch (err) {
      if ($("walk-pair-status")) {
        $("walk-pair-status").textContent =
          "SYNC ERROR: " + (err && err.message ? err.message : String(err));
      }
    }
    return true;
  }

  function boot() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    const pre = $("preloader");
    if (pre) pre.hidden = true;

    // Populate initial Frame 0 on all ASCII canvases immediately
    renderChaseFrame();
    renderHowFrames();
    renderGatePickerFrames();

    window.addEventListener("resize", () => {
      cachedChaseCols = 0;
      if (currentScreen === "landing") renderChaseFrame();
      if (currentScreen === "rate") renderCalculator();
      if (currentScreen === "console" && window.RuntimeGate) {
        renderState(window.RuntimeGate.getState());
      }
    });

    setInterval(() => {
      if (currentScreen !== "landing" || prefersReducedMotion()) return;
      if (chaseTurboTicks > 0) chaseTurboTicks -= 1;
      chaseTick += 1;
      renderChaseFrame();
    }, 80);

    const heroBay = document.querySelector(".hero-ascii-bay");
    if (heroBay && typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(() => {
        cachedChaseCols = 0;
        if (currentScreen === "landing") renderChaseFrame();
      });
      ro.observe(heroBay);
    }
    if (heroBay) {
      heroBay.addEventListener("click", () => {
        if (prefersReducedMotion()) return;
        chaseTurboTicks = 18;
        chaseTick += 2;
        playHwTick(1240, 8);
        renderChaseFrame();
      });
    }

    setInterval(() => {
      if (currentScreen !== "how" || prefersReducedMotion()) return;
      howTick += 1;
      renderHowFrames();
    }, 220);

    setInterval(() => {
      if (currentScreen !== "gate" || gateSubView !== "picker" || prefersReducedMotion()) return;
      gateTick += 1;
      renderGatePickerFrames();
    }, 260);

    try {
      const initial = window.RuntimeGate.getState();
      if (initial.gatePath === "openrouter" || initial.gatePath === "ide") {
        activePath = initial.gatePath;
      }
      renderState(initial);
    } catch (_) {}

    window.addEventListener("rt:change", (ev) => {
      if (ev && ev.detail) renderState(ev.detail);
    });

    window.addEventListener("storage", (ev) => {
      if (ev && (ev.key === "rt_v2_state" || ev.key === "rt_v2_or_minted")) {
        if (window.RuntimeGate && window.RuntimeGate.syncFromCloud) {
          window.RuntimeGate.syncFromCloud().then((st) => renderState(st)).catch(() => {});
        }
      }
    });

    window.addEventListener("online", () => {
      flushPendingWalkSteps();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushPendingWalkSteps();
      } else if (document.visibilityState === "visible") {
        if (motionActive) acquireScreenWakeLock();
        flushPendingWalkSteps();
      }
    });

    window.addEventListener("pagehide", () => {
      flushPendingWalkSteps();
      if (hwAudioCtx && typeof hwAudioCtx.close === "function") {
        hwAudioCtx.close().catch(() => {});
        hwAudioCtx = null;
      }
    });

    gateInitPromise = window.RuntimeGate.init()
      .then((st) => {
        if (st.gatePath === "openrouter" || st.gatePath === "ide") {
          activePath = st.gatePath;
        }
        renderState(st);
        if (currentScreen === "steps") {
          renderAllStepQrSlots();
        }
        if (window.RuntimeGate.startPolling) {
          window.RuntimeGate.startPolling(2500, (next) => renderState(next));
        }
      })
      .catch(() => {});

    // Topbar
    $("nav-home-btn").addEventListener("click", () => {
      playHwTick(760, 8);
      showScreen("landing", true);
    });

    $("topbar-setup-btn").addEventListener("click", () => {
      playHwTick(840, 8);
      showScreen("steps", true);
    });

    $("topbar-status-btn").addEventListener("click", () => {
      playHwTick(840, 8);
      const st = window.RuntimeGate.getState();
      if (st.isConnected) {
        showScreen("console", true);
      } else {
        showScreen(currentScreen === "landing" ? "how" : "steps", true);
      }
    });

    // Screen 1: Landing
    $("get-steppin-btn").addEventListener("click", () => {
      playHwTick(920, 10);
      howReturnScreen = "landing";
      showScreen("how", true);
    });

    if ($("landing-tracker-btn")) {
      $("landing-tracker-btn").addEventListener("click", () => {
        playHwTick(920, 10);
        showScreen("console", true);
      });
    }

    // Screen 2: How It Works
    $("how-back-btn").addEventListener("click", () => {
      playHwTick(720, 8);
      showScreen(howReturnScreen || "landing", true);
    });

    $("how-next-btn").addEventListener("click", () => {
      playHwTick(920, 10);
      showScreen("steps", true);
    });

    if ($("how-rate-btn")) {
      $("how-rate-btn").addEventListener("click", () => {
        playHwTick(880, 8);
        rateReturnScreen = "how";
        showScreen("rate", true);
      });
    }

    // Screen 3: Dedicated Step Calculator (#rate)
    if ($("rate-back-btn")) {
      $("rate-back-btn").addEventListener("click", () => {
        playHwTick(720, 8);
        showScreen(rateReturnScreen || "how", true);
      });
    }

    if ($("rate-next-btn")) {
      $("rate-next-btn").addEventListener("click", () => {
        playHwTick(920, 10);
        if (rateReturnScreen === "console") {
          showScreen("console", true);
        } else {
          showScreen("steps", true);
        }
      });
    }

    const presetBtns = Array.from(document.querySelectorAll(".preset-btn[data-difficulty]"));
    presetBtns.forEach((btn, idx) => {
      btn.addEventListener("click", async () => {
        playHwTick(900, 8);
        const level = btn.dataset.difficulty || "standard";
        const next = await window.RuntimeGate.setDifficulty(level);
        renderState(next);
        showToast("RATE SET TO " + level.toUpperCase());
      });
      btn.addEventListener("keydown", (ev) => {
        if (ev.key === "ArrowRight" || ev.key === "ArrowDown" || ev.key === "ArrowLeft" || ev.key === "ArrowUp") {
          ev.preventDefault();
          const dir = ev.key === "ArrowRight" || ev.key === "ArrowDown" ? 1 : -1;
          const targetBtn = presetBtns[(idx + dir + presetBtns.length) % presetBtns.length];
          if (targetBtn) {
            targetBtn.focus();
            targetBtn.click();
          }
        }
      });
    });

    if ($("how-calc-slider")) {
      $("how-calc-slider").addEventListener("input", () => {
        calcStepsPreview = Number($("how-calc-slider").value) || 1000;
        playHwTick(520 + Math.round((calcStepsPreview / 20000) * 440), 5);
        renderCalculator();
      });
    }

    // Screen 4: Step 1 of 2 — Connect Your Steps (#steps)
    if ($("steps-step2-btn")) {
      $("steps-step2-btn").addEventListener("click", () => {
        playHwTick(880, 8);
        openGatePicker(true);
      });
    }

    if ($("steps-back-btn")) {
      $("steps-back-btn").addEventListener("click", () => {
        playHwTick(720, 8);
        howReturnScreen = "landing";
        showScreen("how", true);
      });
    }

    if ($("steps-copy-link-btn")) {
      $("steps-copy-link-btn").addEventListener("click", () => {
        copyText(window.RuntimeGate.getPairUrl(), "PHONE LINK COPIED");
      });
    }

    if ($("steps-copy-link-mobile-btn")) {
      $("steps-copy-link-mobile-btn").addEventListener("click", () => {
        copyText(window.RuntimeGate.getPairUrl(), "PHONE LINK COPIED");
      });
    }

    if ($("steps-open-walk-btn")) {
      $("steps-open-walk-btn").addEventListener("click", () => {
        playHwTick(920, 10);
        walkOpenedFromSteps = true;
        setWalkMode("phone");
        showScreen("walk", true);
        startMotionPedometerAutoIfPermitted();
      });
    }

    if ($("steps-log-desktop-btn")) {
      $("steps-log-desktop-btn").addEventListener("click", () => {
        playHwTick(920, 10);
        walkOpenedFromSteps = true;
        setWalkMode("health");
        showScreen("walk", true);
      });
    }

    if ($("steps-open-health-btn")) {
      $("steps-open-health-btn").addEventListener("click", () => {
        playHwTick(920, 10);
        walkOpenedFromSteps = true;
        setWalkMode("health");
        showScreen("walk", true);
      });
    }

    if ($("steps-next-btn")) {
      $("steps-next-btn").addEventListener("click", () => {
        playHwTick(960, 10);
        openGatePicker(true);
      });
    }

    // Screen 5: Step 2 of 2 — Connect Your Gate (#gate)
    if ($("gate-step1-btn")) {
      $("gate-step1-btn").addEventListener("click", () => {
        playHwTick(760, 8);
        showScreen("steps", true);
      });
    }

    if ($("gate-back-btn")) {
      $("gate-back-btn").addEventListener("click", () => {
        playHwTick(720, 8);
        if (gateSubView === "walkthrough") {
          openGatePicker(true);
        } else {
          showScreen("steps", true);
        }
      });
    }

    $("choose-ide-btn").addEventListener("click", () => {
      playHwTick(980, 10);
      openGateWalkthrough("ide", true);
    });

    $("choose-or-btn").addEventListener("click", () => {
      playHwTick(980, 10);
      openGateWalkthrough("openrouter", true);
    });

    const ideTabs = Array.from(document.querySelectorAll(".setup-ide-tab"));
    ideTabs.forEach((tab, idx) => {
      tab.addEventListener("click", () => {
        playHwTick(880, 8);
        activeIde = tab.dataset.ide || "auto";
        window.RuntimeGate.setGateConfig({ selectedIde: activeIde });
        renderIdeSnippets();
      });
      tab.addEventListener("keydown", (ev) => {
        if (ev.key === "ArrowRight" || ev.key === "ArrowDown" || ev.key === "ArrowLeft" || ev.key === "ArrowUp") {
          ev.preventDefault();
          const dir = ev.key === "ArrowRight" || ev.key === "ArrowDown" ? 1 : -1;
          const targetTab = ideTabs[(idx + dir + ideTabs.length) % ideTabs.length];
          if (targetTab) {
            targetTab.focus();
            targetTab.click();
          }
        }
      });
    });

    $("setup-copy-ide-btn").addEventListener("click", () => {
      copyText($("setup-ide-cmd").textContent, activeIde.toUpperCase() + " COMMAND COPIED");
    });

    if ($("setup-copy-status-btn")) {
      $("setup-copy-status-btn").addEventListener("click", () => {
        copyText(window.RuntimeGate.getSnippets().status, "STATUS COMMAND COPIED");
      });
    }

    $("setup-copy-uninstall-btn").addEventListener("click", () => {
      copyText(window.RuntimeGate.getSnippets().uninstall, "UNINSTALL COMMAND COPIED");
    });

    // OpenRouter Key Creation on Step 2B
    $("mint-or-key-btn").addEventListener("click", handleMintOpenRouterKey);
    $("clear-or-key-btn").addEventListener("click", clearOpenRouterKey);
    $("or-prov-key-input").addEventListener("input", () => {
      if (orStatusOverride && orStatusOverride.startsWith("ERROR:")) {
        orStatusOverride = "";
      }
      renderState(window.RuntimeGate.getState());
    });
    $("or-prov-key-input").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        handleMintOpenRouterKey();
      }
    });
    $("setup-copy-minted-btn").addEventListener("click", () => {
      const minted = getMintedKeyInfoSafe();
      if (minted && minted.mintedKey) {
        copyText(minted.mintedKey, "GATED KEY COPIED");
      }
    });

    // Strict Step 2 Gate Activation Guard (Supervisor Condition #2)
    document.querySelectorAll(".js-activate-gate-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        playHwTick(1040, 10);
        if (activePath === "openrouter") {
          const existingMinted = getMintedKeyInfoSafe();
          const pendingKey = ($("or-prov-key-input") ? $("or-prov-key-input").value : "").trim();
          if (pendingKey || !(existingMinted && existingMinted.mintedKey)) {
            const ok = await handleMintOpenRouterKey();
            if (!ok) return;
          }
        }
        window.RuntimeGate.setGateConfig({
          gatePath: activePath,
          selectedIde: activeIde,
          gateActivated: true
        });
        renderState(window.RuntimeGate.getState());
        showScreen("console", true);
      });
    });

    // Screen 6: Pure Live Tracker (#console) + Focus-Trapped QR Modal
    if ($("console-walk-btn")) {
      $("console-walk-btn").addEventListener("click", () => {
        playHwTick(920, 10);
        walkOpenedFromSteps = false;
        const isMobileUa = /iphone|ipad|ipod|android/i.test(navigator.userAgent || "");
        setWalkMode(isMobileUa ? "phone" : "health");
        showScreen("walk", true);
        if (isMobileUa) startMotionPedometerAutoIfPermitted();
      });
    }
    if ($("console-copy-key-btn")) {
      $("console-copy-key-btn").addEventListener("click", () => {
        const minted = getMintedKeyInfoSafe();
        if (minted && minted.mintedKey) {
          copyText(minted.mintedKey, "GATED KEY COPIED");
        }
      });
    }
    if ($("console-qr-btn")) {
      $("console-qr-btn").addEventListener("click", openQrModal);
    }
    if ($("qr-modal-close-btn")) {
      $("qr-modal-close-btn").addEventListener("click", closeQrModal);
    }
    if ($("qr-modal-copy-btn")) {
      $("qr-modal-copy-btn").addEventListener("click", () => {
        copyText(window.RuntimeGate.getPairUrl(), "PHONE LINK COPIED");
      });
    }
    if ($("qr-modal")) {
      $("qr-modal").addEventListener("click", (ev) => {
        if (ev.target === $("qr-modal")) closeQrModal();
      });
    }
    window.addEventListener("keydown", (ev) => {
      const modal = $("qr-modal");
      if (!modal || modal.hidden) return;
      if (document.documentElement.classList.contains("rt-sticky-drop-active")) return;
      const activeEl = document.activeElement;
      if (
        activeEl &&
        typeof activeEl.closest === "function" &&
        (activeEl.closest(".rt-sticky-card") || activeEl.closest("#rt-sticky-dock"))
      ) {
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        closeQrModal();
        return;
      }
      if (ev.key === "Tab") {
        const focusables = [$("qr-modal-close-btn"), $("qr-modal-copy-btn")].filter(Boolean);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!modal.contains(document.activeElement)) {
          ev.preventDefault();
          first.focus();
        } else if (ev.shiftKey && document.activeElement === first) {
          ev.preventDefault();
          last.focus();
        } else if (!ev.shiftKey && document.activeElement === last) {
          ev.preventDefault();
          first.focus();
        }
      }
    });

    $("console-reconfig-btn").addEventListener("click", () => {
      playHwTick(840, 8);
      showScreen("steps", true);
    });

    $("console-calc-btn").addEventListener("click", () => {
      playHwTick(840, 8);
      rateReturnScreen = "console";
      showScreen("rate", true);
    });

    $("console-zero-btn").addEventListener("click", async () => {
      const btn = $("console-zero-btn");
      if (btn.disabled) return;
      playHwTick(640, 12);
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      try {
        const st = await window.RuntimeGate.resetToZero();
        renderState(st);
        showToast("RESET TO ZERO");
      } finally {
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
      }
    });

    // Screen 7: Phone Step Counter & WHOOP / Watch Check-In (#walk)
    setWalkQuickUnit(walkQuickUnit);
    setWalkMode(walkActiveMode);

    $("walk-back-btn").addEventListener("click", () => {
      playHwTick(840, 8);
      if (walkOpenedFromSteps) {
        walkOpenedFromSteps = false;
        showScreen("steps", true);
      } else {
        showScreen("console", true);
      }
    });

    if ($("walk-continue-gate-btn")) {
      $("walk-continue-gate-btn").addEventListener("click", () => {
        playHwTick(940, 10);
        walkOpenedFromSteps = false;
        openGatePicker(true);
      });
    }

    if ($("walk-mode-phone-btn") && $("walk-mode-health-btn")) {
      $("walk-mode-phone-btn").addEventListener("click", () => {
        playHwTick(880, 8);
        setWalkMode("phone");
      });
      $("walk-mode-health-btn").addEventListener("click", () => {
        playHwTick(880, 8);
        setWalkMode("health");
      });
      [$("walk-mode-phone-btn"), $("walk-mode-health-btn")].forEach((tabBtn) => {
        tabBtn.addEventListener("keydown", (ev) => {
          if (ev.key === "ArrowRight" || ev.key === "ArrowLeft" || ev.key === "ArrowDown" || ev.key === "ArrowUp") {
            ev.preventDefault();
            setWalkMode(walkActiveMode === "phone" ? "health" : "phone", true);
          }
        });
      });
    }

    const quickUnitBtns = [
      $("walk-unit-steps-btn"),
      $("walk-unit-cal-btn"),
      $("walk-unit-km-btn")
    ].filter(Boolean);
    quickUnitBtns.forEach((uBtn, idx) => {
      uBtn.addEventListener("click", () => {
        playHwTick(860, 8);
        setWalkQuickUnit(uBtn.dataset.walkUnit || "steps", false);
      });
      uBtn.addEventListener("keydown", (ev) => {
        if (ev.key === "ArrowRight" || ev.key === "ArrowDown" || ev.key === "ArrowLeft" || ev.key === "ArrowUp") {
          ev.preventDefault();
          const dir = ev.key === "ArrowRight" || ev.key === "ArrowDown" ? 1 : -1;
          const nextBtn = quickUnitBtns[(idx + dir + quickUnitBtns.length) % quickUnitBtns.length];
          if (nextBtn) setWalkQuickUnit(nextBtn.dataset.walkUnit || "steps", true);
        }
      });
    });

    if ($("walk-quick-form")) {
      $("walk-quick-form").addEventListener("submit", (ev) => {
        ev.preventDefault();
        handleQuickCheckInSubmit();
      });
    }
    if ($("walk-quick-submit-btn")) {
      $("walk-quick-submit-btn").addEventListener("click", handleQuickCheckInSubmit);
    }

    document.querySelectorAll(".walk-preset-chip[data-preset-unit]").forEach((chip) => {
      chip.addEventListener("click", () => {
        handleQuickPresetClick(chip.dataset.presetUnit, chip.dataset.presetVal);
      });
    });

    if ($("walk-scan-btn") && $("walk-screenshot-input")) {
      $("walk-scan-btn").addEventListener("click", () => {
        playHwTick(900, 8);
        $("walk-screenshot-input").value = "";
        $("walk-screenshot-input").click();
      });
      $("walk-screenshot-input").addEventListener("change", () => {
        const f = $("walk-screenshot-input").files && $("walk-screenshot-input").files[0];
        if (f) scanHealthScreenshotFile(f);
      });
    }

    const dropzone = $("walk-scan-dropzone");
    if (dropzone) {
      ["dragenter", "dragover"].forEach((evName) => {
        dropzone.addEventListener(evName, (ev) => {
          ev.preventDefault();
          dropzone.classList.add("is-dragover");
        });
      });
      ["dragleave", "dragend", "drop"].forEach((evName) => {
        dropzone.addEventListener(evName, (ev) => {
          ev.preventDefault();
          dropzone.classList.remove("is-dragover");
          if (evName === "drop" && ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]) {
            const f = ev.dataTransfer.files[0];
            if (/^image\//i.test(f.type || "")) {
              scanHealthScreenshotFile(f);
            }
          }
        });
      });
    }

    window.addEventListener("paste", (ev) => {
      if (currentScreen !== "walk" && currentScreen !== "steps" && currentScreen !== "console") return;
      const items = ev.clipboardData && ev.clipboardData.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf("image/") === 0) {
          const blob = items[i].getAsFile();
          if (blob) {
            ev.preventDefault();
            scanHealthScreenshotFile(blob);
            return;
          }
        }
      }
    });

    if ($("walk-pocket-dim-btn")) {
      $("walk-pocket-dim-btn").addEventListener("click", openPocketDimShield);
    }
    if ($("pocket-dim-shield")) {
      $("pocket-dim-shield").addEventListener("click", () => {
        const now = Date.now();
        if (now - lastPocketDimTapAt < 650) {
          closePocketDimShield();
        } else {
          lastPocketDimTapAt = now;
        }
      });
    }
    window.addEventListener("keydown", (ev) => {
      if (pocketDimActive && ev.key === "Escape") {
        ev.preventDefault();
        closePocketDimShield();
      }
    });

    if ($("walk-open-shortcuts-btn")) {
      $("walk-open-shortcuts-btn").addEventListener("click", () => {
        playHwTick(920, 8);
        handleCopyWalkHealthLink();
      });
    }

    $("walk-sensor-btn").addEventListener("click", toggleMotionPedometer);
    if ($("walk-copy-health-btn")) {
      $("walk-copy-health-btn").addEventListener("click", handleCopyWalkHealthLink);
    }

    function syncRouteFromUrl() {
      const {
        rawUrlPairVaultId,
        rawUrlSyncVaultId,
        stepsParam,
        calParam,
        kmParam,
        sharedParam,
        hasStepsKey,
        sourceParam
      } = getUrlSyncAndPairParams();

      if (sharedParam === "1") {
        consumeAndroidShareTargetIfPresent();
        return;
      }

      if (
        rawUrlSyncVaultId &&
        ((stepsParam !== null && stepsParam !== "") ||
          (calParam !== null && calParam !== "") ||
          (kmParam !== null && kmParam !== ""))
      ) {
        handleIncomingHealthSyncUrl();
        return;
      }

      const rawHash = (window.location.hash || "").replace(/^#/, "").split("?")[0].toLowerCase();

      if (rawHash === "how") {
        showScreen("how", false);
      } else if (rawHash === "rate" || rawHash === "calc" || rawHash === "calculator") {
        showScreen("rate", false);
        if (rawHash !== "rate") {
          history.replaceState({ screen: "rate" }, "", window.location.pathname + "#rate");
        }
      } else if (rawHash === "steps" || rawHash === "setup" || rawHash === "onboard") {
        showScreen("steps", false);
        if (rawHash !== "steps") {
          history.replaceState({ screen: "steps" }, "", window.location.pathname + "#steps");
        }
      } else if (rawHash === "gate" || rawHash === "choose") {
        gateSubView = "picker";
        showScreen("gate", false);
        if (rawHash !== "gate") {
          history.replaceState({ screen: "gate", gateSubView: "picker" }, "", window.location.pathname + "#gate");
        }
      } else if (rawHash === "gate/local" || rawHash === "gate/ide") {
        activePath = "ide";
        gateSubView = "walkthrough";
        showScreen("gate", false);
      } else if (rawHash === "gate/key" || rawHash === "gate/openrouter") {
        activePath = "openrouter";
        gateSubView = "walkthrough";
        showScreen("gate", false);
      } else if (rawHash === "console" || rawHash === "tracker") {
        showScreen("console", false);
        if (rawHash !== "console") {
          history.replaceState({ screen: "console" }, "", window.location.pathname + "#console");
        }
      } else if (rawHash === "walk" || rawUrlPairVaultId || rawUrlSyncVaultId) {
        if (sourceParam === "google_health" || sourceParam === "whoop_android") {
          walkHealthOs = "android";
        } else if (sourceParam === "apple_health") {
          walkHealthOs = "ios";
        }
        const sp = new URLSearchParams(window.location.search || "");
        const modeParam = (sp.get("mode") || "").trim().toLowerCase();
        setWalkMode(rawUrlSyncVaultId && hasStepsKey && stepsParam === "" ? "health" : modeParam === "health" ? "health" : "phone");
        if (rawUrlPairVaultId || rawUrlSyncVaultId) {
          walkOpenedFromSteps = false;
        }
        loadPendingWalkBackup();
        renderWalkCounters();
        showScreen("walk", false);
        const stCur = window.RuntimeGate ? window.RuntimeGate.getState() : null;
        const vId =
          rawUrlPairVaultId ||
          rawUrlSyncVaultId ||
          sessionPairContext.pairVaultId ||
          sessionPairContext.syncVaultId ||
          (stCur && stCur.isPaired ? stCur.vaultId : "");
        const ftCur =
          sessionPairContext.fieldToken || (stCur && stCur.fieldToken ? stCur.fieldToken : "");
        if (rawUrlPairVaultId && ftCur && !pairVisitSent && window.RuntimeGate && window.RuntimeGate.recordPairVisit) {
          pairVisitSent = true;
          window.RuntimeGate.recordPairVisit(rawUrlPairVaultId, ftCur).catch(() => {});
        }
        if (rawUrlSyncVaultId && hasStepsKey && stepsParam === "" && $("walk-pair-status")) {
          $("walk-pair-status").classList.add("is-alert");
          $("walk-pair-status").textContent =
            "ALMOST DONE: IN SHORTCUTS OPEN URLS, TAP 'CALCULATION RESULT' (SUM) RIGHT AFTER steps=";
        } else if (vId && $("walk-pair-status")) {
          $("walk-pair-status").classList.remove("is-alert");
          $("walk-pair-status").textContent = "PAIRED WITH YOUR COMPUTER";
        }
        if (rawUrlPairVaultId && walkActiveMode === "phone") {
          startMotionPedometerAutoIfPermitted();
        }
      } else {
        showScreen("landing", false);
      }
    }

    window.addEventListener("popstate", syncRouteFromUrl);
    window.addEventListener("hashchange", syncRouteFromUrl);
    syncRouteFromUrl();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
