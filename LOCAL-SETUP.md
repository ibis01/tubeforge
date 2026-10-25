# TubeForge — Local Setup Guide

Run TubeForge (AI YouTube automation studio) on your own machine: AI scripts,
scene storyboards, **real animated MP4 rendering**, AI thumbnails, and
**bring-your-own-voice** — use any voice audio from the internet instead of the
built-in TTS voices.

## What's inside

- **Topic Radar** — GLM mines your niche for high-scoring video ideas (fed by real YouTube performance data).
- **Script → Storyboard → Voice → Thumbnail** — the full AI production line.
- **Two render modes** — Ken Burns cinematic motion (fast, ~2 min) or **Full AI animation** via CogVideoX image-to-video (~4 min per scene).
- **Bring-your-own-voice** — don't like the 7 built-in voices? Upload your own audio file or paste a direct URL to any mp3/wav/m4a on the internet; TubeForge converts it to studio audio and auto-cuts it across scenes.
- **Auto-Shorts** — every render can be cut into a 9:16 vertical Short.
- **Smart captions, narration check (ASR), engagement kit, publish calendar, YouTube OAuth upload, analytics loop.**

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | ≥ 20 | required by z-ai-web-dev-sdk |
| **npm / bun** | latest | bun is faster; npm works fine |
| **ffmpeg + ffprobe** | any recent build | **required** — video rendering, scene audio cutting, custom-voice conversion and the narration check all use it |

Check yours: `node -v && ffmpeg -version && ffprobe -version`

- Windows: `winget install Gyan.FFmpeg` (then reopen the terminal)
- macOS: `brew install ffmpeg`
- Debian/Ubuntu: `sudo apt install ffmpeg`

## 1. Unzip & install

```bash
unzip tubeforge-local.zip -d tubeforge && cd tubeforge
npm install          # or: bun install
```

## 2. Configure environment

```bash
cp .env.example .env
```

`.env` contents (the relative path works anywhere):

```
DATABASE_URL="file:../db/custom.db"
```

## 3. Create the database

```bash
npx prisma generate          # or: bun run db:generate
npx prisma db push           # or: bun run db:push
```

## 4. Z.ai credentials (for the AI stages)

TubeForge talks to GLM / TTS / CogView / CogVideoX through `z-ai-web-dev-sdk`,
which reads a `.z-ai-config` JSON file. A template is included:

```bash
cp .z-ai-config.example .z-ai-config
```

Then fill in your real values:

```json
{
  "baseUrl": "REPLACE_WITH_YOUR_ZAI_ENDPOINT",
  "apiKey": "REPLACE_WITH_YOUR_KEY",
  "chatId": "REPLACE_WITH_YOUR_CHAT_ID",
  "token": "REPLACE_WITH_YOUR_TOKEN",
  "userId": "REPLACE_WITH_YOUR_USER_ID"
}
```

The app starts fine **without** credentials — you can browse the UI and the
library. Every AI stage (script, storyboard, TTS, thumbnails, video render,
narration check) needs valid credentials.

## 5. Run

```bash
npm run dev          # development — http://localhost:3000
# or production:
npm run build && npm start
```

## 6. First-run checklist

1. Open `http://localhost:3000` — the dashboard loads.
2. **Settings** → the pipeline defaults (voice, budget, quality gate) live here.
3. **Create** → pick a topic (or greenlight an idea from **Topic Radar**).
   *Format* defaults to **Scene-based story** — that's what makes real MP4s.
4. **Render mode**:
   - *Ken Burns* — fast cinematic motion over painted scenes.
   - *Full AI animation* — CogVideoX animates every scene (~4 min/scene).
5. Auto-Pilot runs the whole line end-to-end; watch the stepper.

## Using your own voice (no TTS)

Every video's **Package** tab has a **"Change the voice"** panel:

- **AI voices** — the 7 built-in voices (Jam, Kazi, Xiaochen, Tongtong, Chuichui, Douji, Luodo) + regenerate.
- **Upload** — attach your own recording (mp3 / wav / m4a / ogg / flac … up to 100 MB, up to 30 min).
- **From URL** — paste a DIRECT internet link to an audio file; TubeForge downloads and converts it.

Scene videos get the attached voice **auto-cut across scenes** (silence-snapped),
so the video timeline still maps 1:1 — then re-render the video to hear it in
the MP4. If you already generated a TTS voiceover, attaching your own audio
replaces it (and "Switch to AI voice" in the footer flips back).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ffmpeg failed` / render errors | Install ffmpeg + ffprobe and reopen the terminal (`ffmpeg -version` must work). |
| 429 "Too many requests" during voiceover/thumbnails | Upstream rate limiting. TubeForge paces and retries for ~16 min; if it still fails, wait a few minutes and hit the stage's retry button. |
| Video stuck "generating" after a crash | Reopen the app — interrupted jobs are detected and explained in Settings → Background Jobs; re-run the stage. |
| AI stages say "not configured" | `.z-ai-config` missing or contains placeholder values. |
| `Unknown argument voiceSource` (or similar) | Prisma client is stale: `npx prisma generate && npx prisma db push`, restart. |
| Upload-to-YouTube fails | Settings → YouTube Connection needs a Google Cloud OAuth client (Data API v3 enabled) and the exact redirect URI shown there. |
| Port 3000 busy | `PORT=3001 npm run dev` |

## Notes

- The SQLite database lives in `db/custom.db` (created by `prisma db push`); media artifacts land in `uploads/<videoId>/`.
- Deleting a video removes its media folder contents from the pipeline; the ZIP export bundles script, audio, storyboard, captions, kit and the MP4.
