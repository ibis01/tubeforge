"use client";

// AuthGate — the lock screen. The page shell stays public (it is just the
// client bundle); every piece of data flows through /api/* which the edge
// middleware locks with a signed session. Until the browser holds a valid
// session, this component replaces the entire app with the TubeForge lock.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TubeForgeLogo } from "@/components/tubeforge/logo";
import { Lock, LogOut, ShieldCheck, Loader2, Eye, EyeOff } from "lucide-react";

type AuthState = "checking" | "locked" | "setup" | "open" | "disabled";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<AuthState> => {
    try {
      const res = await fetch("/api/auth/status", { cache: "no-store" });
      const d = (await res.json()) as {
        configured: boolean;
        authenticated: boolean;
        gateEnabled: boolean;
      };
      if (!d.gateEnabled) return "disabled";
      if (d.authenticated) return "open";
      return d.configured ? "locked" : "setup";
    } catch {
      return "disabled"; // can't reach the status endpoint — don't brick the UI
    }
  }, []);

  useEffect(() => {
    void refresh().then(setState);
  }, [refresh]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (state === "setup") {
      if (password.length < 8)
        return setError("Use at least 8 characters — this gates your API keys and uploads.");
      if (password !== confirm) return setError("The two passwords do not match.");
    }

    setBusy(true);
    try {
      const res = await fetch(state === "setup" ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(d.error ?? "Something went wrong — try again.");
        return;
      }
      setPassword("");
      setConfirm("");
      setState("open");
    } catch {
      setError("Network error — check your connection and retry.");
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setState((await refresh()) === "open" ? "open" : "locked");
    // Hard reload so every client cache drops its (now-401) data.
    window.location.reload();
  };

  if (state === "checking" || state === "disabled") {
    // Splash while the lock state resolves (or when auth is disabled for dev).
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4 animate-pulse">
          <TubeForgeLogo size={56} />
          <p className="text-sm text-muted-foreground">
            {state === "checking" ? "Warming up the forge…" : "Auth gate disabled — set TUBEFORGE_AUTH_SECRET"}
          </p>
        </div>
        {state === "disabled" && children}
      </div>
    );
  }

  if (state === "open") {
    return (
      <>
        {children}
        {/* Screen-reader-friendly sign-out — also surfaced in the sidebar */}
        <button onClick={logout} className="sr-only" aria-label="Sign out">
          Sign out
        </button>
      </>
    );
  }

  // ---- Locked / first-run setup ----
  return (
    <div className="min-h-screen flex items-center justify-center bg-background bg-grid px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-8 text-center">
          <TubeForgeLogo size={64} />
          <h1 className="text-2xl font-bold tracking-tight">
            Tube<span className="text-gradient">Forge</span>
          </h1>
          <p className="text-sm text-muted-foreground max-w-xs">
            {state === "setup"
              ? "First run — create the access password that protects this studio, your API keys and your channel."
              : "This studio is locked. Sign in to reach your pipeline, library and settings."}
          </p>
        </div>

        <form
          onSubmit={submit}
          className="glass rounded-2xl border border-white/10 p-6 space-y-4"
        >
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Lock className="h-3.5 w-3.5 text-primary" />
            <span>
              {state === "setup" ? "Create access password" : "Enter access password"}
            </span>
          </div>

          <div className="relative">
            <Input
              type={reveal ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Access password"
              autoFocus
              autoComplete={state === "setup" ? "new-password" : "current-password"}
              className="pr-10"
              aria-label="Access password"
            />
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-muted-foreground hover:text-foreground rounded-md"
              aria-label={reveal ? "Hide password" : "Show password"}
            >
              {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          {state === "setup" && (
            <Input
              type={reveal ? "text" : "password"}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat the password"
              autoComplete="new-password"
              aria-label="Repeat the password"
            />
          )}

          {error && (
            <p role="alert" className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <Button
            type="submit"
            disabled={busy || !password}
            className="w-full bg-brand-gradient hover:opacity-90 text-white font-semibold"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : state === "setup" ? "Create password & enter" : "Unlock the studio"}
          </Button>

          <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground pt-1">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
            Sessions are HttpOnly + signed; API routes reject anyone without one.
          </p>
        </form>
      </div>
    </div>
  );
}
