# TubeForge Voice Server — run voice cloning on YOUR laptop

Free, open-source, unlimited narration. No API bills, no rate limits, your
voice samples never leave your machine. Uses **Chatterbox** (Resemble AI,
MIT license — safe for monetized channels).

Verified hardware: AMD Ryzen 7 8845HS (CPU-only), 32 GB RAM — works fine.

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
python voice_server.py --key pick-any-secret
```

Wait for `model ready` + the warm-up sentence (~1–3 min on first run).

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

- **Speed:** ~real-time on your CPU — a 15 s narration paragraph takes
  ~15–45 s. Render overnight or while at lunch; nothing is billed.
- **Languages:** default model is English. For 23 languages run
  `python voice_server.py --model chatterbox-multilingual --lang en`
- **Laptop asleep / tunnel off?** TubeForge shows a clear
  "voice server unreachable" error — start the two windows and retry.
  The trycloudflare URL changes on each restart — update Base URL then.
- **Keep the `--key` secret**: anyone with the URL + key can use your GPU.
- **Disk:** ~4 GB (model + venv). **RAM:** ~4–6 GB while running.
- F5-TTS alternative has slightly better quality but its model weights are
  **non-commercial** (CC-BY-NC) — not safe for monetized channels, which is
  why Chatterbox (MIT) is the default here.
