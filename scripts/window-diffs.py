#!/usr/bin/env python3
"""Print raw consecutive-frame diff series for a window to distinguish
hard cuts (spikes) from smooth zoom (low plateau)."""
import glob
import subprocess
import sys

import numpy as np
from PIL import Image

start = float(sys.argv[1]) if len(sys.argv) > 1 else 55.0
dur = float(sys.argv[2]) if len(sys.argv) > 2 else 15.0
video = sys.argv[3] if len(sys.argv) > 3 else "uploads/cmvqvgzau003er9v2xj7cdn8x/final.mp4"

subprocess.run(["rm", "-rf", "/tmp/win"])
subprocess.run(["mkdir", "-p", "/tmp/win"])
subprocess.run([
    "ffmpeg", "-threads", "4", "-ss", str(start), "-t", str(dur), "-i", video,
    "-an", "-vf", "fps=2,scale=320:180", "/tmp/win/f_%03d.png",
], capture_output=True, timeout=110)

files = sorted(glob.glob("/tmp/win/f_*.png"))
imgs = [np.asarray(Image.open(f).convert("L"), dtype=np.float32) for f in files]
stack = np.stack(imgs)
diffs = np.abs(stack[1:] - stack[:-1]).mean(axis=(1, 2))
for i, d in enumerate(diffs):
    t = start + (i + 1) / 2.0
    bar = "#" * int(min(d, 60))
    print(f"t={t:6.1f}  diff={d:6.2f}  {bar}")
print(f"\nframes: {len(files)}, max diff: {diffs.max():.2f}, median: {np.median(diffs):.2f}")
