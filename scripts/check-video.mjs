import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const videos = await db.video.findMany({ orderBy: { createdAt: 'desc' }, take: 3, select: { id: true, title: true, status: true, hasVoiceover: true, hasThumbnail: true, audioDuration: true, error: true, updatedAt: true } });
console.log(JSON.stringify(videos, null, 2));
await db.$disconnect();
