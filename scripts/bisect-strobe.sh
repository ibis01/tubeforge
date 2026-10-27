#!/usr/bin/env bash
# Bisect the trim+setpts+zoompan strobe.
set -u
IMG=/home/z/my-project/uploads/cmvqvgzau003er9v2xj7cdn8x/scene-01.png
OUT=/home/z/my-project/forensics/final
FPS=30

# D: trim+setpts+zoompan with CONSTANT zoom — isolates plumbing from z expr
ffmpeg -y -v error -loop 1 -framerate $FPS -t 15.1 -i "$IMG" -filter_complex "\
[0:v]scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,trim=start_frame=75:end_frame=150,setpts=PTS-STARTPTS,zoompan=z='1.06':x='iw/2-(iw/zoom)/2':y='ih/2-(ih/zoom)/2':d=1:s=960x540:fps=30,format=yuv420p[v]" \
-map "[v]" -t 2.5 -r 30 -c:v libx264 -preset veryfast -crf 20 "$OUT/D-constzoom.mp4"

# H: same as C but zoom driven by `in` instead of `on`
ffmpeg -y -v error -loop 1 -framerate $FPS -t 15.1 -i "$IMG" -filter_complex "\
[0:v]scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,trim=start_frame=75:end_frame=150,setpts=PTS-STARTPTS,zoompan=z='1+0.12*in/74':x='iw/2-(iw/zoom)/2':y='ih/2-(ih/zoom)/2':d=1:s=960x540:fps=30,format=yuv420p[v]" \
-map "[v]" -t 2.5 -r 30 -c:v libx264 -preset veryfast -crf 20 "$OUT/H-inexpr.mp4"

# E: select instead of trim
ffmpeg -y -v error -loop 1 -framerate $FPS -t 15.1 -i "$IMG" -filter_complex "\
[0:v]scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,select='between(n\,75\,149)',setpts=PTS-STARTPTS,zoompan=z='1+0.12*on/74':x='iw/2-(iw/zoom)/2':y='ih/2-(ih/zoom)/2':d=1:s=960x540:fps=30,format=yuv420p[v]" \
-map "[v]" -t 2.5 -r 30 -c:v libx264 -preset veryfast -crf 20 "$OUT/E-select.mp4"

# G: NO trim at all, zoompan with z based on in, full 75 frames from frame 0 (control #2)
ffmpeg -y -v error -loop 1 -framerate $FPS -t 2.5 -i "$IMG" -filter_complex "\
[0:v]scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,zoompan=z='1+0.12*on/74':x='iw/2-(iw/zoom)/2':y='ih/2-(ih/zoom)/2':d=1:s=960x540:fps=30,format=yuv420p[v]" \
-map "[v]" -t 2.5 -r 30 -c:v libx264 -preset veryfast -crf 20 "$OUT/G-notrim.mp4"

echo done
