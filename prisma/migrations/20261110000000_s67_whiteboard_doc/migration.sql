-- S67 — Whiteboard Engine (E9 Phase A / E1 design §2.1): the ONE additive
-- doc column. The validated WhiteboardProject JSON (scenes, placements,
-- animation events, camera keyframes) stored as the sixth JSON doc column on
-- Video. Null = the video never opened the whiteboard editor. No default, no
-- backfill — the additive chain migration + self-healing deploy law
-- (postgres CI lane replays the wedge recovery on every push).
ALTER TABLE "Video" ADD COLUMN "whiteboardProject" TEXT;
