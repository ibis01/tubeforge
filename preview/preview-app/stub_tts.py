"""
Stub TTS engine for preview / dev mode.

Mirrors the real app.xtts_engine.get_tts() interface, but instead of loading
the 1.8 GB XTTS-v2 model it generates a short silence/sine-wave WAV file using
only stdlib + numpy. Lets us run the full API end-to-end in the sandbox
without downloading the model.

Set env var TUBEFORGE_PREVIEW=1 to activate this stub.
"""

from __future__ import annotations

import logging
import os
import struct
import threading
import time
import wave
from pathlib import Path
from typing import Optional

log = logging.getLogger("tubeforge.stub_tts")

_lock = threading.Lock()


class StubTTS:
    """Mimics the Coqui TTS API surface we actually use."""

    def __init__(self):
        log.info("StubTTS initialized (no real model — preview mode)")

    def tts_to_file(
        self,
        text: str,
        speaker_wav: str,
        language: str = "en",
        speed: float = 1.0,
        file_path: str = None,
    ) -> str:
        # Simulate CPU inference latency: ~0.5s per 100 chars (faster than real
        # XTTS but enough to make the async job pattern visible)
        estimated_seconds = max(1.0, len(text) / 200.0)
        log.info(
            "stub synthesis: %d chars, lang=%s, ref=%s, est=%.2fs",
            len(text), language, Path(speaker_wav).name, estimated_seconds,
        )
        time.sleep(min(estimated_seconds, 5.0))  # cap for preview sanity

        # Generate a short WAV: 1 second of 440Hz tone per ~250 chars
        duration = max(0.5, min(len(text) / 250.0, 8.0))
        _write_sine_wav(file_path, duration=duration, freq=440.0, speed=speed)
        return file_path


def _write_sine_wav(path: str, duration: float = 1.0, freq: float = 440.0, speed: float = 1.0):
    """Pure-stdlib WAV writer with a sine tone. ~16-bit PCM, 16kHz mono."""
    rate = 16000
    n_samples = int(rate * duration)
    # numpy-free sine generation via stdlib math
    import math
    samples = []
    amplitude = 20000  # 16-bit range max ~32767
    for i in range(n_samples):
        # Tiny frequency wobble to make it sound voice-y in speakers
        f = freq * (1.0 + 0.02 * math.sin(2 * math.pi * i / rate * 5))
        s = int(amplitude * math.sin(2 * math.pi * f * i / rate))
        samples.append(s)

    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # 16-bit
        w.setframerate(rate)
        # Pack samples as little-endian 16-bit
        w.writeframes(struct.pack(f"<{len(samples)}h", *samples))


_tts: Optional[StubTTS] = None


def get_tts(peek: bool = False):
    global _tts
    if peek:
        return _tts
    if _tts is None:
        with _lock:
            if _tts is None:
                _tts = StubTTS()
    return _tts
