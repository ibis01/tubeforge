#!/usr/bin/env python3
"""
TubeForge voice server — self-hosted voice cloning on YOUR machine.

Wraps Chatterbox (Resemble AI, MIT license — commercial use allowed) behind a
tiny HTTP API that TubeForge calls for narration:

    POST /tts     {"text": "...", "voice": "<base64 wav or empty>", "speed": 1.0}
                  header: X-Voice-Key: <secret>          (only if you started
                                                          the server with --key)
                  -> audio/wav bytes (24 kHz)

                  `speed` 0.5-2.0 changes tempo without changing pitch
                  (1.5 = one and a half times as fast).

    GET /health   -> {"ok": true, "model": ..., "device": ...}

Runs on CPU (no NVIDIA GPU needed). First launch downloads the model
(~1-2 GB, cached afterwards). Speed on a Ryzen 7 8845HS: roughly real-time —
a 15-second narration paragraph takes ~15-45 s.

Run:
    python voice_server.py --key my-secret            # auth recommended when
                                                      # exposed via a tunnel
Expose to TubeForge (Vercel) with a free Cloudflare quick tunnel:
    cloudflared tunnel --url http://localhost:8931
Then paste the printed https://...trycloudflare.com URL into
TubeForge -> Settings -> AI Providers -> Voiceover -> "My Machine (self-hosted)"
as the Base URL, and the same --key value as the API key.
"""

import argparse
import asyncio
import base64
import binascii
import os
import re
import sys
import tempfile
import threading
import time

# FastAPI/uvicorn/torch imports happen lazily in main() so `--help` and
# syntax checks work even before dependencies are installed.

MODEL_EN = "chatterbox"
MODEL_MULTI = "chatterbox-multilingual"
SAMPLE_RATE = 24000          # Chatterbox output rate (S3GEN_SR)
MAX_TEXT_CHARS = 5000
MAX_VOICE_B64 = 4_000_000    # ~3 MB wav — way above our 30 s / 24 kHz samples
CHUNK_CHARS = 280            # Chatterbox quality degrades on very long text
SILENCE_SEC = 0.12

_state = {
    "model": None,
    "kind": MODEL_EN,
    "device": "cpu",
    "sr": SAMPLE_RATE,
    "busy": False,   # True while a synthesis is running
}

# Chatterbox forwards are NOT safe to run concurrently on one model instance —
# every synthesis is serialized through this lock (requests queue up).
_synth_lock = threading.Lock()


def log(msg: str) -> None:
    print(f"[voice-server] {msg}", flush=True)


def load_model(kind: str, device: str):
    """Download (first run) + load the Chatterbox model."""
    if kind == MODEL_MULTI:
        from chatterbox.mtts import ChatterboxMultilingualTTS
        log("loading Chatterbox Multilingual (23 languages) ...")
        model = ChatterboxMultilingualTTS.from_pretrained(device=device)
    else:
        from chatterbox.tts import ChatterboxTTS
        log("loading Chatterbox (English) ...")
        model = ChatterboxTTS.from_pretrained(device=device)
    log("model ready")
    return model


def split_sentences(text: str) -> list:
    """Sentence-ish chunks under CHUNK_CHARS — keeps clone quality stable."""
    parts = re.split(r"(?<=[.!?;:])\s+", text.strip())
    chunks = []
    buf = ""
    for part in parts:
        if not part:
            continue
        if len(part) > CHUNK_CHARS:
            # Very long sentence: split on commas, then hard-split.
            for sub in re.split(r"(?<=[,])\s+", part):
                if len(sub) > CHUNK_CHARS:
                    for i in range(0, len(sub), CHUNK_CHARS):
                        chunks.append(sub[i: i + CHUNK_CHARS])
                else:
                    chunks.append(sub)
            continue
        if len(buf) + len(part) + 1 > CHUNK_CHARS:
            chunks.append(buf)
            buf = part
        else:
            buf = f"{buf} {part}".strip()
    if buf:
        chunks.append(buf)
    return chunks or [text.strip()]


def synthesize(text: str, prompt_path, language: str):
    """Generate audio for possibly-long text; returns a single waveform tensor."""
    import torch

    model = _state["model"]
    chunks = split_sentences(text)
    log(f"synthesizing {len(chunks)} chunk(s) ...")
    waves = []
    silence = torch.zeros(1, int(SILENCE_SEC * _state["sr"]))
    t0 = time.time()
    for i, chunk in enumerate(chunks, 1):
        if _state["kind"] == MODEL_MULTI:
            wav = model.generate(chunk, language_id=language, audio_prompt_path=prompt_path)
        else:
            wav = model.generate(chunk, audio_prompt_path=prompt_path)
        waves.append(wav.cpu())
        if len(chunks) > 1:
            waves.append(silence)
            log(f"  chunk {i}/{len(chunks)} done ({time.time() - t0:.1f}s elapsed)")
    audio = torch.cat([w for w in waves if w.numel()], dim=1)
    log(f"synthesis finished in {time.time() - t0:.1f}s -> {audio.shape[1] / _state['sr']:.1f}s audio")
    return audio


def time_stretch(audio, speed: float):
    """Pitch-preserving tempo change (speed > 1 = faster). librosa ships with
    Chatterbox; if it is somehow missing we return the audio unchanged."""
    try:
        import librosa
        import numpy as np
        import torch

        y = audio.squeeze(0).numpy().astype("float32")
        stretched = librosa.effects.time_stretch(y=y, rate=float(speed))
        return torch.from_numpy(np.ascontiguousarray(stretched)).unsqueeze(0)
    except Exception as exc:
        log(f"speed adjustment skipped ({exc})")
        return audio


