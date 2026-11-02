// Transcribe the turbo-cloned wav via z-ai ASR to verify intelligibility.
import fs from "fs";
const { default: ZAI } = await import("z-ai-web-dev-sdk");
const zai = await ZAI.create();
const b64 = fs.readFileSync("/tmp/e2e-preview.wav").toString("base64");
const res = await zai.audio.asr.create({ file_base64: b64, stream: false });
const text = typeof res === "string" ? res : JSON.stringify(res);
console.log("ASR:", text.slice(0, 400));
