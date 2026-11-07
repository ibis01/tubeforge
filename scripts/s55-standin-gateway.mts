// S55 T-55.5 — the local stand-in gateway (LOCAL ONLY, zero gateway spend).
//
// The acceptance needs the FULL funnel on real code: director pass →
// storyboard paints → i2v clip → dense L4 scan → QC gate. The real Z.ai
// gateway is metered quota (probe-hygiene law: probes never spend it), so
// this module speaks the SDK's exact wire format on localhost:
//
//   POST /v1/chat/completions          → the director pass (canned plan)
//   POST /v1/chat/completions/vision   → VLM: the restricted scan
//                                        (mode-controlled verdict) and the
//                                        artwork quality gate (score 9)
//   POST /v1/images/generations        → scene paints (per-prompt PNGs)
//   POST /v1/images/generations/edit   → instruction AI-edits
//   POST /v1/video/generation          → i2v submit (task id)
//   GET  /v1/async-result?id=…         → i2v poll (SUCCESS + clip URL)
//   GET  /clips/scene3.mp4             → the i2v clip bytes
//
// The `baseUrl` is `http://127.0.0.1:<port>/v1` — written to a TEMP
// .z-ai-config by the probe (the SDK reads cwd), restored after. Provider
// "zai" is UNGATED by the spend law (isPaidProvider("zai") === false), so
// TUBEFORGE_SPEND_GATE stays untouched and no paid dispatch ever runs.
//
// Every prompt the gateway receives is RECORDED (state.*) so the probe can
// assert the L2/L3 sanitization actually ran on the wire — the adversarial
// references must never leave the building.

import http from "node:http";
import type { AddressInfo } from "node:net";

export type VlmMode = "clean" | "violation" | "garbage";

export type VisionKind = "scan" | "text" | "quality";

export interface StandinAssets {
  /** Scene-1 paint: the cave gradient PNG. */
  cave: Buffer;
  /** Scene-2 paint: the dawn road gradient PNG. */
  road: Buffer;
  /** Scene-3 paint: the anonymous traveler (a real face) PNG. */
  traveler: Buffer;
  /** The edit-variant paint (any distinct PNG). */
  edited: Buffer;
  /** The i2v clip: 1920x1080 mp4 with the traveler's face in motion. */
  clip: Buffer;
  /** The canned director-plan JSON string (adversarial: names restricted figures). */
  planJson: string;
}

export interface StandinState {
  chatCalls: number;
  /** Every image-generation prompt received (scene paints + extra shots). */
  imagePrompts: string[];
  /** Every image-EDIT prompt received (instruction AI-edits). */
  editPrompts: string[];
  /** Every i2v motion prompt received. */
  videoPrompts: string[];
  /** Vision calls classified by consumer + the scan mode in force. */
  visionCalls: { kind: VisionKind; mode: VlmMode }[];
  clipDownloads: number;
}

export interface StandinGateway {
  port: number;
  baseUrl: string;
  state: StandinState;
  setVlmMode(mode: VlmMode): void;
  close(): Promise<void>;
}

interface ChatBody {
  messages?: { role?: string; content?: unknown }[];
}

function systemText(body: ChatBody): string {
  const sys = body.messages?.find((m) => m.role === "system");
  if (typeof sys?.content === "string") return sys.content;
  return "";
}

function chatResponse(content: string): object {
  return { choices: [{ message: { content } }] };
}

const scanVerdict = (mode: VlmMode): string => {
  if (mode === "violation")
    return JSON.stringify({
      depicted: true,
      frames: [3, 4],
      note: "a haloed, venerated central figure stands in for a named prophet",
    });
  if (mode === "garbage") return "I cannot answer that question.";
  return JSON.stringify({
    depicted: false,
    frames: [],
    note: "no revered figure depicted; anonymous travelers and landscape only",
  });
};

