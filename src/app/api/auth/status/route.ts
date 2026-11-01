import { NextRequest, NextResponse } from "next/server";
import { rawDatabase as rawDb } from "@/lib/tubeforge/tenant-db";
import { resolveRequestUser } from "@/lib/tubeforge/tenant";
import { pendingLegacyRows } from "@/lib/tubeforge/claim";

/**
 * GET — session state for the client gate:
 *   configured    any account exists (vs. first-run registration)
 *   authenticated this browser holds a live session
 *   user/organization identity of the signed-in caller
 *   legacyClaim    the FIRST registration must prove the old studio password
 */
export async function GET(req: NextRequest) {
  const userCount = await rawDb.user.count().catch(() => 0);
  const ctx = await resolveRequestUser(req).catch(() => null);

  let user: { id: string; email: string; name: string | null; emailVerified: boolean } | null = null;
  let organization: { id: string; name: string; role: string } | null = null;
  if (ctx) {
    const row = await rawDb.user.findUnique({ where: { id: ctx.userId } });
    const org = await rawDb.organization.findUnique({ where: { id: ctx.organizationId } });
    if (row && org) {
      user = {
        id: row.id,
        email: row.email,
        name: row.name,
        emailVerified: Boolean(row.emailVerifiedAt),
      };
      organization = { id: org.id, name: org.name, role: ctx.role };
    }
  }

  const legacy = userCount === 0 ? await pendingLegacyRows().catch(() => null) : null;

  return NextResponse.json({
    configured: userCount > 0,
    authenticated: Boolean(ctx && user),
    user,
    organization,
    legacyClaim: legacy ? { required: legacy.hasPassword } : null,
  });
}
