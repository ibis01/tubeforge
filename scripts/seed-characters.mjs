// Seed two demo cast characters for TubeForge Phase 1.
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const CHARACTERS = [
  {
    name: "Professor Vex",
    role: "Host — skeptical history & mysteries storyteller",
    personality:
      "Dry wit, forensic calm, speaks in measured reveals. Opens every video with a question the viewer cannot ignore, closes with a line that lingers. Catches himself mid-sentence when a detail gets too strange: 'But that... that is where the record ends.'",
    appearance:
      "Man in his late 30s with short dark hair swept back, neat trimmed beard, round thin-framed glasses, deep burgundy knit cardigan over a charcoal shirt. Composed posture, hands that punctuate reveals. Subtle knowing half-smile.",
    identityAnchor:
      "man in his late 30s, short dark swept-back hair, neat trimmed beard, round thin-framed glasses, deep burgundy cardigan over charcoal shirt, composed knowing expression",
    voice: "jam",
    artStyle: "cinematic",
  },
  {
    name: "Nova",
    role: "Host — cosmic science explainer",
    personality:
      "Boundlessly curious, talks fast when excited, drops awe-struck pauses before big numbers. Signature line: 'And that is just the part we can see.' Warm but never hype-y — wonder does the selling.",
    appearance:
      "Young woman in her late 20s, silver-white bob haircut with a single cyan streak, large expressive eyes, freckles, oversized slate-blue flight jacket over a white tee, small constellation pin on the collar. Energized posture, leans toward the camera.",
    identityAnchor:
      "young woman late 20s, silver-white bob with single cyan streak, freckles, large expressive eyes, slate-blue oversized flight jacket over white tee, constellation pin on collar",
    voice: "kazi",
    artStyle: "stylized",
  },
];

async function main() {
  for (const c of CHARACTERS) {
    const existing = await db.character.findFirst({ where: { name: c.name } });
    if (existing) {
      console.log(`- ${c.name} already exists (${existing.id})`);
      continue;
    }
    const created = await db.character.create({ data: c });
    console.log(`+ created ${created.name} (${created.id})`);
  }
  const total = await db.character.count();
  console.log(`Total characters: ${total}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
