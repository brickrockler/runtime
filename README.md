# RUNTIME — Burn Calories to Burn Tokens

> **Oh, you wanna burn some tokens? Not until you burn some calories, punk.**

RUNTIME locks your AI coding agent or OpenRouter API key when your step balance hits zero. Walk outside with your phone, Apple Watch, or fitness band to earn tokens back.

**Live App:** [https://runtime.jackcolley.com](https://runtime.jackcolley.com) ([mirror](https://runtime-jackcolley.web.app))

## How It Works

1. **Walk** — Scan the QR code with your phone to count live pocket steps in your browser, or sync daily steps from Apple Watch / Apple Health via an iOS Shortcut.
2. **Prompt** — Spend your steps prompting Claude Code, Codex, Cursor, Antigravity, or any model on OpenRouter (`1,000 steps = 25,000 tokens` or `$0.50` credit on Standard difficulty).
3. **Uh-Oh** — Hit zero and your AI locks shut cold until you go take another walk. As your tank fills up, the live tracker shifts from red (`0%`) through orange and yellow into bright green (`100%`) and sky blue (`150%+`).

## Two Ways to Gate Your AI

- **Block Local Agent (`public/gate.js`)** — Installs a lightweight local hook for Claude Code, Codex, Cursor, or Antigravity that blocks prompts at zero steps and deducts tokens per turn. Works with the subscription you already pay for — no API key needed.
- **Mint API Key (OpenRouter)** — Uses an OpenRouter Management Key stored strictly in your browser's `localStorage` to mint a child API key whose dollar spending cap rises as you walk and disables at `$0.00`. Raw API keys never leave your browser.

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
