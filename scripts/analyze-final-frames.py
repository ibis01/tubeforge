#!/usr/bin/env python3
"""Forensics on extracted frames: cut timestamps, black frames, gap analysis.
Usage: python3 analyze-final-frames.py <frames_dir> <fps> <total_frames_expected>
"""
import glob
import os
import sys

import numpy as np

try:
    from PIL import Image
except ImportError:
    os.system("pip install pillow -q")
    from PIL import Image

frames_dir = sys.argv[1] if len(sys.argv) > 1 else "/tmp/frames"
fps = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0
duration = float(sys.argv[3]) if len(sys.argv) > 3 else 113.7

files = sorted(glob.glob(os.path.join(frames_dir, "f_*.png")))
if not files:
    print("no frames found")
    sys.exit(1)

imgs = []
for f in files:
    a = np.asarray(Image.open(f).convert("L"), dtype=np.float32)
    imgs.append(a)
stack = np.stack(imgs)

# luminance / black frame detection (160x90 luma, 0-255)
mean_luma = stack.mean(axis=(1, 2))
black_idx = np.where(mean_luma < 14.0)[0]
black_times = sorted({round(i / fps, 2) for i in black_idx})

# consecutive frame diff -> scene cuts
diffs = np.abs(stack[1:] - stack[:-1]).mean(axis=(1, 2))
cut_idx = np.where(diffs > 18.0)[0]  # hard-cut threshold on mean abs luma diff
cut_times = [round((i + 1) / fps, 2) for i in cut_idx]

print(f"frames analyzed: {len(files)} @ {fps}fps (covers {len(files)/fps:.1f}s of {duration:.1f}s)")
print(f"black frames (luma<14): {len(black_times)} at {black_times[:10]}")
print(f"hard cuts detected: {len(cut_times)}")
print(f"cut times: {cut_times}")

if len(cut_times) > 1:
    gaps = np.diff(cut_times)
    print(f"max gap between cuts: {gaps.max():.2f}s (target <=3.3s)")
    print(f"min gap: {gaps.min():.2f}s, mean gap: {gaps.mean():.2f}s")

# luma stats to prove no long static stretches: count slow segments
print(f"mean luma overall: {mean_luma.mean():.1f}")
