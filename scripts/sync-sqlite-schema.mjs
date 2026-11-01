#!/usr/bin/env node
// Regenerate prisma/schema.sqlite.prisma from prisma/schema.prisma.
//
// The SQLite file is the local-development mirror of the PostgreSQL deployment
// schema (SETUP.md "Local development (SQLite)"). It used to be hand-copied and
// drifted within one sprint (VoiceProfile comment drift, found by the Stage 1
// audit). This script is the single source of truth: edit schema.prisma, then
// run `npm run db:sync-sqlite` (setup:local and postinstall call it too) so
// the mirror can never drift again.
//
// Transformations (provider line only — field definitions are copied verbatim):
//   datasource db { provider = "postgresql" ... }  ->  provider = "sqlite"

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const source = path.join(root, "prisma", "schema.prisma");
const target = path.join(root, "prisma", "schema.sqlite.prisma");

const header = `// GENERATED from schema.prisma by scripts/sync-sqlite-schema.mjs — DO NOT EDIT.
// Regenerate with: npm run db:sync-sqlite (also run by setup:local / postinstall).
// Provider swapped to SQLite for local development; every field definition is
// a verbatim copy of schema.prisma (the PostgreSQL deployment schema).

`;

const pg = fs.readFileSync(source, "utf8");
const sqlite = pg.replace(
  /datasource db \{\s*provider = "postgresql"/,
  'datasource db {\n  provider = "sqlite"'
);
if (sqlite === pg) {
  console.error("[sync-sqlite-schema] could not find the postgresql datasource block — schema.prisma changed shape?");
  process.exit(1);
}
fs.writeFileSync(target, header + sqlite);
console.log("[sync-sqlite-schema] wrote prisma/schema.sqlite.prisma (%d lines)", sqlite.split("\n").length);
