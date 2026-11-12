#!/usr/bin/env python3
"""Fix the a2eabd8 registry-sync miss: add priors rows for heygen (tts)
and magichour (video) to src/lib/tubeforge/provider-score.ts.

The S90 sync law (priorsComplete) requires every PROVIDERS_BY_CAPABILITY
entry to have a priors row. a2eabd8 added groq (already covered in
CHAT_PRIORS), heygen and magichour to the registry but only groq had a
priors row — CI run 43165376772 went red on exactly this pin.
Idempotent: skips if the rows already exist.
"""
import sys

PATH = "src/lib/tubeforge/provider-score.ts"

TTS_ANCHOR = "  zhipu: { quality: 0.88, latency: 0.75, fit: 0.95 }, // the cloning lane\n"
TTS_ROW = (
    "  heygen: { quality: 0.76, latency: 0.88, fit: 0.72 }, "
    "// free turbo lane; public voice ids, no clone-from-sample\n"
)

VIDEO_ANCHOR = "  fal: { quality: 0.84, latency: 0.78, fit: 0.8 },\n"
VIDEO_ROW = (
    "  magichour: { quality: 0.8, latency: 0.72, fit: 0.78 }, "
    "// kling-3.0/wan-2.2 aggregator; daily free credits\n"
)

src = open(PATH, encoding="utf-8").read()

if "heygen:" in src or "magichour:" in src:
    print("priors rows already present — nothing to do")
    sys.exit(0)

if TTS_ANCHOR not in src or VIDEO_ANCHOR not in src:
    print("ANCHOR NOT FOUND — aborting, file layout changed", file=sys.stderr)
    sys.exit(2)

src = src.replace(TTS_ANCHOR, TTS_ANCHOR + TTS_ROW, 1)
src = src.replace(VIDEO_ANCHOR, VIDEO_ANCHOR + VIDEO_ROW, 1)

open(PATH, "w", encoding="utf-8").write(src)
print("patched: added TTS_PRIORS.heygen and VIDEO_PRIORS.magichour")
