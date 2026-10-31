// Export a cloned-voice sample from the VoiceProfile table to a WAV file,
// ready for re-upload through another provider's Clone tab.
// Usage: node scripts/export-voice-sample.mjs <profileName> <outPath>
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "fs";

const [name, out] = process.argv.slice(2);
if (!name || !out) {
  console.error("usage: node export-voice-sample.mjs <profileName> <out.wav>");
  process.exit(1);
}

const p = new PrismaClient();
try {
  const row = await p.voiceProfile.findFirst({
    where: { name: { contains: name } },
    orderBy: { createdAt: "desc" },
  });
  if (!row?.sampleWav) {
    console.error(`no sample stored for profile matching "${name}"`);
    process.exit(1);
  }
  const buf = Buffer.from(row.sampleWav, "base64");
  writeFileSync(out, buf);
  console.log(
    `exported "${row.name}" (${row.provider}/${row.providerVoiceId}) → ${out} (${buf.length} bytes)`
  );
} finally {
  await p.$disconnect();
}
