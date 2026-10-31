#!/usr/bin/env python3
"""Test the self-hosted clone endpoint with a reference sample.

Sends POST /tts {"text", "voice": <base64 wav>} through the Tailscale Funnel
and reports status / audio stats.
"""
import base64
import json
import sys
import urllib.request

BASE = "https://ibismuh-hp-elitebook-845-g8-notebook-pc.taila6859e.ts.net"
KEY = "ismail-01"

sample_path, text = sys.argv[1], sys.argv[2]

with open(sample_path, "rb") as f:
    b64 = base64.b64encode(f.read()).decode()

payload = json.dumps({"text": text, "voice": b64, "speed": 1.0}).encode()
req = urllib.request.Request(
    f"{BASE}/tts",
    data=payload,
    headers={"Content-Type": "application/json", "X-Voice-Key": KEY},
    method="POST",
)

try:
    with urllib.request.urlopen(req, timeout=300) as r:
        body = r.read()
        print(f"HTTP {r.status} · {len(body)} bytes · {r.headers.get('content-type')}")
        with open("/tmp/clone_test.wav", "wb") as out:
            out.write(body)
        print("saved /tmp/clone_test.wav")
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code}: {e.read().decode(errors='replace')[:300]}")
except Exception as e:
    print(f"FAILED: {e}")
