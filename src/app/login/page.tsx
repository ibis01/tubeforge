"use client";

// /login — the unlock screen shown when the app lock (TUBEFORGE_ACCESS_TOKEN)
// is configured. Reads ?next=… so signing in returns the user to where the
// middleware intercepted them.

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ForgeMark } from "@/components/tubeforge/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, LockKeyhole } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/auth/status", { cache: "no-store" });
        const data = (await res.json()) as { locked: boolean; authenticated: boolean };
        if (!alive) return;
        const next = new URLSearchParams(window.location.search).get("next") ?? "/";
        if (!data.locked) {
          router.replace("/");
          return;
        }
        if (data.authenticated) {
          router.replace(next.startsWith("/") ? next : "/");
          return;
        }
      } catch {
        // status unreachable — stay on the form and let the user try
      }
      if (alive) setChecking(false);
    })();
    return () => {
      alive = false;
    };
  }, [router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Sign-in failed — try again");
        setBusy(false);
        return;
      }
      const next = new URLSearchParams(window.location.search).get("next") ?? "/";
      router.replace(next.startsWith("/") ? next : "/");
      router.refresh();
    } catch {
      setError("Network error — is the server running?");
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 relative overflow-hidden">
      {/* Ambient glow, same dark-premium language as the app */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 h-96 w-[42rem] rounded-full bg-primary/20 blur-[120px]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-grid opacity-[0.35]"
      />

      <main className="relative w-full max-w-sm">
        <div className="glass rounded-2xl p-8 shadow-2xl">
          <div className="flex flex-col items-center text-center">
            <ForgeMark className="h-16 w-16 drop-shadow-[0_0_24px_rgba(255,90,20,0.45)]" />
            <h1 className="mt-4 text-2xl font-bold tracking-tight">
              Tube<span className="text-gradient">Forge</span>
            </h1>
            <p className="mt-1.5 text-[10px] uppercase tracking-[0.35em] text-muted-foreground">
              Ideas → Videos → Impact
            </p>
          </div>

          <div className="mt-8">
            {checking ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Checking the lock…
              </div>
            ) : (
              <form onSubmit={onSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <label
                    htmlFor="unlock-code"
                    className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
                  >
                    <LockKeyhole className="h-3.5 w-3.5" />
                    This studio is locked — enter your unlock code
                  </label>
                  <Input
                    id="unlock-code"
                    type="password"
                    inputMode="text"
                    autoComplete="current-password"
                    autoFocus
                    placeholder="Unlock code"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    className="h-11 bg-black/30"
                    aria-invalid={Boolean(error)}
                  />
                </div>

                {error && (
                  <p role="alert" className="text-xs text-destructive animate-pulse-dot">
                    {error}
                  </p>
                )}

                <Button
                  type="submit"
                  disabled={busy || token.length === 0}
                  className="w-full h-11 font-semibold"
                >
                  {busy ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Unlocking…
                    </>
                  ) : (
                    "Unlock studio"
                  )}
                </Button>
              </form>
            )}
          </div>
        </div>

        <p className="mt-4 text-center text-[11px] text-muted-foreground leading-relaxed">
          The code is the <code className="text-foreground">TUBEFORGE_ACCESS_TOKEN</code> value
          in your <code className="text-foreground">.env</code> file.
        </p>
      </main>
    </div>
  );
}
