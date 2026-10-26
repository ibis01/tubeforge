# TubeForge — Run It on Your Own PC

TubeForge is a YouTube-automation studio: it researches topics, writes scripts with
GLM, splits them into scene storyboards, paints AI images, generates voiceovers,
renders the final MP4 (with Shorts), and can even upload to YouTube.

This package contains the full source code plus your SQLite database
(`db/custom.db`) with your existing library. Generated media (rendered videos,
thumbnails, voiceovers — the `uploads/` folder) was intentionally left out
because it is 550+ MB; everything regenerates on demand.

---

## 1. What you need before starting

| Requirement | Why | Where to get it |
|---|---|---|
| **Node.js 20+ (LTS)** | runs the Next.js app | https://nodejs.org (npm comes with it) |
| **ffmpeg + ffprobe** on your PATH | video render, Shorts, narration checks | Ubuntu/Debian: `sudo apt install ffmpeg` · macOS: `brew install ffmpeg` · Windows: `winget install ffmpeg` |
| **A Z.ai API key** | every AI step (script, TTS, images, video) calls Z.ai services | https://z.ai/model-api — sign up, open API Keys, create a key (free) |
| ~2 GB free disk | node_modules + generated media | — |

**Cost tip:** the app defaults to the **GLM-4.5 Flash** chat model, which is
**free** on Z.ai — script writing costs $0. Voiceovers (TTS), images and video
rendering need a small credit balance on your account.

---

## 2. Setup (4 steps)

```bash
# 1. unzip the package, then:
cd tubeforge

# 2. install dependencies (this also runs `prisma generate` automatically)
npm install

# 3. start it
npm run dev
```

4. Open **http://localhost:3000** → go to **Settings → AI Provider (Z.ai)**:

   - paste your **API key**
   - base URL is pre-filled (`https://api.z.ai/api/paas/v4`)
   - pick the **Script / chat model** (GLM-4.5 Flash = free default)
   - click **Save & apply**, then **Test connection** — it should reply in green.

That's it — no config files to edit by hand. The database ships preloaded with
your videos, channels, characters and settings, so the Library looks exactly
like it does in the sandbox.

To let other devices on your Wi-Fi reach it: `npm run dev:lan`.

---

## 3. Optional: config file instead of the UI

The AI SDK reads a `.z-ai-config` JSON file (project dir → home dir → `/etc`).
The Settings UI writes this file for you. If you prefer doing it manually:

```bash
cp .z-ai-config.example .z-ai-config
nano .z-ai-config   # paste your key
```

- bigmodel.cn key instead? Set `"baseUrl": "https://open.bigmodel.cn/api/paas/v4"` (in the file or the Settings UI).
- Keep this file private — never commit it to git (already in `.gitignore`).

The same 429 quota limits can happen on your own key. The app handles them:
escalating retry back-offs, patient storm rounds, and the red **Stop** button
on scripting videos / library cards.

---

## 4. What ships in this package

```
tubeforge/
├── src/               # full app source (Next.js 16 + React 19 + Tailwind 4)
├── prisma/            # database schema (SQLite)
├── db/custom.db       # YOUR current library data (videos, channels, settings)
├── public/            # icons, PWA manifest
├── scripts/           # diagnostic + test scripts (optional to use)
├── package.json       # npm scripts (dev / build / db)
├── .env               # DATABASE_URL — relative path, works anywhere
├── .env.example       # same, for reference
├── .z-ai-config.example  # optional manual config template
└── SETUP.md           # this guide
```

---

## 5. Troubleshooting

**`ffmpeg not found`** when rendering — install it (see table above) and restart
the dev server so the PATH refreshes.

**`Error: Cannot find module '@prisma/client'`** — run `npx prisma generate`
(the `postinstall` hook normally does this for you).

**`P1003: database file does not exist`** — the `.env` uses a relative path
(`file:../db/custom.db`), resolved against the `prisma/` folder. Keep the folder
layout as shipped, or run `npm run db:push` to recreate an empty database.

**AI calls fail instantly with 429** — quota throttling on your API key, not a
bug. Free flash models are concurrency-limited: wait a moment or switch model in
Settings. Paid models need credit on the account. Use the **Stop** button to
cancel and retry later.

**Test connection fails with auth error** — the key was copied with a stray
space/newline, or was revoked. Re-copy it from the Z.ai API keys page.

**Port 3000 already in use** — change the port: `npx next dev -p 3001`.

**Production mode** (optional):
```bash
npm run build
npm start        # serves the optimized build on port 3000
```
