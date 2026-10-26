// Speech-to-text adapter — follows the tts capability's provider (audio AI).
//
//   zai    → bundled SDK asr (file_base64)
//   openai → POST {baseUrl}/audio/transcriptions (whisper-1, multipart)
//
// Used by the optional "verify narration" feature. Input is always a WAV
// buffer (the caller pre-chunks to ≤25 s).

import { getZAI } from "../ai";
import { getCapability, type CapabilityConfig } from "./settings";
import { providerMeta } from "./registry";
import { joinUrl, providerFetchJson } from "./http";

export async function asrTranscribe(
  wavBuffer: Buffer,
  overrides?: Partial<CapabilityConfig>
): Promise<string> {
  const config = await getCapability("tts", overrides);

  if (config.provider === "openai") {
    return openaiAsr(wavBuffer, config);
  }
  return zaiAsr(wavBuffer);
}

async function zaiAsr(wavBuffer: Buffer): Promise<string> {
  const zai = await getZAI();
  const response = await zai.audio.asr.create({
    file_base64: wavBuffer.toString("base64"),
  });
  const text = (response.text ?? "").trim();
  if (!text) throw new Error("ASR returned an empty transcript");
  return text;
}

async function openaiAsr(wavBuffer: Buffer, config: CapabilityConfig): Promise<string> {
  const meta = providerMeta("tts", "openai")!;
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const key = config.apiKey?.trim();
  if (!key) throw new Error("OpenAI-compatible transcription needs an API key");

  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(wavBuffer)], { type: "audio/wav" }),
    "chunk.wav"
  );
  form.append("model", "whisper-1");
  form.append("response_format", "json");

  const data = await providerFetchJson<{ text?: string }>(
    "OpenAI-compatible ASR",
    joinUrl(baseUrl, "audio/transcriptions"),
    { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form }
  );
  const text = (data.text ?? "").trim();
  if (!text) throw new Error("ASR returned an empty transcript");
  return text;
}
