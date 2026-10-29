# ── TubeForge Voice Server — Hugging Face Space (free CPU) ─────────────
# Copy THIS folder's files (README.md, Dockerfile, voice_server.py) into a
# new HF Space repo and it just runs. See README.md for the 5-minute guide.

FROM python:3.11-slim

# ffmpeg lets torchaudio decode mp3/m4a reference samples if one ever arrives
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# HF Spaces run containers as UID 1000
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

WORKDIR /app
COPY --chown=user voice_server.py .

# Pre-install CPU-only torch FIRST: chatterbox-tts pins torch==2.6.0, and pip
# keeps the already-satisfied pin instead of pulling the ~5 GB bigger CUDA
# wheels from PyPI. Result: a lean CPU-only image on a CPU-only runner.
RUN pip install --no-cache-dir torch==2.6.0 torchaudio==2.6.0 \
      --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir chatterbox-tts fastapi "uvicorn[standard]"

# First start downloads the Chatterbox weights (~1-2 GB) into the container's
# home cache, then serves. Port 7860 is what HF routes `app_port` to.
ENV VOICE_PORT=7860
EXPOSE 7860

CMD ["python", "voice_server.py", "--host", "0.0.0.0"]
