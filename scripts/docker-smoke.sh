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
#
# Registry strategy (S105 follow-up — three CI runs died on it): Docker Hub
# DENIES anonymous pulls from GitHub's shared runner IP pools ("pull access
# denied … repository does not exist") regardless of backoff. Every image the
# topology needs is therefore sourced HUB-FREE:
#   node:20-bookworm-slim + postgres:16-alpine → pulled from the ECR Public
#     library mirror (public.ecr.aws/docker/library/…) and tagged locally to
#     the names the Dockerfile / compose expect, so the build and compose
#     find them in the local cache and never contact Hub;
#   MinIO → a HOST process downloaded from dl.min.io (MinIO's own CDN), with
#     the containers talking S3 to it over host.docker.internal:9000.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(openssl rand -hex 16)}"
export TUBEFORGE_AUTH_SECRET="${TUBEFORGE_AUTH_SECRET:-$(openssl rand -hex 32)}"
export TUBEFORGE_ENCRYPTION_KEY="${TUBEFORGE_ENCRYPTION_KEY:-$(openssl rand -hex 32)}"
export MINIO_ROOT_USER="${MINIO_ROOT_USER:-tubeforge}"
export MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-$(openssl rand -hex 16)}"

COMPOSE=(docker compose -p tf-smoke -f docker-compose.yml -f docker-compose.smoke.yml)

MINIO_PID=""
cleanup() {
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  [ -n "$MINIO_PID" ] && kill "$MINIO_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- Hub-free image sourcing (ECR Public mirrors, tagged to local names) ---
for pair in \
  "public.ecr.aws/docker/library/node:20-bookworm-slim node:20-bookworm-slim" \
  "public.ecr.aws/docker/library/postgres:16-alpine postgres:16-alpine"; do
  set -- $pair
  if docker image inspect "$2" >/dev/null 2>&1; then
    echo "[smoke] $2 already cached"
    continue
  fi
  echo "[smoke] pulling $2 from the ECR Public mirror"
  docker pull "$1"
  docker tag "$1" "$2"
done

# --- MinIO as a HOST process (dl.min.io — MinIO's own CDN, Hub-free) ---
echo "[smoke] downloading MinIO + mc from dl.min.io"
curl -fsSLo /tmp/minio https://dl.min.io/server/minio/release/linux-amd64/minio
curl -fsSLo /tmp/mc https://dl.min.io/client/mc/release/linux-amd64/mc
chmod +x /tmp/minio /tmp/mc
rm -rf /tmp/minio-data && mkdir -p /tmp/minio-data
MINIO_ROOT_USER="$MINIO_ROOT_USER" MINIO_ROOT_PASSWORD="$MINIO_ROOT_PASSWORD" \
  /tmp/minio server /tmp/minio-data --address 127.0.0.1:9000 --console-address 127.0.0.1:9001 \
  >/tmp/minio.log 2>&1 &
MINIO_PID=$!

MINIO_OK=false
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1; then MINIO_OK=true; break; fi
  sleep 1
done
if [ "$MINIO_OK" != true ]; then
  echo "[smoke] FAIL: the MinIO host process never became healthy"
  tail -20 /tmp/minio.log || true
  exit 1
fi
/tmp/mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
/tmp/mc mb --ignore-existing local/tubeforge >/dev/null
echo "[smoke] MinIO healthy — bucket ready (host process, :9000)"

# --- build + boot the topology ---
echo "[smoke] building + booting the production topology (postgres + web + worker → MinIO)"
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
