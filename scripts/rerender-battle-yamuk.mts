// Re-render Battle Yamuk (cmvya1qnk0031np0well7rjm5) with the sync/noise/
// caption/true-peak fixes — same job body the queue handler runs, entered
// under the video owner's tenant context. Narration WAVs + storyboard PNGs
// already exist on disk, so this is a pure re-compose.
//
//   node --import tsx scripts/rerender-battle-yamuk.mts

import { withCtx } from "../src/lib/tubeforge/tenant.ts";
import { runRenderJob } from "../src/lib/tubeforge/video-jobs.ts";

const VIDEO_ID = "cmvya1qnk0031np0well7rjm5";
const CTX = {
  userId: "cmvy8poa50000np0wrdvnsk26",
  organizationId: "cmvy8poa60001np0w9jcv90vy",
  role: "owner",
};

const started = Date.now();
await withCtx(CTX, async () => {
  await runRenderJob(VIDEO_ID, { mode: "kenburns", music: true });
});
console.log(`[rerender] done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
