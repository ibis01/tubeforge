// Persistent OpenAI-compatible chat stub for browser testing.
// Always serves a valid scene-script package (rotate content per request).
// Usage: node scripts/stub-openai-chat.mjs [port]
import http from "node:http";

const port = Number(process.argv[2] ?? 3972);
let hits = 0;

function scenePkg(version) {
  return {
    title: `The Last Signal (${version})`,
    description: `A ${version} mystery about the final night of a lighthouse keeper. #mystery #lighthouse`,
    tags: ["mystery", "lighthouse", "storm", "night", "keeper", "signal", "sea", "suspense", "story", "shorts"],
    scenes: [1, 2, 3, 4].map((i) => ({
      title: `Beat ${i}`,
      narration: `${version} scene ${i}: the keeper climbs the spiral stairs, storm rattling the glass, and the lamp refuses to light.`,
      visual: `a lone lighthouse keeper on a stormy night, beat ${i}, cinematic wide shot, cold sea spray`,
      camera: i % 2 ? "zoom-in" : "pan-left",
      mood: "teal shadows, cold moonlight, volumetric haze",
      caption: `The lamp went dark ${i}`,
      hostInScene: false,
    })),
  };
}

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits += 1;
      const version = `v${hits}`;
      console.log(`[stub] ${req.method} ${req.url} → serving "${version}"`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `stub-${hits}`,
          choices: [
            { index: 0, message: { role: "assistant", content: JSON.stringify(scenePkg(version)) }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        })
      );
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`[stub] listening on http://127.0.0.1:${port}/v1`));
