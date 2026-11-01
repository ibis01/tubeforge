// Local-only harness (never shipped): seed deterministic Stage 4b verification
// data for the NEWEST organization (the live-pass account) — research sessions
// with ideas at mixed competition levels, published videos with two days of
// stats snapshots, and a cast character with assigned videos. No AI calls.
//
// Usage: node scripts/seed-4b.mjs [orgId]   (default: newest organization)
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const orgArg = process.argv[2];
const org = orgArg
  ? await prisma.organization.findUnique({ where: { id: orgArg } })
  : await prisma.organization.findFirst({ orderBy: { createdAt: "desc" } });
if (!org) {
  console.error("no organization found — register an account first");
  process.exit(1);
}

const daysAgo = (d) => new Date(Date.now() - d * 86_400_000);

// ---------- 1. Research sessions (two niches, mixed competition levels) ----------
// The stored shape must match lib/research.ts: { ideas: ResearchIdea[], nicheSummary }.
const session = (niche, query, nicheSummary, ideas) => ({
  organizationId: org.id,
  niche,
  query,
  ideas: JSON.stringify({ ideas, nicheSummary }),
});

await prisma.researchSession.createMany({
  data: [
    session(
      "Money Psychology",
      "scarcity",
      "Evergreen and under-served: viewers search for framing money decisions through emotion, and most channels recycle the same three tips. Low-competition angles live in specific decision moments (renting vs buying, quitting a job), not generic advice.",
      [
        {
          id: "seed-mp-1",
          title: "The $0 mistake every renter makes",
          angle: "Rent vs buy framed as an insurance premium you're already paying — the hidden cost of waiting for perfect timing.",
          keywords: ["renting vs buying", "housing market", "money psychology", "sunk cost"],
          searchVolume: "Very High",
          competition: "Low",
          viralScore: 91,
          suggestedLength: "long",
          why: "Specific decision moment + concrete dollar framing; the comment section argues with itself, which drives session time.",
        },
        {
          id: "seed-mp-2",
          title: "Why your brain loves payday more than the money",
          angle: "Dopamine hits on schedule explain subscription creep — and why raises never feel like enough.",
          keywords: ["dopamine", "payday", "lifestyle creep"],
          searchVolume: "High",
          competition: "Medium",
          viralScore: 78,
          suggestedLength: "medium",
          why: "Psych-explainer with a lab hook; medium competition but strong retention shape.",
        },
        {
          id: "seed-mp-3",
          title: "The 24-hour rule rich people actually use",
          angle: "Delay as a decision firewall, told through three purchase regrets that undo themselves.",
          keywords: ["delayed gratification", "frugal", "impulse buying"],
          searchVolume: "High",
          competition: "High",
          viralScore: 64,
          suggestedLength: "short",
          why: "Crowded angle — only worth it with a strong first-scene hook; radar boost would help.",
        },
        {
          id: "seed-mp-4",
          title: "Broken window theory, but for your budget",
          angle: "One small leaky habit legitimizes bigger ones — the same spiral as vandalism, applied to spending.",
          keywords: ["budgeting", "habits", "behavioral economics"],
          searchVolume: "Medium",
          competition: "Low",
          viralScore: 83,
          suggestedLength: "medium",
          why: "Cross-domain analogy is rare in this niche; strong candidate for a series pilot.",
        },
      ]
    ),
    session(
      "Space Discoveries",
      "—",
      "High appetite, high bar: the audience is fluent, so 'another size comparison' video dies. The openings that work are new-mission updates, instrument firsts (what Voyager still hears), and 'what we got wrong' retrospectives.",
      [
        {
          id: "seed-sd-1",
          title: "What Voyager is still hearing out there",
          angle: "The plasma wave instrument as a 47-year-old microphone — the actual sound of interstellar space, and why it went up recently.",
          keywords: ["voyager 1", "interstellar space", "plasma waves", "nasa"],
          searchVolume: "Very High",
          competition: "Medium",
          viralScore: 88,
          suggestedLength: "long",
          why: "Audio-first hook no thumbnail can spoil; evergreen and revisitable on every new paper.",
        },
        {
          id: "seed-sd-2",
          title: "The map of everything we can't see",
          angle: "Dark matter mapped by what it bends — a tour of the biggest structures that are, by definition, invisible.",
          keywords: ["dark matter", "gravitational lensing", "cosmology"],
          searchVolume: "Medium",
          competition: "Medium",
          viralScore: 71,
          suggestedLength: "long",
          why: "Visual-heavy evergreen; needs strong motion design to hold the back half.",
        },
        {
          id: "seed-sd-3",
          title: "Every planet's real scale, to an commute",
          angle: "Sizes re-expressed as a daily commute — the solar system in kilometers you actually drive.",
          keywords: ["solar system", "scale", "planets"],
          searchVolume: "High",
          competition: "High",
          viralScore: 58,
          suggestedLength: "short",
          why: "The most-covered angle in the niche; only a fresh unit (commute minutes) saves it.",
        },
      ]
    ),
  ],
});

