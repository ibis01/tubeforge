// Seed a handful of schedule slots for the existing videos + one placeholder.
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  // Clear old slots for a clean demo slate
  await db.scheduleSlot.deleteMany({});

  const videos = await db.video.findMany({
    select: { id: true, title: true, topic: true, channelId: true },
  });
  const channel = await db.channel.findFirst();

  const today = new Date();
  const day = (offset: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + offset);
    d.setHours(0, 0, 0, 0);
    return d;
  };

  const plans: {
    offset: number;
    time: string;
    title: string;
    note?: string;
  }[] = [
    { offset: 2, time: "18:00", title: "", note: "Peak evening traffic window" },
    { offset: 5, time: "12:00", title: "", note: "Lunchtime viewers" },
    {
      offset: 8,
      time: "21:00",
      title: "Placeholder: viewer Q&A compilation (needs editing)",
      note: "Community post teaser before upload",
    },
  ];

  let i = 0;
  for (const plan of plans) {
    const video = videos[i % videos.length];
    await db.scheduleSlot.create({
      data: {
        videoId: plan.title ? null : video.id,
        channelId: video.channelId ?? channel?.id ?? null,
        title: plan.title || video.title || video.topic,
        slotDate: day(plan.offset),
        timeOfDay: plan.time,
        note: plan.note ?? null,
      },
    });
    i++;
  }

  const slots = await db.scheduleSlot.findMany({
    orderBy: { slotDate: "asc" },
  });
  console.log(`Seeded ${slots.length} schedule slots:`);
  for (const s of slots) {
    console.log(
      `  - ${s.slotDate.toISOString().slice(0, 10)} ${s.timeOfDay} :: ${s.title}`
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