export async function startStandinGateway(assets: StandinAssets): Promise<StandinGateway> {
  const state: StandinState = {
    chatCalls: 0,
    imagePrompts: [],
    editPrompts: [],
    videoPrompts: [],
    visionCalls: [],
    clipDownloads: 0,
  };
  let vlmMode: VlmMode = "clean";

  let unmatchedCount = 0;
  /** Pick the paint for an image request. The traveler rides prompts that
   * name the anonymous caravan (scene 3's visual is kept VERBATIM by the
   * sanitizer — no restricted refs — so "caravan" reliably identifies it);
   * every other request cycles DISTINCT gradients so the storyboard dedupe
   * (dHash) never sees near-duplicate siblings. */
  const paintFor = (prompt: string): Buffer => {
    if (/caravan|traveler|dune|camel|dusk|oasis|harness/i.test(prompt)) return assets.traveler;
    const cycle = [assets.cave, assets.road, assets.edited];
    return cycle[unmatchedCount++ % cycle.length];
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", () => undefined);
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const url = req.url ?? "";
      const send = (code: number, body: unknown, type = "application/json") => {
        // Buffer BEFORE measuring: JSON with multi-byte UTF-8 (em dashes in
        // the canned plan) must report Content-Length in BYTES, not UTF-16
        // code units — a short header truncates the body and the SDK's
        // JSON.parse fails at the cut.
        const payload = Buffer.from(
          body instanceof Buffer ? body : JSON.stringify(body),
          "utf8"
        );
        res.writeHead(code, {
          "Content-Type": type,
          "Content-Length": String(payload.length),
        });
        res.end(payload);
      };
      try {
        // ---- i2v clip download (binary) ----
        if (req.method === "GET" && url.startsWith("/clips/")) {
          state.clipDownloads++;
          return send(200, assets.clip, "video/mp4");
        }
        // ---- i2v poll ----
        if (req.method === "GET" && url.startsWith("/v1/async-result")) {
          return send(200, {
            task_status: "SUCCESS",
            video_result: [{ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/clips/scene3.mp4` }],
          });
        }
        const body: ChatBody = rawBody ? (JSON.parse(rawBody) as ChatBody) : {};

        // ---- director chat ----
        if (req.method === "POST" && url === "/v1/chat/completions") {
          state.chatCalls++;
          return send(200, chatResponse(assets.planJson));
        }
        // ---- vision: restricted scan / text scan / quality gate ----
        if (req.method === "POST" && url === "/v1/chat/completions/vision") {
          const sys = systemText(body);
          if (/visual-content compliance checker/.test(sys)) {
            state.visionCalls.push({ kind: "scan", mode: vlmMode });
            return send(200, chatResponse(scanVerdict(vlmMode)));
          }
          if (/hunting for unintended text artifacts/.test(sys)) {
            // The S53 text-artifact lens (blocking check): clean verdict —
            // the seeded paints carry no lettering.
            state.visionCalls.push({ kind: "text", mode: vlmMode });
            return send(
              200,
              chatResponse(
                JSON.stringify({ artifacts: false, frames: [], notes: "no artifact text" })
              )
            );
          }
          state.visionCalls.push({ kind: "quality", mode: vlmMode });
          return send(
            200,
            chatResponse(
              JSON.stringify({ score: 9, issues: [], summary: "on-subject, artifact-free" })
            )
          );
        }
        // ---- image edit (instruction AI-edits) ----
        if (req.method === "POST" && url === "/v1/images/generations/edit") {
          const prompt = String((body as { prompt?: unknown }).prompt ?? "");
          state.editPrompts.push(prompt);
          return send(200, { data: [{ base64: assets.edited.toString("base64") }] });
        }
        // ---- image generation (scene paints + extra shots) ----
        if (req.method === "POST" && url === "/v1/images/generations") {
          const prompt = String((body as { prompt?: unknown }).prompt ?? "");
          state.imagePrompts.push(prompt);
          const png = paintFor(prompt);
          return send(200, { data: [{ base64: png.toString("base64") }] });
        }
        // ---- i2v submit ----
        if (req.method === "POST" && url === "/v1/video/generation") {
          const prompt = String((body as { prompt?: unknown }).prompt ?? "");
          state.videoPrompts.push(prompt);
          return send(200, { id: "s55-standin-task-1" });
        }
        return send(404, { error: `stand-in: no route ${req.method} ${url}` });
      } catch (err) {
        return send(500, { error: `stand-in: ${String(err).slice(0, 200)}` });
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    state,
    setVlmMode: (mode: VlmMode) => {
      vlmMode = mode;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}
