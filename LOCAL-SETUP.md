# TubeForge — Local Setup Guide

Run TubeForge (AI YouTube automation studio) on your own machine.

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | ≥ 20 | required by z-ai-web-dev-sdk |
| **npm / bun** | latest | bun is faster; npm works fine |
| **ffmpeg** | any recent | optional today, required for the upcoming video-render features |

Check yours: `node -v && ffmpeg -version`

## 1. Unzip & install

```bash
unzip tubeforge-local.zip -d tubeforge && cd tubeforge
npm install          # or: bun install
```

## 2. Configure environment

```bash
cp .env.example .env
```

`.env` contents (relative path works anywhere):

```
DATABASE_URL=file:../db/custom.db
```

## 3. Create the database

```bash
npm run db:generate   # generate the Prisma client
npm run db:push       # create db/custom.db with all tables
```

## 4. AI credentials (important!)

AI features (script writing, TTS voiceover, thumbnails, topic research)
authenticate through a `.z-ai-config` JSON file that the SDK looks for in:

1. project root (`.z-ai-config`) ← put it here
2. your home directory (`~/.z-ai-config`)
3. `/etc/.z-ai-config`

A template is included: **`.z-ai-config.example`**

```bash
cp .z-ai-config.example .z-ai-config
# then fill in real values
```

```json
{
  "baseUrl": "<your Z.ai / bigmodel-compatible endpoint>",
  "apiKey": "<your key>",
  "chatId": "<your chat id>",
  "token": "<your token>",
  "userId": "<your user id>"
}
```

> **Where do I get values?** They come from your Z.ai web-dev session
> (the file lives at `/etc/.z-ai-config` inside the sandbox — ask your
> assistant to print the *key names*, never share the secrets publicly).
> Without a valid config the app still runs: browsing, channels, calendar,
> and library all work — only AI generation stages will fail with an auth error.

## 5. Run it

```bash
npm run dev           # http://localhost:3000
```

Production build:

```bash
npm run build
npm start             # serves the standalone build
```

## First run checklist

- [ ] Dashboard loads at http://localhost:3000
- [ ] Channels → create your channel
- [ ] Create → type a topic → Auto-Pilot 🚀
- [ ] Generated media lands in `uploads/<videoId>/`

## Project layout (quick map)

```
prisma/schema.prisma        data models (Video, Channel, Activity, ...)
db/custom.db                SQLite database (created by db:push)
uploads/<videoId>/          voiceover.wav, thumbnail.png, variants
src/lib/tubeforge/          AI pipeline, async jobs, WAV merge, ZIP export
src/app/api/                REST routes (videos, research, schedule, ...)
src/components/tubeforge/   UI views (dashboard, create, library, calendar)
scripts/                    test & repair utilities (node scripts/<file>.mjs)
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `PrismaClientInitializationError` | run `npm run db:push`; check `.env` path |
| AI calls fail with auth/401 | `.z-ai-config` missing or invalid values |
| 429 "Too many requests" | upstream rate limit — the app auto-retries with backoff; wait a minute and re-run the stage |
| Port 3000 busy | `npm run dev -- -p 3001` |
| Voiceover/thumbnail stuck | generation runs as background jobs — the UI polls automatically; check the server console for `[ai-retry]` lines |

## Notes

- All pipeline stages are **async** (202 + polling) — long generations
  never block or time out the UI.
- Voiceovers are chunked (≤950 chars) and merged into one WAV automatically.
- The A/B thumbnail lab generates 3 art directions; click one to promote it.
- ZIP export bundles script, metadata, tags, audio, and thumbnails for
  manual YouTube upload.
