"""Regression test for the /tts 422 bug in voice_server.py.

FastAPI must bind the `request` parameter as the Request object. If the
annotation can't be resolved (the `from __future__ import annotations` bug),
FastAPI treats it as a required query param and POST /tts returns 422.

Expected with the fix:
    no-key   -> 401 (bad X-Voice-Key)
    with-key -> 503 (model still loading — proves the handler body was reached)
Broken (before fix):
    both     -> 422 {"detail":[{"type":"missing","loc":["query","request"] ...
"""

import sys

sys.path.insert(0, "/home/z/my-project/voice-server")

import voice_server
from fastapi.testclient import TestClient

app = voice_server.build_app("ismail-01", "en")
client = TestClient(app)

r_health = client.get("/health")
print("health   :", r_health.status_code, r_health.text[:100])

r1 = client.post("/tts", json={"text": "hi"})
print("no-key   :", r1.status_code, r1.text[:120])

r2 = client.post("/tts", json={"text": "hi"}, headers={"X-Voice-Key": "ismail-01"})
print("with-key :", r2.status_code, r2.text[:120])

ok = r1.status_code == 401 and r2.status_code == 503
print("RESULT   :", "PASS — Request binding works" if ok else "FAIL — still broken")
sys.exit(0 if ok else 1)
