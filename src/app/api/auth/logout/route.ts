import { NextResponse } from "next/server";
import { clearedSessionCookie } from "@/lib/tubeforge/auth";

/** POST — sign out (clears the session cookie). */
export async function POST() {
  const res = NextResponse.json({ ok: true, authenticated: false });
  res.cookies.set(clearedSessionCookie());
  return res;
}
