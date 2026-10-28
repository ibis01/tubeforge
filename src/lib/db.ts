import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// `query` logging emits every SQL statement (with bound parameters — emails,
// token hashes, video topics…) into the logs and bloats log volume. Keep it
// for development only; production logs errors and can opt back in with
// TUBEFORGE_LOG_QUERIES=1 when a narrowly-scoped diagnostic is actually
// needed (pair it with the deployment's redaction/retention policy).
const logQueries =
  process.env.NODE_ENV !== 'production' || process.env.TUBEFORGE_LOG_QUERIES === '1'

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: logQueries ? ['query', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db