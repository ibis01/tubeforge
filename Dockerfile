# TubeForge — production image (Stage 3, T-3.12).
#
# ONE image, TWO roles (docker-compose.yml / fly.toml pick the command):
#   web    → node .next/standalone/server.js      (Next.js standalone, port 3000)
#   worker → node --import tsx scripts/worker.mts (durable queue worker)
#
# The image carries the full runtime (src + scripts + node_modules + prisma)
# rather than a minimal standalone copy: the worker imports TypeScript
# sources live (tsx) and the web role shares the same layer — one thing to
# build, scan and roll back. ffmpeg + ffprobe are runtime requirements
# (render pipeline, audio conditioning, QC probing) and ship in the image.
#
# Build:  docker build -t tubeforge .
# Run:    see docker-compose.yml

# ---------- 1. deps ----------
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ---------- 2. build ----------
FROM node:20-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Prisma needs a DATABASE_URL at generate time — any syntactically valid one.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generate the Postgres client (the production schema) before building.
RUN npx prisma generate --schema prisma/schema.prisma
RUN npx next build

# ---------- 3. runtime ----------
FROM node:20-bookworm-slim AS runner
WORKDIR /app

# ffmpeg/ffprobe (render + QC), ca-certificates (TLS to providers/S3),
# tini (zombie reaping under container init quirkiness — belt to proc.ts's
# suspenders), fonts (Playwright slides fallback — no browser here, the
# container host mounts one when slide rendering is enabled).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates tini fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    TINI_SUBREAPER=1

# Non-root user.
RUN groupadd -g 1001 tubeforge && useradd -u 1001 -g tubeforge -m tubeforge

# Prisma engines + runtime node_modules (runtime deps only; prisma CLI stays
# for `migrate deploy` at container start).
COPY --from=build --chown=tubeforge:tubeforge /app/node_modules ./node_modules
# Prune dev-only weight that survives npm ci in the deps stage.
COPY --from=build --chown=tubeforge:tubeforge /app/package.json ./package.json
COPY --from=build --chown=tubeforge:tubeforge /app/package-lock.json ./package-lock.json

# Application code: standalone server (web role)…
COPY --from=build --chown=tubeforge:tubeforge /app/.next/standalone ./.next/standalone
COPY --from=build --chown=tubeforge:tubeforge /app/.next/static ./.next/standalone/.next/static
COPY --from=build --chown=tubeforge:tubeforge /app/public ./.next/standalone/public
# …and the worker role sources.
COPY --from=build --chown=tubeforge:tubeforge /app/src ./src
COPY --from=build --chown=tubeforge:tubeforge /app/scripts ./scripts
COPY --from=build --chown=tubeforge:tubeforge /app/prisma ./prisma
COPY --from=build --chown=tubeforge:tubeforge /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=tubeforge:tubeforge /app/next.config.ts ./next.config.ts

# Scratch + uploads roots (mount a volume at /app/uploads on local storage).
RUN mkdir -p /app/uploads /app/db && chown -R tubeforge:tubeforge /app/uploads /app/db
VOLUME ["/app/uploads"]

USER tubeforge
EXPOSE 3000

# Web role by default; the worker overrides the command in compose/fly.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", ".next/standalone/server.js"]

# Healthcheck — the web role answers; the worker overrides with a process
# check in compose (its port never opens).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/auth/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
