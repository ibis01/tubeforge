// S13 prelude — the owner's key: the login stopped answering, so this mints
// a fresh password hash with the app's OWN hashPassword (same PBKDF2 shape
// the register route writes: pbkdf2$120000$salt$hash) and writes it to the
// owner row, plus consumes any stale reset/verify tokens so nothing dangles.
// Run: node --import tsx scripts/s13-owner-password-reset.mts <newPassword>
import { hashPassword } from "../src/lib/tubeforge/tenant";
import { PrismaClient } from "@prisma/client";

const EMAIL = "ibis01abc@gmail.com";
const password = process.argv[2];
if (!password || password.length < 8) {
  console.error("usage: s13-owner-password-reset.mts <newPassword (>= 8 chars)>");
  process.exit(1);
}

const db = new PrismaClient();
try {
  const hash = await hashPassword(password);
  const user = await db.user.update({
    where: { email: EMAIL },
    data: {
      passwordHash: hash,
      passwordResetTokenHash: null, // stale reset links die with the old password
      passwordResetExpiresAt: null,
    },
  });
  console.log("OK password reset for", user.email);
  console.log("hash shape:", hash.slice(0, 22) + "…");
} finally {
  await db.$disconnect();
}
