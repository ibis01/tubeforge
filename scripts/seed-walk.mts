// B3 walk seed — a story-format project with scene rows so the five-area
// workspace renders with real content (no AI calls; images absent on
// purpose — the "no art yet" tiles are part of the layout under test).
import { db } from "../src/lib/db";

const email = process.argv[2] ?? "";
if (!email) throw new Error("usage: tsx scripts/seed-walk.mts <existing-user-email>");

const user = await db.user.findUnique({ where: { email }, select: { id: true } });
if (!user) throw new Error(`no user ${email}`);
const org = await db.organization.findFirst({ where: { memberships: { some: { userId: user.id } } } });
if (!org) throw new Error("no org");

const scenes = [1, 2, 3, 4].map((i) => ({
  index: i,
  id: `walk-scene-${i}-${Date.now().toString(36)}`,
  title: [
    "The harbor at dawn",
    "Containers as a currency",
    "The invisible middlemen",
    "Where the margin hides",
  ][i - 1],
  narration: [
    "Every morning, four thousand steel boxes arrive at the harbor, and almost nobody asks what is actually inside them.",
    "A container is not just a box — it is a unit of account, a bet on distance, and sometimes a license to print money.",
    "Between the shipper and the shelf sits a chain of middlemen so quiet that even the industry struggles to name them all.",
    "The margin does not hide in the freight rate. It hides in the fourteen days the box spends doing absolutely nothing.",
  ][i - 1],
  visual: `A cinematic wide shot of container stacks at dawn, scene ${i}, dramatic light`,
  camera: ["push-in", "pan-left", "zoom-in", "pan-right"][i - 1],
  mood: ["cinematic", "suspenseful", "neutral", "uplifting"][i - 1],
  caption: ["Steel boxes arrive", "A unit of account", "The quiet middle", "Where margin hides"][i - 1],
  hostInScene: i === 1,
  rehook: i === 3,
  sfx: i === 3 ? "sting" : "none",
}));

const video = await db.video.create({
  data: {
    organizationId: org.id,
    title: "Walk probe — container economy",
    topic: "The secret economy of container ships",
    niche: "documentary",
    format: "story",
    renderMode: "kenburns",
    status: "draft",
    script: scenes.map((s) => s.narration).join("\n\n"),
    scenes: JSON.stringify(scenes),
    hasStoryboard: true,
    wordCount: 96,
    length: "medium",
  },
});
console.log("seeded", video.id);
await db.$disconnect();
