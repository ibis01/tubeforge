// Local-only harness (never shipped): flip a freshly created classic video to
// story format, seed one cast scene, and attach a character with an identity
// anchor — so the AI Director route can be smoke-tested without a live LLM.
// Usage: node scripts/seed-director-smoke.mjs <videoId>
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const videoId = process.argv[2];
if (!videoId) {
  console.error("usage: node scripts/seed-director-smoke.mjs <videoId>");
  process.exit(1);
}

const video = await prisma.video.findUnique({ where: { id: videoId } });
if (!video) {
  console.error(`video ${videoId} not found`);
  process.exit(1);
}

const character = await prisma.character.create({
  data: {
    organizationId: video.organizationId,
    name: "Nova",
    role: "host",
    appearance: "late-20s presenter, short silver hair, dark green flight jacket",
    identityAnchor: "nova: late-20s presenter, short silver hair, sharp green eyes, dark green flight jacket, small silver ear stud",
    voice: "jam",
    isActive: true,
  },
});

const scenes = [
  {
    index: 1,
    title: "Open",
    narration: "A host greets the audience from a neon city street at night.",
    visual: "host on a neon-lit city street, rain just ended, reflections on asphalt",
    camera: "zoom-in",
    mood: "neon night, wet reflections",
    caption: "hello",
    hostInScene: true,
    rehook: false,
    sfx: "none",
  },
  {
    index: 2,
    title: "Turn",
    narration: "But the lights are lying to you, and tonight we prove it.",
    visual: "close-up on a glowing sign flickering out",
    camera: "push-in",
    mood: "colder neon, deeper shadow",
    caption: "the lie",
    hostInScene: false,
    rehook: true,
    sfx: "sting",
  },
];

await prisma.video.update({
  where: { id: videoId },
  data: {
    format: "story",
    characterId: character.id,
    scenes: JSON.stringify(scenes),
  },
});
console.log(JSON.stringify({ ok: true, characterId: character.id }));
process.exit(0);
