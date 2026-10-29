---
title: TubeForge Voice Server
emoji: 🎙️
colorFrom: gray
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# TubeForge Voice Server — free cloud edition

The same `voice_server.py` that runs on a laptop, packaged for a **free
Hugging Face Space** (CPU basic: 2 vCPU, 16 GB RAM). No PC needed, no credit
card, no bill — Chatterbox is MIT-licensed, safe for monetized channels.

## Deploy it (5 minutes)

1. Create a free account at https://huggingface.co (no card needed).
2. **New Space** → name it `tubeforge-voice` → SDK: **Docker** → **Blank** → Create.
3. In the Space → **Files** tab → upload these **3 files from this folder**:
   - `README.md` (this file — its YAML header configures the Space)
   - `Dockerfile`
   - `voice_server.py` (copy it in from the parent folder)
4. **Settings → Variables and secrets → New secret**: name `VOICE_KEY`,
   value = any secret phrase. The server refuses requests without it.
5. Wait for the build (~10 min the first time: installs CPU torch +
   Chatterbox, downloads the ~1.5 GB model). Status turns **Running**.

Your endpoint is now permanent:
`https://<your-username>-tubeforge-voice.hf.space`

## Wire it into TubeForge

Settings → AI Providers → Voiceover → **My Machine (self-hosted)**:

- **Base URL** = `https://<your-username>-tubeforge-voice.hf.space`
- **API key** = the `VOICE_KEY` secret you set in step 4
- Model: `chatterbox` (English) or `chatterbox-multilingual` (23 languages —
  redeploy with `--model chatterbox-multilingual` in the Dockerfile CMD)

Upload a voice sample on any video → Clone → narrate. Same flow as the
laptop edition — only the host differs.

## Honest limits of the free Space

- **Speed:** 2 shared vCPUs — expect roughly 2-4× slower than a Ryzen 7
  laptop. A 15-second narration paragraph can take 1-3 minutes. Fine for
  batch rendering; the TubeForge pipeline sends short chunks and waits.
- **Sleep:** free Spaces sleep after ~48 h with zero traffic. The next
  request wakes the Space automatically (~2-4 min: container restart +
  model load). If the first call times out, just retry — or keep it warm
  with a daily ping to `/health` (e.g. cron-job.org, free).
- **Quota:** the free CPU tier is meant for personal use — one user's
  narration pipeline is comfortably inside it.
- **Public URL:** anyone can see the Space exists, but `/tts` is useless
  without your `VOICE_KEY`. Keep that secret out of public repos.
- **Rebuilds** re-download the model (~1-2 min) since the disk is ephemeral.
