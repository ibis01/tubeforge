"use client";

// AuthGate — the Stage 2 account gate (register / sign-in).
//
// The page shell stays public (it is just the client bundle); every piece of
// data flows through /api/* which the middleware locks behind a signed
// session. Until the browser holds a valid session, this component replaces
// the entire app with the TubeForge account screen:
//   * no account exists yet -> registration (the FIRST account on a legacy
//     install must also prove the old studio password — the server enforces
//     this and tells us via status.legacyClaim.required)
//   * otherwise -> email + password sign-in
//   * a live session -> straight into the studio.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TubeForgeLogo } from "@/components/tubeforge/logo";
import { Loader2, LogOut, ShieldCheck, Eye, EyeOff, UserPlus, KeyRound } from "lucide-react";

type GateState = "checking" | "signedOut" | "register" | "open" | "error";

interface StatusResponse {
  configured: boolean;
  authenticated: boolean;
  user: { email: string; name: string | null } | null;
  organization: { name: string } | null;
  legacyClaim: { required: boolean } | null;
}

/** Sidebar & friends listen for this to know whether the gate is active. */
export function broadcastGateState(enabled: boolean) {
  window.dispatchEvent(new CustomEvent("tf-gate", { detail: { enabled } }));
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>("checking");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [needsLegacy, setNeedsLegacy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [legacy, setLegacy] = useState("");

  const refresh = useCallback(async (): Promise<GateState> => {
    try {
      const res = await fetch("/api/auth/status", { cache: "no-store" });
      const d = (await res.json()) as StatusResponse;
      setNeedsLegacy(Boolean(d.legacyClaim?.required));
      if (d.authenticated) return "open";
      setMode(d.configured ? "login" : "register");
      return "signedOut";
    } catch {
      return "error"; // can't reach the status endpoint — don't brick the UI
    }
  }, []);

  useEffect(() => {
    void refresh().then((s) => {
      setState(s);
      broadcastGateState(s !== "error");
    });
  }, [refresh]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === "register") {
      if (password.length < 8)
        return setError("Use at least 8 characters — this protects your pipeline and API keys.");
      if (password !== confirm) return setError("The two passwords do not match.");
    }

    setBusy(true);
    try {
      const endpoint = mode === "register" ? "/api/auth/register" : "/api/auth/login";
      const body =
        mode === "register"
          ? {
              name: name.trim() || undefined,
              email: email.trim(),
              password,
              ...(needsLegacy && legacy ? { legacyPassword: legacy } : {}),
            }
          : { email: email.trim(), password };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await res.json().catch(() => ({}))) as {
        error?: string;
        legacyClaimRequired?: boolean;
        verification?: { url?: string };
      };
      if (!res.ok) {
        if (d.legacyClaimRequired) setNeedsLegacy(true);
        setError(d.error ?? "Something went wrong — try again.");
        return;
      }
      if (d.verification?.url) {
        // Console email mode: verify in the background so the account is
        // fully activated (no SMTP until Stage 3).
        void fetch(d.verification.url, { cache: "no-store" }).catch(() => {});
      }
      setPassword("");
      setConfirm("");
      setLegacy("");
      setState("open");
      broadcastGateState(true);
      window.location.reload(); // drop any stale client caches
    } catch {
      setError("Network error — check your connection and retry.");
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setState((await refresh()) === "open" ? "open" : "signedOut");
    // Hard reload so every client cache drops its (now-401) data.
    window.location.reload();
  };

  if (state === "checking") {
    // Brief splash while the session state resolves.
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4 animate-pulse">
          <TubeForgeLogo size={56} />
          <p className="text-sm text-muted-foreground">Warming up the forge…</p>
        </div>
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

  // ---- signed out / register / error ----
  return (
    <div className="min-h-screen flex items-center justify-center bg-background bg-grid px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-8 text-center">
          <TubeForgeLogo size={64} />
          <h1 className="text-2xl font-bold tracking-tight">
            Tube<span className="text-gradient">Forge</span>
          </h1>
          <p className="text-sm text-muted-foreground max-w-xs">
            {mode === "register"
              ? "Create your account — your own studio, pipeline and settings, isolated from every other user."
              : "Sign in to reach your pipeline, library and settings."}
          </p>
        </div>

        <form
          onSubmit={submit}
          className="glass rounded-2xl border border-white/10 p-6 space-y-4"
        >
          {mode === "register" && (
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name (optional)"
              autoComplete="name"
              aria-label="Your name"
            />
          )}

          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@studio.com"
            autoComplete="email"
            required
            aria-label="Email"
          />

          <div className="relative">
            <Input
              type={reveal ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "register" ? "Password (8+ characters)" : "Password"}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              required
              className="pr-10"
              aria-label="Password"
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

          {mode === "register" && (
            <Input
              type={reveal ? "text" : "password"}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat the password"
              autoComplete="new-password"
              required
              aria-label="Repeat the password"
            />
          )}

          {mode === "register" && needsLegacy && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs text-amber-300/90">
                <KeyRound className="h-3.5 w-3.5" />
                <span>
                  This studio is upgrading from a locked single-user install — the first
                  account must also prove the CURRENT access password.
                </span>
              </div>
              <Input
                type={reveal ? "text" : "password"}
                value={legacy}
                onChange={(e) => setLegacy(e.target.value)}
                placeholder="Current studio access password"
                autoComplete="current-password"
                aria-label="Current studio access password"
              />
            </div>
          )}

          {error && (
            <p role="alert" className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <Button
            type="submit"
            disabled={busy || !email || !password}
            className="w-full bg-brand-gradient hover:opacity-90 text-white font-semibold"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : mode === "register" ? (
              <>
                <UserPlus className="h-4 w-4 mr-1.5" /> Create account
              </>
            ) : (
              "Sign in"
            )}
          </Button>

          <button
            type="button"
            onClick={() => {
              setError(null);
              setMode(mode === "login" ? "register" : "login");
            }}
            className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {mode === "login"
              ? "No account yet? Create one"
              : "Already registered? Sign in instead"}
          </button>

          <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground pt-1">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
            Sessions are HttpOnly + signed; every API route is tenant-scoped.
          </p>
        </form>
      </div>
    </div>
  );
}
