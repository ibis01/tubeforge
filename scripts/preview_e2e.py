"""End-to-end preview test — exercises every endpoint of the TubeForge voice-clone API."""

import json
import sys
import time
from pathlib import Path

import urllib.request
import urllib.error

BASE = "http://127.0.0.1:8765"
API_KEY = "preview-key-2026"


def req(method, path, headers=None, data=None, form=None, files=None):
    """Minimal multipart-aware http client (stdlib only)."""
    if form or files:
        boundary = "----preview-boundary-{}".format(int(time.time()))
        body = b""
        if form:
            for k, v in form.items():
                body += f"--{boundary}\r\n".encode()
                body += f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode()
                body += f"{v}\r\n".encode()
        if files:
            for field, file_tuple in files.items():
                if len(file_tuple) == 3:
                    fname, content, mime = file_tuple
                else:
                    fname, content = file_tuple
                    mime = "application/octet-stream"
                body += f"--{boundary}\r\n".encode()
                body += (
                    f'Content-Disposition: form-data; name="{field}"; '
                    f'filename="{fname}"\r\n'
                    f'Content-Type: {mime}\r\n\r\n'
                ).encode()
                body += content + b"\r\n"
        body += f"--{boundary}--\r\n".encode()
        req_headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
        if headers:
            req_headers.update(headers)
        return _send(method, path, req_headers, body)
    elif data:
        body = json.dumps(data).encode()
        req_headers = {"Content-Type": "application/json"}
        if headers:
            req_headers.update(headers)
        return _send(method, path, req_headers, body)
    else:
        return _send(method, path, headers, None)


def _send(method, path, headers, body):
    r = urllib.request.Request(BASE + path, method=method, headers=headers or {}, data=body)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")


def check(label, status, body, expect=None):
    """If `expect` is given, OK = (status == expect). Otherwise OK = status in (200,201,204)."""
    expected_set = {expect} if expect else {200, 201, 204}
    ok = "OK" if status in expected_set else "FAIL"
    suffix = f" (expected {expect})" if expect else ""
    print(f"[{ok}] {label}: HTTP {status}{suffix}")
    try:
        parsed = json.loads(body)
        print(f"       {json.dumps(parsed, indent=2)[:400]}")
        return parsed
    except json.JSONDecodeError:
        print(f"       {body[:200]}")
        return None


# --------------------------------------------------------------------------- #
print("=" * 60)
print("TubeForge Voice-Clone API — End-to-End Preview")
print("=" * 60)
auth = {"X-API-Key": API_KEY}

# 1. Health
print("\n--- 1. GET /health (no auth required)")
status, body = req("GET", "/health")
check("liveness probe", status, body)

# 2. List voices (empty initially)
print("\n--- 2. GET /voices (should be empty)")
status, body = req("GET", "/voices", headers=auth)
check("list voices", status, body)

# 3. Synthesize without any voice — should 404
print("\n--- 3. POST /synthesize (no voice registered yet — expect 404)")
status, body = req("POST", "/synthesize", data={"text": "test", "voice": "ghost"})
check("synthesize without voice (expect 404)", status, body, expect=404)

# 4. Synthesize without API key — should 401
print("\n--- 4. POST /synthesize (no API key — expect 401)")
status, body = req("POST", "/synthesize", data={"text": "test", "voice": "x"})
check("unauthorized request (expect 401)", status, body, expect=401)

# 5. Clone a voice — upload a tiny fake WAV file
print("\n--- 5. POST /clone (upload reference audio)")
# Create a minimal valid WAV file in memory
import wave
import io
import struct
import math
buf = io.BytesIO()
with wave.open(buf, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(16000)
    # 2 seconds of 440Hz sine
    samples = [int(20000 * math.sin(2 * math.pi * 440 * i / 16000)) for i in range(32000)]
    w.writeframes(struct.pack(f"<{len(samples)}h", *samples))
wav_bytes = buf.getvalue()
status, body = req("POST", "/clone", headers=auth, form={"name": "demo_voice"}, files={
    "file": ("reference.wav", wav_bytes, "audio/wav"),
})
check("clone voice", status, body)

# 6. List voices — should now have 1
print("\n--- 6. GET /voices (should have demo_voice)")
status, body = req("GET", "/voices", headers=auth)
check("list voices after clone", status, body)

# 7. Synthesize real text — should return job_id
print("\n--- 7. POST /synthesize (submit TTS job)")
status, body = req("POST", "/synthesize", headers=auth, data={
    "text": "Welcome to TubeForge. Today we are looking at five surprising facts about the deep ocean.",
    "voice": "demo_voice",
    "language": "en",
    "speed": 1.0,
})
job_data = check("submit synthesis", status, body)
job_id = job_data["job_id"] if job_data else None
if not job_id:
    print("\n!! job_id missing, stopping !!")
    sys.exit(1)

# 8. Poll the job — usually queued or processing immediately after
print("\n--- 8. GET /jobs/{id} (poll status)")
for i in range(15):
    status, body = req("GET", f"/jobs/{job_id}", headers=auth)
    job = check(f"poll #{i + 1}", status, body)
    if job and job.get("status") in ("completed", "failed"):
        break
    time.sleep(0.5)

# 9. List all jobs
print("\n--- 9. GET /jobs (list all)")
status, body = req("GET", "/jobs", headers=auth)
check("list jobs", status, body)

# 10. Download the output WAV
print("\n--- 10. GET /outputs/{file}.wav (download result)")
status, raw = _send("GET", f"/outputs/{job_id}.wav", auth, None)
print(f"[{'OK' if status == 200 else 'FAIL'}] download output: HTTP {status}")
if status == 200:
    out_path = Path(f"/home/z/my-project/preview/data/outputs/{job_id}.wav")
    actual_size = out_path.stat().st_size if out_path.exists() else 0
    print(f"       bytes received: {len(raw)}, file on disk: {actual_size}")

# 11. Delete the voice
print("\n--- 11. DELETE /voices/demo_voice")
status, body = req("DELETE", "/voices/demo_voice", headers=auth)
check("delete voice", status, body)

# 12. Confirm voice is gone
print("\n--- 12. GET /voices (should be empty again)")
status, body = req("GET", "/voices", headers=auth)
check("list voices after delete", status, body)

print("\n" + "=" * 60)
print("Preview complete. Server still running at http://localhost:8765")
print("=" * 60)
