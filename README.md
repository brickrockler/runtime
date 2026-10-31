# RUNTIME — Burn Calories to Burn Tokens

> **Oh, you wanna burn some tokens? Not until you burn some calories, punk.**

RUNTIME locks your AI coding agent or OpenRouter API key when your step balance hits zero. Walk outside or train with your phone, WHOOP, Fitbit, Garmin, Strava, or Apple Watch to earn tokens back.

**Live App:** [https://runtime.jackcolley.com](https://runtime.jackcolley.com) ([mirror](https://runtime-jackcolley.web.app))

## How It Works

1. **Connect Live Fitness Data (or Walk with Your Phone)**:
   - **Live Bluetooth Strap / Watch (`Zero Keys`)** — Pair **WHOOP 4.0 / 5.0** (*Broadcast Heart Rate*), **Garmin**, **Fitbit**, **Polar**, or **Wahoo** directly in Chrome on Android or Mac to stream live heart rate / cadence and unlock tokens in real time.
   - **Official Cloud Account Sync (`WHOOP`, `Fitbit / Google Health`, `Strava`, `Apple Health`)** — Connect **Fitbit / Pixel Watch / Google Health** (`health.googleapis.com/v4`) or **Strava** (including workouts auto-synced from WHOOP, Garmin, Oura, Samsung Health, or Apple Watch) directly in your browser, connect the **WHOOP Official v2 API** (`step_count`, `strain`, and workout `kilojoules`) via `node ~/.runtime/gate.js --connect whoop` so every AI prompt auto-syncs your latest WHOOP data, or use the 1-tap **iPhone Apple Health** sync link.
   - **Browser Pocket Counter + On-Device Screenshot Backup** — Count live pocket steps right in Chrome or Safari (with an OLED Pocket Lock dimmer), or scan a workout screenshot privately on-device as a quick backup.
2. **Prompt** — Spend your steps prompting Claude Code, Codex, Cursor, Antigravity, or any model on OpenRouter (`1,000 steps = 25,000 tokens` or `$0.50` credit on Standard difficulty).
3. **Uh-Oh** — Hit zero and your AI locks shut cold until you go move again. As your tank fills up, the live tracker shifts from red (`0%`) through orange and yellow into bright green (`100%`) and sky blue (`150%+`).

## Two Ways to Gate Your AI

- **Block Local Agent (`public/gate.js`)** — One Terminal command (`--install auto`) automatically detects Claude Code, Codex, Cursor, and Antigravity on your computer, blocks prompts at zero steps, deducts tokens per turn, and auto-syncs connected WHOOP / Fitbit / Strava accounts (`--connect whoop`, `--sync`, `--bridge`). Works with the subscription you already pay for — no API key needed.
- **Mint API Key (OpenRouter)** — Uses an OpenRouter Provisioning Key stored strictly in your browser's `localStorage` to mint a child API key whose dollar spending cap rises as you walk and disables at `$0.00`. Raw API keys and fitness tokens never leave your device.

## Run Locally

Double-click `start.command` on macOS, or serve `public/` with any static server:

```bash
python3 -m http.server 8788 --directory public --bind 127.0.0.1
```

Then open `http://127.0.0.1:8788`.

## Deploy

### Firebase Hosting
```bash
cp .firebaserc.example .firebaserc
cp firestore.rules.example firestore.rules
firebase deploy --only hosting:runtime
```

### Vercel
Import the repository into Vercel — `vercel.json` serves `public/` out of the box with no build step required.
