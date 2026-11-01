// Tenant-scoped Prisma client — THE multi-tenant data guard (R-CRIT-1).
//
// `db` exported here behaves exactly like the raw client EXCEPT: when a tenant
// context is active (requireUser() entered it, or a job body inherited it from
// the request that spawned it), every query on an ORGANIZATION-scoped model is
// transparently filtered by organizationId:
//
//   reads      (findUnique/findFirst/findMany/count/aggregate/groupBy)
//              -> where.organizationId = ctx.organizationId
//   creates    -> data.organizationId = ctx.organizationId (mismatch throws)
//   writes     (update/delete, incl. many-variants and upsert)
//              -> where.organizationId = ctx.organizationId
//   Activity/Job creates also stamp data.userId (audit trail).
//
// Without a context (auth bootstrap, scripts, boot recovery) it is a
// pass-through of the raw client — those paths are the explicit, audited
// exceptions (src/app/api/auth/** is allow-listed in the ESLint rule
// tf/no-raw-db-in-api; everything else under src/app MUST import from here).
//
// findUnique keeps its unique-key semantics: the extra non-unique
// organizationId filter rides along in the same where (Prisma extended where
// unique), so a guessed id from another tenant resolves to null — exactly the
// 404 behavior cross-tenant access must produce.

import { db as rawDb } from "@/lib/db";
import { currentCtx } from "./tenant";

// Models whose rows belong to an organization (content + membership).
// T-4.14 regression fix: the $allOperations hook lowercases the Prisma model
// name before this lookup — the Stage 2 list carried camelCase entries
// ("researchSession", "scheduleSlot", "videoStat", "voiceProfile",
// "musicTrack") which NEVER matched, silently leaving those five models
// unscoped (cross-tenant leak caught by the Stage 4b sweep). The set is now
// lowercase-normalized at construction and pinned by a unit test.
export const ORG_SCOPED_MODELS = new Set(
  [
    "channel",
    "character",
    "video",
    "activity",
    "researchSession",
    "scheduleSlot",
    "videoStat",
    "voiceProfile",
    "musicTrack",
    "job",
    "membership",
  ].map((m) => m.toLowerCase())
);

// Models whose creates also stamp the acting user (audit trail).
const USER_STAMPED_MODELS = new Set(["activity", "job"]);

const READ_OPS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

/* eslint-disable @typescript-eslint/no-explicit-any */
function scopeRead(args: any, organizationId: string): void {
  args.where = { ...(args.where ?? {}), organizationId };
}

function scopeWrite(args: any, organizationId: string): void {
  args.where = { ...(args.where ?? {}), organizationId };
}

function scopeCreateData(data: any, organizationId: string, userId: string | undefined, model: string): void {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    if (data.organizationId && data.organizationId !== organizationId) {
      throw new Error(
        `tenant-db: create carries organizationId=${String(data.organizationId)} but the acting tenant is ${organizationId} — refusing the cross-tenant write`
      );
    }
    data.organizationId = organizationId;
    if (userId && USER_STAMPED_MODELS.has(model) && !data.userId) data.userId = userId;
  }
}

function tenantMismatch(model: string, operation: string): Error {
  return new Error(
    `tenant-db: ${model}.${operation} carries a different organizationId than the acting tenant — refusing the cross-tenant write`
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const db = rawDb.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const ctx = currentCtx();
        // Prisma passes the SCHEMA model name ("Video"), the client property
        // is camelCase ("video") — normalize so both conventions match.
        const modelKey = String(model).toLowerCase();
        if (ctx && ORG_SCOPED_MODELS.has(modelKey)) {
          /* eslint-disable @typescript-eslint/no-explicit-any */
          const a = args as any;
          switch (operation) {
            case "findUnique":
            case "findUniqueOrThrow":
            case "findFirst":
            case "findFirstOrThrow":
            case "findMany":
            case "count":
            case "aggregate":
            case "groupBy":
              scopeRead(a, ctx.organizationId);
              break;
            case "create":
              scopeCreateData(a.data, ctx.organizationId, ctx.userId, modelKey);
              break;
            case "createMany":
              if (Array.isArray(a.data)) {
                for (const row of a.data) scopeCreateData(row, ctx.organizationId, ctx.userId, modelKey);
              }
              break;
            case "update":
            case "updateMany":
            case "delete":
            case "deleteMany":
              if (
                a.where?.organizationId &&
                a.where.organizationId !== ctx.organizationId
              ) {
                throw tenantMismatch(model, operation);
              }
              scopeWrite(a, ctx.organizationId);
              break;
            case "upsert": {
              if (
                a.where?.organizationId &&
                a.where.organizationId !== ctx.organizationId
              ) {
                throw tenantMismatch(model, operation);
              }
              scopeWrite(a, ctx.organizationId);
              scopeCreateData(a.create, ctx.organizationId, ctx.userId, modelKey);
              break;
            }
            default:
              break;
          }
          /* eslint-enable @typescript-eslint/no-explicit-any */
        }
        return query(args);
      },
    },
  },
});

/** The un-scoped client — ONLY for auth bootstrap, scripts and boot recovery. */
export const rawDatabase = rawDb;

export type TenantDb = typeof db;
