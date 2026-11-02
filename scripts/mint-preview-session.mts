// Mint a local preview session for the registered preview user and write
// the raw session token to /tmp/tf-session.txt (chmod 600, never logged).
// Used to verify the preview CSRF origin gate end-to-end via curl.
import fs from "fs";

const { PrismaClient } = await import("@prisma/client");
const tenant = await import("../src/lib/tubeforge/tenant");

const db = new PrismaClient();
try {
  const user = await db.user.findFirstOrThrow({ where: { email: "ibis01abc@gmail.com" } });
  const membership = await db.membership.findFirstOrThrow({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
  });
  const session = await tenant.createSessionRecord({
    userId: user.id,
    organizationId: membership.organizationId,
    userAgent: "preview-wire-cli",
  });
  const token = await tenant.createSessionToken(user.id, session.id);
  if (!token) throw new Error("token mint failed — is TUBEFORGE_AUTH_SECRET set?");
  fs.writeFileSync("/tmp/tf-session.txt", token, { mode: 0o600 });
  console.log("session minted:", session.id.slice(0, 8) + "…", "token → /tmp/tf-session.txt");
} finally {
  await db.$disconnect();
}
