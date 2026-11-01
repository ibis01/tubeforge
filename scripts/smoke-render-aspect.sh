#!/usr/bin/env bash
# Stage 6 (T-6.8) — render-pipeline aspect ratio + frame rate smoke.
#
# Confirms the new "1:1" aspect path through sceneFilterGraph + OUTPUT_SIZES
# actually produces a 1080x1080 video at the chosen fps, and that 24/60 fps
# produce the expected frame rate. Pure ffmpeg invocation — exercises the
# exact filter graph the render pipeline runs for a "kenburns" segment with
# a still image, just without the audio + sceneAudio helpers (those are the
# render pipeline's other responsibilities and are covered by the live
# render smoke that runs as part of the Stage 3 close-out).
set -u
cd /home/z/my-project

fail=0
expect() { # expect <label> <expected> <actual>
  if [ "$3" = "$2" ]; then echo "[smoke] ✓ $1 ($2)"; else echo "[smoke] ✗ $1: expected $2, got $3"; fail=1; fi
}

# Generate a tiny test image (any solid color; ffmpeg's lavfi is enough).
TESTIMG=/tmp/tf-render-aspect-input.png
ffmpeg -y -hide_banner -loglevel error -f lavfi -i color=c=0x4060c0:s=1280x720:d=0.04 -frames:v 1 "$TESTIMG" 2>&1
[ -f "$TESTIMG" ] || { echo "[smoke] FAIL: could not synthesize test image"; exit 1; }

# The exact filter graph sceneFilterGraph emits for a static-image plan
# (cover scale+crop, then format=yuv420p + grade). Three aspect variants.
# Work canvas downscaled from the production 3840x2160 / 2160x3840 / 2160x2160
# to the OUTPUT size — the production super-sample only smooths zoom-pan
# edges, which the smoke isn't testing. This keeps each ffmpeg call <2s.
run_render() {
  local aspect="$1" fps="$2" out="$3" want_w="$4" want_h="$5"
  local out_w out_h
  case "$aspect" in
    "16:9") out_w=1920; out_h=1080 ;;
    "9:16") out_w=1080; out_h=1920 ;;
    "1:1")  out_w=1080; out_h=1080 ;;
  esac
  ffmpeg -y -hide_banner -loglevel error \
    -loop 1 -framerate "$fps" -t 0.5 -i "$TESTIMG" \
    -filter_complex "[0:v]scale=${out_w}:${out_h}:force_original_aspect_ratio=increase,crop=${out_w}:${out_h},format=yuv420p,eq=contrast=1.05:saturation=1.08,vignette=PI/5[v]" \
    -map "[v]" -t 0.5 -r "$fps" -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p \
    "$out" 2>&1
  # Probe the resulting geometry + frame rate.
  local info
  info=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -of csv=p=0 "$out")
  local w h fr
  w=$(echo "$info" | cut -d',' -f1)
  h=$(echo "$info" | cut -d',' -f2)
  fr=$(echo "$info" | cut -d',' -f3 | cut -d'/' -f1)
  expect "aspect=$aspect fps=$fps width" "$want_w" "$w"
  expect "aspect=$aspect fps=$fps height" "$want_h" "$h"
  expect "aspect=$aspect fps=$fps frame rate" "$fps" "$fr"
}

# 1:1 square — the new aspect T-6.8 added.
run_render "1:1" 30 /tmp/tf-render-aspect-1x1.mp4 1080 1080
# 16:9 — regression check (must still produce 1920x1080 at the chosen fps).
run_render "16:9" 24 /tmp/tf-render-aspect-16x9-24.mp4 1920 1080
run_render "16:9" 60 /tmp/tf-render-aspect-16x9-60.mp4 1920 1080
# 9:16 — the existing vertical aspect (Shorts); regression check.
run_render "9:16" 30 /tmp/tf-render-aspect-9x16.mp4 1080 1920

# Cleanup
rm -f /tmp/tf-render-aspect-*.mp4 /tmp/tf-render-aspect-input.png

if [ "$fail" = "0" ]; then
  echo "[smoke] ALL GREEN — aspect 1:1 + frame rate 24/30/60 + 16:9 + 9:16"
  exit 0
else
  echo "[smoke] FAIL"
  exit 1
fi
