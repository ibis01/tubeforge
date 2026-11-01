// Local-only harness (never shipped): seed a deterministic 5-scene story
// script into a video row so UI surfaces can be verified without a live LLM.
// Usage: node scripts/seed-story-scene.mjs <videoId> [title]
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const videoId = process.argv[2];
const title = process.argv[3] ?? "The Secret Economy of Container Ships";
if (!videoId) {
  console.error("usage: node scripts/seed-story-scene.mjs <videoId> [title]");
  process.exit(1);
}

const scenes = [
  {
    index: 1,
    title: "The steel leviathans",
    narration:
      "Ninety percent of everything you own has spent time inside a steel box the size of a living room, crossing an ocean at twenty miles per hour.",
    visual:
      "colossal container ship cutting through open ocean at golden hour, thousands of stacked rust-red and blue containers, dramatic scale against tiny tugboat",
    camera: "slow-zoom-in",
    mood: "awe-struck, vast golden light",
    caption: "90% of everything",
    hostInScene: false,
    rehook: false,
    sfx: "none",
  },
  {
    index: 2,
    title: "The box that ate world trade",
    narration:
      "In 1956 a trucker named Malcom McLean loaded fifty-eight containers onto a converted tanker and cut the cost of loading cargo from five dollars a ton to fifteen cents.",
    visual:
      "vintage 1950s docks, crane lifting first crude metal containers onto retro tanker ship, longshoremen watching, sepia documentary tones",
    camera: "pan-right",
    mood: "nostalgic sepia archival",
    caption: "$5 → 15¢ per ton",
    hostInScene: false,
    rehook: false,
    sfx: "riser",
  },
  {
    index: 3,
    title: "Chokepoints of the planet",
    narration:
      "Today a single stuck ship in the Suez Canal held up twelve percent of global trade for six days, and supply chains on every continent felt it within hours.",
    visual:
      "satellite-style aerial view of Suez Canal with giant container ship wedged diagonally, queue of ships snaking to horizon",
    camera: "slow-zoom-out",
    mood: "tense, clinical satellite palette",
    caption: "12% of world trade, paused",
    hostInScene: false,
    rehook: true,
    sfx: "sting",
  },
  {
    index: 4,
    title: "The invisible empire",
    narration:
      "Three alliances of shipping companies now move eighty percent of all containers, and their pricing power bends the cost of everything from sneakers to steel.",
    visual:
      "dark boardroom table with glowing world map, container routes as arcing light lines between continents, ominous corporate atmosphere",
    camera: "static",
    mood: "shadowy, cold blue corporate",
    caption: "3 alliances, 80% of boxes",
    hostInScene: false,
    rehook: false,
    sfx: "none",
  },
  {
    index: 5,
    title: "What rides in the boxes",
    narration:
      "So the next time a package lands on your doorstep in two days, remember the silent fleet of steel cities that carried it across the world for pennies.",
    visual:
      "modern port at dawn, rows of stacked colorful containers, delivery van driving toward sunrise city skyline",
    camera: "slow-zoom-in",
    mood: "warm hopeful sunrise",
    caption: "Steel cities at sea",
    hostInScene: false,
    rehook: false,
    sfx: "none",
  },
];

const script = scenes.map((s) => s.narration).join("\n\n");
const words = script.split(/\s+/).filter(Boolean).length;

const video = await prisma.video.findUnique({ where: { id: videoId } });
if (!video) {
  console.error("video not found:", videoId);
  process.exit(1);
}

await prisma.video.update({
  where: { id: videoId },
  data: {
    title,
    script,
    description:
      "The hidden logistics empire that moves almost everything you own — and the chokepoints that can stop the world.",
    tags: "logistics,shipping,container ships,global trade,suez canal,supply chain",
    scenes: JSON.stringify(scenes),
    wordCount: words,
    status: "scripted",
    error: null,
  },
});

console.log(`seeded ${videoId}: "${title}" — ${scenes.length} scenes, ${words} words`);
await prisma.$disconnect();
