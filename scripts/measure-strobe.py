#!/usr/bin/env python3
"""Quantify frame-to-frame alternation in the strobe bisect clips."""
from PIL import Image
import numpy as np
import sys

import glob

def diffs(folder):
    files = sorted(glob.glob(f"{folder}/f*.png"))
    prev = None
    out = []
    for fp in files:
        img = np.asarray(Image.open(fp).convert("L"), dtype=np.float32)
        if prev is not None:
            out.append(float(np.mean(np.abs(img - prev))))
        prev = img
    return out

targets = [("A-full shot2 span", "fA"), ("C trim+setpts+zoom", "fC"), ("ORIGINAL 2.5-3.3s", "fORIG")]
for name, folder in targets:
    d = diffs(folder)
    arr = np.array(d)
    print(f"--- {name} ---")
    print(f"frames={len(d)} mean={arr.mean():.3f} min={arr.min():.3f} max={arr.max():.3f}")
    # Alternation test: even-indexed diffs vs odd-indexed diffs
    even = arr[0::2].mean()  # diffs f1->f2, f3->f4, ...
    odd = arr[1::2].mean()   # diffs f2->f3, f4->f5, ...
    print(f"even-position diffs mean={even:.3f}  odd-position diffs mean={odd:.3f}")
    print(f"alternation ratio (even/odd)={even/max(odd,1e-6):.2f}  (>1.5 means ping-pong)")
    print("first 24 diffs:", " ".join(f"{x:.2f}" for x in d[:24]))
