#!/usr/bin/env bash
# Reproduce the zoompan strobe from render.ts multiShotFilter using the REAL
# scene-01.png. Renders several candidate chains, then scene-detects each.
set -u
IMG=/home/z/my-project/uploads/cmvqvgzau003er9v2xj7cdn8x/scene-01.png
OUT=/home/z/my-project/forensics/final
mkdir -p "$OUT"

# Scene 1 in the video: dur=15.1s, 453 frames, 6 shots, per=75 frames,
# variants: punch(0-75) zoom-in(75-150) pan-right(150-225) zoom-out(225-300)
# tilt-down(300-375) push-in(375-453)

FPS=30

echo "=== A: full 6-shot chain (exact render.ts reproduction) ==="
ffmpeg -y -v error -loop 1 -framerate $FPS -t 15.1 -i "$IMG" -filter_complex "\
[0:v]scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,split=6[s0][s1][s2][s3][s4][s5];\
[s0]trim=start_frame=0:end_frame=75,setpts=PTS-STARTPTS,zoompan=z='if(lte(on\,14)\,1.16-0.10*on/14\,1.06+0.05*(on-14)/61)':d=1:s=1920x1080:fps=30,format=yuv420p[v0];\
[s1]trim=start_frame=75:end_frame=150,setpts=PTS-STARTPTS,zoompan=z='1+0.12*on/74':x='iw/2-(iw/zoom)/2':y='ih/2-(ih/zoom)/2':d=1:s=1920x1080:fps=30,format=yuv420p[v1];\
[s2]trim=start_frame=150:end_frame=225,setpts=PTS-STARTPTS,zoompan=z='1.04':x='(iw-iw/zoom)*(0.15+0.7*on/74)':y='ih/2-(ih/zoom)/2':d=1:s=1920x1080:fps=30,format=yuv420p[v2];\
[s3]trim=start_frame=225:end_frame=300,setpts=PTS-STARTPTS,zoompan=z='1.12-0.12*on/74':x='iw/2-(iw/zoom)/2':y='ih/2-(ih/zoom)/2':d=1:s=1920x1080:fps=30,format=yuv420p[v3];\
[s4]trim=start_frame=300:end_frame=375,setpts=PTS-STARTPTS,zoompan=z='1.14':x='iw/2-(iw/zoom)/2':y='(ih-ih/zoom)*(0.15+0.7*on/74)':d=1:s=1920x1080:fps=30,format=yuv420p[v4];\
[s5]trim=start_frame=375:end_frame=453,setpts=PTS-STARTPTS,zoompan=z='1.02+0.17*on/77':x='iw/2-(iw/zoom)/2':y='ih/2-(ih/zoom)/2':d=1:s=1920x1080:fps=30,format=yuv420p[v5];\
[v0][v1][v2][v3][v4][v5]concat=n=6:v=1:a=0[vc];\
[vc]eq=contrast=1.05:saturation=1.08,vignette=PI/5[v]" \
-map "[v]" -t 15.1 -r 30 -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p "$OUT/A-full.mp4"

echo "=== B: single zoom-in, NO trim/split (sanity: smooth expected) ==="
ffmpeg -y -v error -loop 1 -framerate $FPS -t 5 -i "$IMG" -filter_complex "\
[0:v]scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,zoompan=z='1+0.12*on/149':x='iw/2-(iw/zoom)/2':y='ih/2-(ih/zoom)/2':d=1:s=1920x1080:fps=30,format=yuv420p[v]" \
-map "[v]" -t 5 -r 30 -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p "$OUT/B-single.mp4"

echo "=== C: trimmed+setpts zoom-in alone (shot 2 in isolation) ==="
ffmpeg -y -v error -loop 1 -framerate $FPS -t 15.1 -i "$IMG" -filter_complex "\
[0:v]scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,trim=start_frame=75:end_frame=150,setpts=PTS-STARTPTS,zoompan=z='1+0.12*on/74':x='iw/2-(iw/zoom)/2':y='ih/2-(ih/zoom)/2':d=1:s=1920x1080:fps=30,format=yuv420p[v]" \
-map "[v]" -t 2.5 -r 30 -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p "$OUT/C-trimzoom.mp4"

for f in A-full B-single C-trimzoom; do
  echo "--- scene changes $f ---"
  ffmpeg -v info -i "$OUT/$f.mp4" -vf "select='gt(scene,0.02)',showinfo" -f null - 2>&1 \
    | grep -o "pts_time:[0-9.]*" | awk -F: '{printf "%.2f ", $2}' | head -c 600
  echo ""
done
