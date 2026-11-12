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

# --- object store as a HOST process (Hub-free; dl.min.io is 410 Gone —
# MinIO retired the community binaries, so the S3-compatible store here is
# SeaweedFS, pinned to release 3.96 from GitHub releases). The containers
# talk S3 to it over host.docker.internal:9000; the bucket is created
# INSIDE the walk (phase 1) through the production SigV4 signer itself.
echo "[smoke] downloading SeaweedFS 3.96 (S3-compatible store) from GitHub releases"
curl -fsSLo /tmp/weed.tar.gz "https://github.com/seaweedfs/seaweedfs/releases/download/3.96/linux_amd64.tar.gz"
tar xzf /tmp/weed.tar.gz -C /tmp weed
rm -rf /tmp/seaweed-data && mkdir -p /tmp/seaweed-data
cat > /tmp/seaweed-s3.json << EOF
{ "identities": [ { "name": "anon", "actions": ["Read", "List"] }, { "name": "tubeforge", "credentials": [{ "accessKey": "$MINIO_ROOT_USER", "secretKey": "$MINIO_ROOT_PASSWORD" }], "actions": ["Read", "Write", "List", "Tagging", "Admin"] } ] }
EOF
# -ip.bind=0.0.0.0 is NOT optional: -ip=127.0.0.1 alone binds the S3 gateway
# to host loopback, and the containers reach the store over host.docker.internal
# (the docker bridge gateway IP) — run 43304280372 died in phase 1 exactly
# there ("fetch failed" on the put/get round-trip after five green topology
# assertions). The master keeps advertising 127.0.0.1 to itself; the S3 port
# must answer on every interface.
/tmp/weed server -dir=/tmp/seaweed-data -ip=127.0.0.1 -ip.bind=0.0.0.0 -master.port=9333 -volume.port=8080 \
  -s3 -s3.port=9000 -s3.config=/tmp/seaweed-s3.json >/tmp/seaweed.log 2>&1 &
MINIO_PID=$!

MINIO_OK=false
for i in $(seq 1 45); do
  # any HTTP response (even 403 for the anonymous root) proves the gateway lives
  if curl -s -o /dev/null --max-time 2 http://127.0.0.1:9000/ ; then MINIO_OK=true; break; fi
  sleep 1
done
if [ "$MINIO_OK" != true ]; then
  echo "[smoke] FAIL: the SeaweedFS S3 gateway never became healthy"
  tail -20 /tmp/seaweed.log || true
  exit 1
fi
echo "[smoke] SeaweedFS S3 gateway healthy (host process, :9000)"

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

# The acceptance walk's HTTP leg — through the REAL routes on the REAL
# topology (fresh database: open registration, no legacy claim gate).
echo "[smoke] HTTP walk: register → login → create project"
curl -fsS -X POST http://localhost:3000/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"name":"Smoke Operator","email":"smoke@example.com","password":"smoke-pass-123"}' >/dev/null
echo "[smoke]   registered smoke@example.com"
curl -fsS -c /tmp/smoke-cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"smoke@example.com","password":"smoke-pass-123"}' >/dev/null
echo "[smoke]   logged in (session cookie captured)"
curl -fsS -b /tmp/smoke-cookies.txt -X POST http://localhost:3000/api/videos \
  -H 'content-type: application/json' \
  -d '{"topic":"Docker smoke","niche":"smoke","format":"classic"}' >/dev/null
echo "[smoke]   created the project through POST /api/videos"

echo "[smoke] phase 1 — topology reality: migrations, columns, MinIO round-trip, cross-process job"
"${COMPOSE[@]}" exec -T web node --import tsx scripts/smoke-walk.mts --phase 1

echo "[smoke] stopping the worker — seeding the recovery scenario while it is DOWN"
"${COMPOSE[@]}" stop worker
"${COMPOSE[@]}" exec -T web node --import tsx scripts/smoke-walk.mts --phase 2

echo "[smoke] starting the worker — the reaper + claimer must land both jobs"
"${COMPOSE[@]}" start worker
"${COMPOSE[@]}" exec -T web node --import tsx scripts/smoke-walk.mts --phase 3

echo "[smoke] PASS — the production topology walked end-to-end"
