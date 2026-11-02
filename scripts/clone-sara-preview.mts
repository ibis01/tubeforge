// Add "Sara" as a cloned voice for the preview user via the app's REAL
// selfhost clone pipeline (validate → ffprobe → normalize to mono 24 kHz
// PCM-16 WAV ≤30 s → store base64 on the VoiceProfile row). The sample is
// read from upload/sara.mp3. No secrets printed.
import fs from "fs";

const { PrismaClient } = await import("@prisma/client");
const tenant = await import("../src/lib/tubeforge/tenant");
const { cloneVoice } = await import("../src/lib/tubeforge/voice-clone");

const db = new PrismaClient();
try {
  const user = await db.user.findFirstOrThrow({ where: { email: "ibis01abc@gmail.com" } });
  const membership = await db.membership.findFirstOrThrow({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
  });
  const buffer = fs.readFileSync("/home/z/my-project/upload/sara.mp3");
  const result = await withCtxSafe({ userId: user.id, organizationId: membership.organizationId, role: membership.role }, () =>
    cloneVoice({
      source: { kind: "upload", buffer, filename: "sara.mp3" },
      name: "Sara",
      provider: "selfhost",
    })
  );
  console.log("voice cloned:");
  console.log(JSON.stringify(result.profile, null, 2));
} finally {
  await db.$disconnect();
}

async function withCtxSafe<T>(ctx: { userId: string; organizationId: string; role: string }, fn: () => Promise<T>): Promise<T> {
  const { withCtx } = await import("../src/lib/tubeforge/tenant");
  return withCtx(ctx as Parameters<typeof withCtx>[0], fn);
}
