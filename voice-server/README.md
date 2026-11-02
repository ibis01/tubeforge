# TubeForge Voice Server — run voice cloning on YOUR laptop

Free, open-source, unlimited narration. No API bills, no rate limits, your
voice samples never leave your machine. Uses **Chatterbox** (Resemble AI,
MIT license — safe for monetized channels).

Verified hardware: AMD Ryzen 7 8845HS (CPU-only), 32 GB RAM — works fine.

> **Don't want your PC involved?** Two $0 cloud options:
> - **Oracle Cloud Always Free VM** — 24/7, no sleep, fastest of the three hosts → [`oracle/README.md`](oracle/README.md)
> - **Hugging Face Space** — easiest, but 2-4× slower and sleeps when idle → [`hf-space/README.md`](hf-space/README.md)
>
> **Running TubeForge self-hosted (Docker/VPS)?** You can run ONE voice server
> next to the app and share it with all your users — see
> [Shared voice server](#shared-voice-server-operator) below. Zero per-user setup.

## One-time setup (Windows, ~10 minutes)

1. **Install Python 3.11** from https://www.python.org/downloads/
   (tick **"Add python.exe to PATH"** in the installer)
2. Open **PowerShell** in this `voice-server` folder, then:

```powershell
py -3.11 -m venv .venv
.venv\Scripts\activate
pip install --upgrade pip
pip install chatterbox-tts fastapi "uvicorn[standard]" torchaudio
```

3. **Install the Cloudflare tunnel** (free, no account needed):

```powershell
winget install Cloudflare.cloudflared
```

## Every time you want to render videos

Open two PowerShell windows in this folder:

**Window 1 — the voice server** (first launch downloads ~1–2 GB model):

```powershell
.venv\Scripts\activate
python voice_server.py --key pick-any-secret --model chatterbox-turbo
```

Wait for `model ready` + the warm-up sentence (~1–3 min on first run).

> **Which model?** `chatterbox-turbo` (default above) is the distilled
> variant — **8-10× faster on CPU** (~3-5× real-time on a modern laptop) and
> loads with ~1.3 GB RAM via the built-in low-memory loader, at a small
> quality cost. `chatterbox` (the original) sounds slightly better but needs
> ~4-6 GB RAM and ~30-45× real-time on CPU. Both are MIT-licensed and clone
> from the same 3-30 s samples.

**Window 2 — the public tunnel:**

```powershell
cloudflared tunnel --url http://localhost:8931
```

It prints a line like `https://something-words.trycloudflare.com` — copy it.

## Wire it into TubeForge

1. TubeForge → **Settings → AI Providers → Voiceover**
2. Pick **"My Machine (self-hosted)"**
3. **Base URL** = the `https://...trycloudflare.com` URL from Window 2
4. **API key** = the same `--key` secret you started the server with
5. Save → upload a 5–30 s voice sample on any video → **Clone** →
   your cloned voice appears in every voice picker

## Notes

- **Speed:** turbo runs ~3-5× real-time on a modern CPU — a 15 s narration
  paragraph takes ~1-2 min; render overnight or while at lunch; nothing is
  billed. The original `chatterbox` model is ~30-45× real-time on CPU
  (fine on a GPU).
- **Small CPU (1-2 cores / shared box)?** Set `VOICE_THREADS=1` before
  starting the server so synthesis leaves a core free for everything else.
- **Languages:** default model is English. For 23 languages run
  `python voice_server.py --model chatterbox-multilingual --lang en`
  (the multilingual variant only ships in the original size — slower).
- **Laptop asleep / tunnel off?** TubeForge shows a clear
  "voice server unreachable" error — start the two windows and retry.
  The trycloudflare URL changes on each restart — update Base URL then.
- **Keep the `--key` secret**: anyone with the URL + key can use your GPU.
- **Disk:** ~4 GB (model + venv). **RAM:** ~1.5 GB for turbo (low-memory
  mmap loader), ~4–6 GB for the original model while running.
- F5-TTS alternative has slightly better quality but its model weights are
  **non-commercial** (CC-BY-NC) — not safe for monetized channels, which is
  why Chatterbox (MIT) is the default here.

## Shared voice server (operator)

Self-hosting TubeForge (Docker, VPS, a sandbox)? Run ONE voice server on the
same box and every user gets voice cloning with **zero per-user setup** —
no laptop, no tunnel, no Zhipu key. Users who save their OWN server URL in
Settings still take precedence for their account.

```bash
# 1. Install (once) — same as above, CPU-only torch keeps it small
cd voice-server
python3 -m venv .venv
.venv/bin/pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cpu
.venv/bin/pip install chatterbox-tts fastapi "uvicorn[standard]"

# 2. Start it (or let the app auto-spawn it — see the env below)
HF_HOME=$PWD/hf-cache VOICE_THREADS=1 \
  .venv/bin/python voice_server.py --model chatterbox-turbo --port 8931 --key pick-any-secret
```

Then in the TubeForge app's `.env`:

```bash
TUBEFORGE_SHARED_VOICE_URL=http://127.0.0.1:8931
TUBEFORGE_SHARED_VOICE_KEY=pick-any-secret   # the --key value above
# Optional — let the app start the server itself on boot (loopback URLs
# only; spawns detached, waits for nothing, synthesis retries on 503 while
# the model loads):
TUBEFORGE_SPAWN_VOICE_SERVER=1
TUBEFORGE_VOICE_SERVER_DIR=/opt/tubeforge/voice-server
TUBEFORGE_VOICE_SERVER_MODEL=chatterbox-turbo
# Recommended: CPU synthesis legitimately runs long
TUBEFORGE_TIMEOUT_TTS=600000
```

What users see: the Clone panel says "Clones speak through this platform's
shared voice server", every new clone gets an instant audition, and cloned
voices appear in every voice picker. On Vercel/serverless, leave these env
vars unset — nothing changes.
