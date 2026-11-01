// TubeForge auth reset — Stage 2 edition (ARCHITECTURE.md §6.3).
//
// The old global lock toggle is gone with multi-user auth. This is now a
// server-side CLI that resets ONE USER's password by email: it prints a
// one-time reset link (same flow as POST /api/auth/reset-password) or, with
// --set <newpassword>, sets the password directly and revokes every live
// session of that user.
//
// Usage:
//   npm run auth:reset -- --email someone@example.com
//        -> prints a one-time reset link (valid 24h)
//   npm run auth:reset -- --email someone@example.com --set NewPassword123
//        -> sets the password immediately + revokes all sessions
//
// Uses the generated Prisma client, so it works for BOTH database modes
// (SQLite local dev and Postgres) without duplicating schema knowledge here.

import path from "node:path";
import { createHash, webcrypto } from "node:crypto";

const argv = process.argv.slice(2);
const emailIdx = argv.indexOf("--email");
const setIdx = argv.indexOf("--set");
const email = emailIdx >= 0 ? argv[emailIdx + 1]?.trim().toLowerCase() : "";
const newPassword = setIdx >= 0 ? argv[setIdx + 1] : undefined;

// Mirror of tenant.ts PBKDF2 hashing (scripts cannot import TS modules) —
// identical format: pbkdf2$<iters>$<saltB64>$<hashB64>.
const PBKDF2_ITERS = 120_000;

async function hashPassword(password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const hash = await webcrypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const b64 = (bytes) => Buffer.from(bytes).toString("base64");
  return `pbkdf2$${PBKDF2_ITERS}$${b64(salt)}$${b64(new Uint8Array(hash))}`;
}

function randomToken() {
  return webcrypto.getRandomValues(new Uint8Array(24)).toString("base64url");
}

const hashHex = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const RESET_TTL_H = 24;

async function main() {
  if (!email) {
    console.error("[auth:reset] usage: npm run auth:reset -- --email <email> [--set <newpassword>]");
    process.exit(1);
  }

  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();

  try {
    const user = await db.user.findUnique({ where: { email } });
    if (!user) {
      console.error(`[auth:reset] no account with email ${email}`);
      process.exit(1);
    }

    if (newPassword) {
      if (newPassword.length < 8) {
        console.error("[auth:reset] password must be at least 8 characters");
        process.exit(1);
      }
      await db.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(newPassword) },
      });
      await db.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      console.log(`[auth:reset] password set for ${email}; all sessions revoked`);
      return;
    }

    const token = randomToken();
    await db.user.update({
      where: { id: user.id },
      data: {
        passwordResetTokenHash: hashHex(token),
        passwordResetExpiresAt: new Date(Date.now() + RESET_TTL_H * 3600_000),
      },
    });
    console.log(`[auth:reset] reset link for ${email} (valid ${RESET_TTL_H}h):`);
    console.log(`  /api/auth/reset-password -> POST { "token": "${token}", "password": "..." }`);
    console.log("  (feed the token + a new password to the endpoint, or rerun with --set)");
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error("[auth:reset] failed:", err?.message ?? err);
  console.error("         (did `npm install` run? The Prisma client must be generated first.)");
  process.exit(1);
});
