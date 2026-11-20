// Prisma 7 config (the P1012 migration): schema files no longer carry
// connection URLs — the CLI (migrate/db push/generate) reads the datasource
// URL from here, and the RUNTIME client (src/lib/db.ts) builds driver
// adapters per protocol. dotenv is bundled with @prisma/config.
import { defineConfig, env } from "@prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
