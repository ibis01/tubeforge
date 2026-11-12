#!/usr/bin/env bash
# TubeForge — P0.6 production-topology smoke (docs/production-readiness.md).
#
#   bash scripts/docker-smoke.sh
#
# Builds the production image and walks the REAL topology end-to-end:
# postgres (migrations) + MinIO (object storage) + web (Next.js · auth · API)
# + worker (queue execution). The acceptance walk:
#
#   register → login → create project (HTTP, real routes)
#   → ffmpeg renders a real MP4 inside the web container
#   → put/get round-trips the artifact through the s3 driver into MinIO
#     (S101 reservation lifecycle settled)
#   → enqueue a job → the WORKER container executes it cross-process
#   → stop worker → seed an expired-lease running job + a pending job
#   → start worker → the reaper bumps the fencing token, both jobs land done
#
# Any failure exits non-zero. The compose project is torn down on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(openssl rand -hex 16)}"
export TUBEFORGE_AUTH_SECRET="${TUBEFORGE_AUTH_SECRET:-$(openssl rand -hex 32)}"
export TUBEFORGE_ENCRYPTION_KEY="${TUBEFORGE_ENCRYPTION_KEY:-$(openssl rand -hex 32)}"
export MINIO_ROOT_USER="${MINIO_ROOT_USER:-tubeforge}"
export MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-$(openssl rand -hex 16)}"

COMPOSE=(docker compose -p tf-smoke -f docker-compose.yml -f docker-compose.smoke.yml)

cleanup() {
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

# S105 fix — Docker Hub anonymous pulls from GitHub's SHARED runner IP pools
# rate-limit into exactly "pull access denied for minio/minio, repository
# does not exist or may require 'docker login'" (two consecutive runs died
# on it: 43293441260, 43293505991). The image is fine; the pool is throttled.
# Pre-pull every external image with bounded backoff BEFORE compose up so a
# throttled window is waited out instead of failing the whole gate.
for img in minio/minio:latest amazon/aws-cli:latest postgres:17; do
  if docker image inspect "$img" >/dev/null 2>&1; then continue; fi
  pulled=false
  for attempt in 1 2 3 4; do
    echo "[smoke] docker pull $img (attempt $attempt)"
    if docker pull "$img" >/dev/null 2>&1; then pulled=true; break; fi
    sleep $((attempt * 20))
  done
  if [ "$pulled" != true ]; then
    echo "[smoke] FAIL: docker pull exhausted retries for $img (Docker Hub throttling?)"
    exit 1
  fi
done

echo "[smoke] building + booting the production topology (postgres + minio + web + worker)"
"${COMPOSE[@]}" up -d --build

echo "[smoke] waiting for web health (the image healthcheck: /api/auth/status)"
WEB_OK=false
for i in $(seq 1 90); do
  if curl -fsS http://localhost:3000/api/auth/status >/dev/null 2>&1; then WEB_OK=true; break; fi
  if [ "$i" -eq 45 ]; then
    echo "[smoke] web still unhealthy at midpoint — last logs:"
    "${COMPOSE[@]}" logs --tail 40 web || true
  fi
  sleep 5
done
if [ "$WEB_OK" != true ]; then
  echo "[smoke] FAIL: web never became healthy"
  "${COMPOSE[@]}" logs --tail 60 web || true
  exit 1
fi
echo "[smoke] web healthy"

echo "[smoke] phase 1 — topology reality: migrations, columns, MinIO round-trip, cross-process job"
"${COMPOSE[@]}" exec -T web node --import tsx scripts/smoke-walk.mts --phase 1

echo "[smoke] stopping the worker — seeding the recovery scenario while it is DOWN"
"${COMPOSE[@]}" stop worker
"${COMPOSE[@]}" exec -T web node --import tsx scripts/smoke-walk.mts --phase 2

echo "[smoke] starting the worker — the reaper + claimer must land both jobs"
"${COMPOSE[@]}" start worker
"${COMPOSE[@]}" exec -T web node --import tsx scripts/smoke-walk.mts --phase 3

echo "[smoke] PASS — the production topology walked end-to-end"
