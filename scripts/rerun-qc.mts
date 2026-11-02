// Re-run the QC battery for one video (owner ctx) — updates Video.qcReport.
//   node --import tsx scripts/rerun-qc.mts <videoId>

import { withCtx } from "../src/lib/tubeforge/tenant.ts";
import { qcForVideo } from "../src/lib/tubeforge/qc.ts";

const videoId = process.argv[2] ?? "cmvya1qnk0031np0well7rjm5";
const CTX = {
  userId: "cmvy8poa50000np0wrdvnsk26",
  organizationId: "cmvy8poa60001np0w9jcv90vy",
  role: "owner",
};

await withCtx(CTX, async () => {
  const report = await qcForVideo(videoId);
  console.log("QC passed:", report?.passed);
  for (const c of report?.checks ?? []) {
    console.log(`  ${c.status === "pass" ? "✓" : "✗"} ${c.id}: ${c.detail} ${c.note ?? ""}`.trim());
  }
});
