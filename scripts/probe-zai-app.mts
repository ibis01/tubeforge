// End-to-end preview wiring probe: exercise the app's OWN provider stack
// (budget → providers → Z.ai SDK → /etc/.z-ai-config → gateway) for both
// chat and TTS, under the preview user's tenant context. No secrets printed.
import { PrismaClient } from "@prisma/client";

const { withCtx } = await import("../src/lib/tubeforge/tenant");
const { aiCall } = await import("../src/lib/tubeforge/budget");
const { llmChat } = await import("../src/lib/tubeforge/llm");
const { ttsSynthesize } = await import("../src/lib/tubeforge/providers/tts");

const db = new PrismaClient();
try {
  const user = await db.user.findFirstOrThrow({ where: { email: "ibis01abc@gmail.com" } });
  const m = await db.membership.findFirstOrThrow({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
  });
  const ctx = { userId: user.id, organizationId: m.organizationId, role: m.role };

  const chat = await withCtx(ctx, () =>
    aiCall(
      "llm",
      "preview zai wire probe",
      () =>
        llmChat({
          messages: [
            { role: "system", content: "You are a wiring probe. Reply with exactly: WIRED" },
            { role: "user", content: "run" },
          ],
          temperature: 0,
        }),
      { attempts: 1 }
    )
  );
  const text =
    (chat as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ??
    JSON.stringify(chat).slice(0, 80);
  console.log("zai chat via app pipeline:", String(text).slice(0, 120));

  const wav = await withCtx(ctx, () =>
    aiCall("tts", "preview tts probe", () => ttsSynthesize({ input: "Preview wiring test.", voice: "tongtong", speed: 1 }), {
      attempts: 1,
    })
  );
  console.log("zai tts via app pipeline:", Buffer.byteLength(wav as Buffer), "bytes of audio");
} finally {
  await db.$disconnect();
}