def synthesize_locked(text: str, prompt_path, language: str, speed: float):
    """One synthesis at a time; runs on a worker thread so the HTTP event
    loop (and /health) stay responsive during long CPU jobs."""
    with _synth_lock:
        audio = synthesize(text, prompt_path, language)
        if abs(speed - 1.0) >= 0.01:
            audio = time_stretch(audio, speed)
    return audio


def wav_bytes(audio) -> bytes:
    import io

    import torchaudio

    buf = io.BytesIO()
    torchaudio.save(buf, audio, _state["sr"], format="wav")
    return buf.getvalue()


def write_prompt_wav(b64: str) -> str:
    """Decode the base64 reference sample to a temp wav for the model."""
    raw = base64.b64decode(b64, validate=True)
    if len(raw) < 1000:
        raise ValueError("voice sample too small")
    fd, path = tempfile.mkstemp(suffix=".wav")
    with os.fdopen(fd, "wb") as fh:
        fh.write(raw)
    return path


def build_app(key, language: str):
    from fastapi import FastAPI, Header, HTTPException, Request
    from fastapi.responses import JSONResponse, Response

    app = FastAPI()

    @app.get("/health")
    def health():
        return {
            "ok": True,
            "model": _state["kind"],
            "device": _state["device"],
            "warm": _state["model"] is not None,
            "busy": _state["busy"],
        }

    @app.post("/tts")
    async def tts(request: Request, x_voice_key: str = Header(default="")):
        if key and x_voice_key != key:
            raise HTTPException(status_code=401, detail="bad X-Voice-Key")
        if _state["model"] is None:
            raise HTTPException(status_code=503, detail="model still loading, retry shortly")

        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="expected JSON body")

        text = str(body.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="text is required")
        if len(text) > MAX_TEXT_CHARS:
            raise HTTPException(status_code=400, detail=f"text over {MAX_TEXT_CHARS} chars — split it")

        try:
            speed = float(body.get("speed") or 1.0)
        except (TypeError, ValueError):
            speed = 1.0
        speed = min(2.0, max(0.5, speed))

        voice_b64 = str(body.get("voice") or "").strip()
        prompt_path = None
        try:
            if voice_b64:
                if len(voice_b64) > MAX_VOICE_B64:
                    raise HTTPException(status_code=400, detail="voice sample too large")
                try:
                    prompt_path = write_prompt_wav(voice_b64)
                except (binascii.Error, ValueError):
                    raise HTTPException(status_code=400, detail="voice is not valid base64 wav")
            try:
                _state["busy"] = True
                audio = await asyncio.to_thread(
                    synthesize_locked, text, prompt_path, language, speed
                )
            except HTTPException:
                raise
            except Exception as exc:  # model-level failure
                log(f"synthesis error: {exc}")
                raise HTTPException(status_code=500, detail=f"synthesis failed: {exc}")
            return Response(content=wav_bytes(audio), media_type="audio/wav")
        finally:
            _state["busy"] = False
            if prompt_path:
                try:
                    os.unlink(prompt_path)
                except OSError:
                    pass

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception):
        log(f"unhandled error: {exc}")
        return JSONResponse(status_code=500, content={"detail": "internal error"})

    return app


def pick_device(flag: str) -> str:
    if flag != "auto":
        return flag
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def main() -> None:
    parser = argparse.ArgumentParser(description="TubeForge self-hosted voice server")
    parser.add_argument("--port", type=int, default=int(os.environ.get("VOICE_PORT", "8931")))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--key", default=os.environ.get("VOICE_KEY", ""), help="shared secret (X-Voice-Key)")
    parser.add_argument("--device", default="auto", help="auto | cpu | cuda")
    parser.add_argument("--model", default=os.environ.get("VOICE_MODEL", MODEL_EN),
                        choices=[MODEL_EN, MODEL_MULTI],
                        help="chatterbox (English) or chatterbox-multilingual (23 languages)")
    parser.add_argument("--lang", default="en", help="language_id for --model chatterbox-multilingual")
    parser.add_argument("--no-warmup", action="store_true", help="skip the boot warm-up sentence")
    args = parser.parse_args()

    try:
        import uvicorn  # noqa: F401
        import torch  # noqa: F401
        import torchaudio  # noqa: F401
        import fastapi  # noqa: F401
    except ImportError as exc:
        log(f"missing dependency: {exc.__class__.__name__}: {exc}")
        log("install first:  pip install chatterbox-tts fastapi \"uvicorn[standard]\" torchaudio")
        sys.exit(1)

    _state["kind"] = args.model
    _state["device"] = pick_device(args.device)
    log(f"device: {_state['device']} (use --device cpu to force CPU)")

    app = build_app(args.key.strip() or None, args.lang)

    def warm() -> None:
        try:
            _state["model"] = load_model(args.model, _state["device"])
            if not args.no_warmup:
                log("warm-up sentence (primes caches; first real request will be fast) ...")
                synthesize("Hello. This voice server is ready.", None, args.lang)
        except Exception as exc:
            log(f"MODEL LOAD FAILED: {exc}")
            log("check your internet (first run downloads ~1-2 GB) and disk space, then retry")

    threading.Thread(target=warm, daemon=True).start()

    import uvicorn

    log(f"listening on http://{args.host}:{args.port}")
    log("expose it:  cloudflared tunnel --url http://localhost:%d" % args.port)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
