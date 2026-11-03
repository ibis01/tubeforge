// Inspect the render fixtures' DB state: the Battle Yamuk video + its
// timeline doc (transitions, audio levels, captions) — what a re-render
// would consume through the new S2 doc overlay.
import { PrismaClient } from "@prisma/client";
import fs from "fs";

const db = new PrismaClient();
const ids = ["cmvya1qnk0031np0well7rjm5"];
const any = await db.video.findMany({
  where: { OR: [{ id: { in: ids } }, { hasVoiceover: true, hasStoryboard: true }] },
  select: {
    id: true, title: true, format: true, renderMode: true,
    transitionStyle: true, transitionDuration: true,
    musicEnabled: true, musicVolume: true, musicDucking: true,
    directorState: true, hasStoryboard: true, hasVoiceover: true, hasVideo: true,
    timeline: true, scenes: true, voiceSource: true, niche: true,
  },
});
for (const v of any) {
  const sceneCount = JSON.parse(v.scenes).length;
  let docInfo = "no timeline doc";
  if (v.timeline) {
    try {
      const t = JSON.parse(v.timeline);
      const trans = t.scenes.map((s: { transitionIn?: string }) => s.transitionIn).join(",");
      const music = t.scenes.map((s: { audio?: { music?: { level?: number } } }) => s.audio?.music?.level).join(",");
      const voice = t.scenes.map((s: { audio?: { voice?: { level?: number } } }) => s.audio?.voice?.level).join(",");
      const caps = t.scenes.filter((s: { caption?: unknown }) => s.caption).length;
      docInfo = `${t.sceneCount} scenes; transitions=[${trans}]; music=[${music}]; voice=[${voice}]; captioned=${caps}`;
    } catch (e) {
      docInfo = `doc parse failed: ${e}`;
    }
  }
  console.log(`${v.id} "${v.title}" mode=${v.renderMode} scenes=${sceneCount} trans=${v.transitionStyle}/${v.transitionDuration} music=${v.musicEnabled}@${v.musicVolume} duck=${v.musicDucking} director=${v.directorState} sb=${v.hasStoryboard} vo=${v.hasVoiceover} vid=${v.hasVideo} voice=${v.voiceSource}\n  doc: ${docInfo}`);
  const artOk = JSON.parse(v.scenes).every((s: { index: number }) =>
    fs.existsSync(`/home/z/my-project/uploads/${v.id}/scene-${String(s.index).padStart(2, "0")}.png`)
  );
  const wavOk = JSON.parse(v.scenes).every((s: { index: number }) =>
    fs.existsSync(`/home/z/my-project/uploads/${v.id}/voice-${String(s.index).padStart(2, "0")}.wav`)
  );
  console.log(`  art=${artOk} wavs=${wavOk}`);
}
await db.$disconnect();
