#!/usr/bin/env python3
"""S3 render-honors sanity probe — chroma key + PIP overlay graph syntax.

Builds the exact filter strings studio-doc.ts emits (same grammar), runs
them against synthetic inputs, and checks the outputs decode + the keyed
pixels actually turned into the background color.

Not a unit test of the TS code — an ffmpeg contract check. Run after any
change to chromaFilterChain / pipOverlayFilter.
"""
import subprocess, sys, tempfile, os

def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("FAIL:", " ".join(cmd)[:160])
        print(r.stderr[-600:])
        sys.exit(1)
    return r

tmp = tempfile.mkdtemp(prefix="s3-filters-")
# 1) A green-background art still with a red square in the middle.
art = os.path.join(tmp, "art.png")
run(["ffmpeg", "-y", "-f", "lavfi", "-i",
     "color=c=0x00FF00:s=640x360:d=1,drawbox=x=260:y=140:w=120:h=80:color=red@1:t=fill",
     "-frames:v", "1", art])
# 2) A fake logo (white square on transparent).
logo = os.path.join(tmp, "logo.png")
run(["ffmpeg", "-y", "-f", "lavfi", "-i",
     "color=c=white@0.9:s=96x48,format=rgba",
     "-frames:v", "1", logo])
wav = os.path.join(tmp, "narr.wav")
run(["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "2", wav])

# The S3 chain exactly as studio-doc emits it (scene graph → chroma → pip):
# base graph [v] (hold + classic grade), then:
chroma_chain = (
    "[v]chromakey=0x00FF00:0.120:0.020[vck];"
    "color=c=0x000000:s=640x360:r=30:d=2.500[vcbg];"
    "[vcbg][vck]overlay=0:0:shortest=1,eq=contrast=1.050:saturation=1.080[vc]"
)
pip_chain = (
    "[2:v]scale=115:-2,format=rgba,colorchannelmixer=aa=0.85,drawbox=color=white@0.9:t=1[vpi];"
    "[vc][vpi]overlay=x='main_w-overlay_w-19':y='main_h-overlay_h-19':format=auto[vp]"
)
base = "[0:v]scale=640:360,format=yuv420p[v]"
out = os.path.join(tmp, "seg.mp4")
run(["ffmpeg", "-y",
     "-loop", "1", "-framerate", "30", "-t", "2", "-i", art,
     "-i", wav,
     "-loop", "1", "-framerate", "30", "-t", "2.5", "-i", logo,
     "-filter_complex", f"{base};{chroma_chain};{pip_chain}",
     "-map", "[vp]", "-map", "1:a",
     "-t", "2.000", "-r", "30",
     "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
     "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
     out])

# 3) Verify: decode a frame at the corner (was green → must now be black bg),
#    and the center (red square survives).
probe_center = os.path.join(tmp, "center.png")
run(["ffmpeg", "-y", "-ss", "1", "-i", out, "-frames:v", "1", probe_center])
# crop 8x8 at (10,10) — a keyed region → mean luma should be ~0 (black bg)
r = run(["ffmpeg", "-i", probe_center, "-vf", "crop=8:8:10:10,format=gray", "-f", "rawvideo", "-"])
corner = sum(r.stdout.encode("latin1", "ignore")[:64]) if False else None
import array
# stdout binary via pipe: re-run capturing bytes
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", probe_center, "-vf",
                      "crop=8:8:10:10,format=gray", "-f", "rawvideo", "-"],
                     capture_output=True).stdout
mean_corner = sum(raw) / max(len(raw), 1)
raw_c = subprocess.run(["ffmpeg", "-v", "error", "-i", probe_center, "-vf",
                        "crop=8:8:310:175,format=gray", "-f", "rawvideo", "-"],
                       capture_output=True).stdout
mean_center = sum(raw_c) / max(len(raw_c), 1)
# logo corner: bottom-right 12px in — white-ish (luma > 100)
raw_l = subprocess.run(["ffmpeg", "-v", "error", "-i", probe_center, "-vf",
                        "crop=8:8:563:310,format=gray", "-f", "rawvideo", "-"],
                       capture_output=True).stdout
mean_logo = sum(raw_l) / max(len(raw_l), 1)

print(f"keyed corner mean luma: {mean_corner:.1f} (expect < 20 — background shows through)")
print(f"center square mean luma: {mean_center:.1f} (expect > 40 — red square survives; red's gray luma ≈ 76)")
print(f"logo region mean luma: {mean_logo:.1f} (expect > 100 — logo overlay present)")
ok = mean_corner < 20 and mean_center > 40 and mean_logo > 100
print("S3 FILTER GRAPH:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