// ---------- 2. A cast character + published videos with two days of stats ----------
const vex = await prisma.character.create({
  data: {
    organizationId: org.id,
    name: "Professor Vex",
    role: "Skeptical science storyteller",
    personality: "Wry, curious, allergic to hype. Opens with a question, closes with a twist.",
    appearance: "Silver-haired, round glasses, dark cardigan over a collared shirt.",
    identityAnchor:
      "55yo male, silver short hair, round thin glasses, dark green cardigan, collared shirt, warm studious expression",
    voice: "jam",
    artStyle: "cinematic",
  },
});

const videoSpecs = [
  {
    topic: "The secret economy of container ships",
    niche: "Money Psychology",
    title: "The Secret Economy of Container Ships",
    youtubeUrl: "https://youtu.be/tf-seed-1",
    published: 12,
    stats: [
      { views: 8_400, likes: 310, comments: 44, at: 6 },
      { views: 12_950, likes: 470, comments: 61, at: 0.2 },
    ],
    character: true,
  },
  {
    topic: "What Voyager is still hearing out there",
    niche: "Space Discoveries",
    title: "What Voyager Is Still Hearing Out There",
    youtubeUrl: "https://youtu.be/tf-seed-2",
    published: 7,
    stats: [
      { views: 5_100, likes: 260, comments: 39, at: 3 },
      { views: 6_830, likes: 340, comments: 52, at: 0.2 },
    ],
    character: true,
  },
  {
    topic: "Why your brain loves payday more than the money",
    niche: "Money Psychology",
    title: "Why Your Brain Loves Payday More Than The Money",
    youtubeUrl: "https://youtu.be/tf-seed-3",
    published: 4,
    stats: [
      { views: 900, likes: 38, comments: 5, at: 2 },
      { views: 1_120, likes: 47, comments: 7, at: 0.2 },
    ],
    character: false,
  },
];

const videoIds = [];
for (const spec of videoSpecs) {
  const v = await prisma.video.create({
    data: {
      organizationId: org.id,
      topic: spec.topic,
      niche: spec.niche,
      title: spec.title,
      format: "story",
      status: "published",
      script: `${spec.title} — seeded narration for the Stage 4b live pass.`,
      tags: "seed,stage4b,verification",
      youtubeUrl: spec.youtubeUrl,
      publishedAt: daysAgo(spec.published),
      hasThumbnail: true,
      characterId: spec.character ? vex.id : null,
    },
  });
  videoIds.push(v.id);
  for (const s of spec.stats) {
    await prisma.videoStat.create({
      data: {
        organizationId: org.id,
        videoId: v.id,
        views: s.views,
        likes: s.likes,
        comments: s.comments,
        snapshotAt: daysAgo(s.at),
      },
    });
  }
}

// lastSyncAt on the analytics sync bar comes from this user setting.
const owner = await prisma.membership.findFirst({
  where: { organizationId: org.id, role: "owner" },
});
if (owner) {
  await prisma.userSetting.upsert({
    where: { userId_key: { userId: owner.userId, key: "ytStatsSyncedAt" } },
    update: { value: new Date().toISOString() },
    create: { userId: owner.userId, key: "ytStatsSyncedAt", value: new Date().toISOString() },
  });
}

console.log(
  `seeded org ${org.id}: 2 research sessions (7 ideas), ${vex.name} + ${videoIds.length} published videos with stats`
);
await prisma.$disconnect();
