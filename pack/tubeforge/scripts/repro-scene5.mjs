#!/usr/bin/env node
// Reproduce the app's multiShotFilter for scene 5 (dur=13.643, camera=zoom-in,
// rehook=false) and verify hard cuts land. Mirrors src/lib/tubeforge/render.ts.
import { execFileSync } from "child_process";
import fs from "fs";

const FPS = 30;
const dur = 13.643;
const img = "uploads/cmvqvgzau003er9v2xj7cdn8x/scene-05.png";
const out = "/tmp/repro-scene5.mp4";

const totalFrames = Math.max(Math.round(dur * FPS), 2);
const shotCount = Math.max(1, Math.min(12, Math.round(dur / 2.7)));
const rotation = ["zoom-in", "pan-right", "zoom-out", "tilt-down", "push-in", "pan-left", "zoom-out", "tilt-up"];
const shots = [{ id: "zoom-in", zStart: 1.0 }];
let i = 0;
while (shots.length < shotCount) {
  const next = rotation[i++ % rotation.length];
  if (next === shots[shots.length - 1].id) continue;
  const endZoom = { "zoom-in": 1.12, "zoom-out": 1.0, "push-in": 1.19, "punch": 1.11 }[shots[shots.length - 1].id] ?? shots[shots.length - 1].zStart;
  shots.push({ id: next, zStart: endZoom > 1.07 ? 1.04 : 1.14 });
}
console.log("shotCount:", shotCount, "variants:", shots.map((s) => `${s.id}@${s.zStart}`).join(", "));

const centeredX = "iw/2-(iw/zoom)/2";
const centeredY = "ih/2-(ih/zoom)/2";
const panX = (fwd) => fwd ? "(iw-iw/zoom)*(0.15+0.7*on/80)" : "(iw-iw/zoom)*(0.85-0.7*on/80)";
const panY = (fwd) => fwd ? "(ih-ih/zoom)*(0.15+0.7*on/80)" : "(ih-ih/zoom)*(0.85-0.7*on/80)";
const kb = (v, frames) => {
  const last = Math.max(frames - 1, 1);
  switch (v.id) {
    case "zoom-out": return `z='1.12-0.12*on/${last}':x='${centeredX}':y='${centeredY}'`;
    case "pan-right": return `z='${v.zStart.toFixed(2)}':x='${panX(true)}':y='${centeredY}'`;
    case "tilt-down": return `z='${v.zStart.toFixed(2)}':x='${centeredX}':y='${panY(true)}'`;
    case "push-in": return `z='1.02+0.17*on/${last}':x='${centeredX}':y='${centeredY}'`;
    default: return `z='1+0.12*on/${last}':x='${centeredX}':y='${centeredY}'`;
  }
};

const per = Math.max(Math.floor(totalFrames / shotCount), 2);
const bounds = [];
for (let b = 1; b < shotCount; b++) bounds.push(Math.min(per * b, totalFrames - 1));
const parts = [
  `[0:v]scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,split=${shotCount}${shots.map((_, k) => `[s${k}]`).join("")}`,
];
let start = 0;
shots.forEach((v, k) => {
  const end = k < shots.length - 1 ? bounds[k] : totalFrames;
  const frames = Math.max(end - start, 2);
  parts.push(`[s${k}]trim=start_frame=${start}:end_frame=${end},setpts=PTS-STARTPTS,zoompan=${kb(v, frames)}:d=1:s=1920x1080:fps=${FPS},format=yuv420p[v${k}]`);
  start = end;
});
parts.push(`${shots.map((_, k) => `[v${k}]`).join("")}concat=n=${shotCount}:v=1:a=0[vc]`, `[vc]eq=contrast=1.05:saturation=1.08,vignette=PI/5[v]`);
const filter = parts.join(";");
fs.writeFileSync("/tmp/repro-filter.txt", filter);
console.log("filter bytes:", filter.length);

execFileSync("ffmpeg", [
  "-loop", "1", "-framerate", String(FPS), "-t", dur.toFixed(3), "-i", img,
  "-filter_complex", filter,
  "-map", "[v]", "-t", dur.toFixed(3), "-r", String(FPS),
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
  "-y", out,
], { stdio: ["ignore", "ignore", "pipe"], timeout: 110_000 });
console.log("rendered:", out, fs.statSync(out).size, "bytes");
