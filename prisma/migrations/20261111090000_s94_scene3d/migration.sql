-- S94 (ROADMAP #13) — the 3D scene doc column: the versioned Scene3D
-- contract (camera orbit keyframes, primitive objects, lights). The tenth
-- JSON doc column; null = no 3D scene scaffolded yet.
ALTER TABLE "Video" ADD COLUMN "scene3d" TEXT;
