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
import { Loader2, ShieldCheck, Eye, EyeOff, UserPlus, KeyRound, ArrowLeft, MailCheck } from "lucide-react";
type GateState = "checking" | "signedOut" | "register" | "open" | "error";

// S18 — the recovery. The two-step reset route (/api/auth/reset-password)
// existed since Stage 2 with NO caller: a user who forgot the password had
// only the offline script. The login screen now carries the whole flow:
// request by email → (console mode hands the link straight back — the
// single-owner house pattern; smtp: “check your inbox” + paste field) →
// set the new password → every session dies, sign in with the new one.
type Flow = "signin" | "recover";

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

  // S18 — the recovery flow's state (only reachable from LOGIN mode: a
  // register-mode gate has no accounts, nothing to recover).
  const [flow, setFlow] = useState<Flow>("signin");
  const [recoverStep, setRecoverStep] = useState<1 | 2>(1);
  const [recoverEmail, setRecoverEmail] = useState("");
  const [recoverToken, setRecoverToken] = useState(""); // a pasted LINK or the bare token
  const [recoverPw, setRecoverPw] = useState("");
  const [recoverPw2, setRecoverPw2] = useState("");
  const [recoverLink, setRecoverLink] = useState<string | null>(null); // console mode shows it
  const [recoverDone, setRecoverDone] = useState(false);
  const [recoverBusy, setRecoverBusy] = useState(false);

  // S21 — the emailed verification link lands as /?verified=ok|expired|missing
  // (the route's GET redirects here instead of answering raw JSON). The gate
  // translates the outcome into a plain-language note and scrubs the URL.
  const [verifiedNote, setVerifiedNote] = useState<null | "ok" | "expired" | "missing">(null);

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
      // S18 — an EMAILED reset link lands as /?reset=<token> (the route's GET
      // redirects here). A signed-out browser opens the confirm form
      // pre-filled; a signed-in one ignores it (that user has S16's change-
      // password surface) — either way the token leaves the URL.
      const token = new URLSearchParams(window.location.search).get("reset");
      if (token) {
        window.history.replaceState(null, "", "/");
        if (s === "signedOut") {
          setFlow("recover");
          setRecoverStep(2);
          setRecoverToken(token);
        }
      }
      // S21 — the verification landing: same pattern as the reset token.
      const verified = new URLSearchParams(window.location.search).get("verified");
      if (verified === "ok" || verified === "expired" || verified === "missing") {
        window.history.replaceState(null, "", "/");
        if (s === "signedOut") setVerifiedNote(verified);
        // a signed-in browser sees its verification state on the security card
      }
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
        // Console email mode: verify BEFORE the reload. Fire-and-forget gets
        // aborted by the navigation right below — the account would stay
        // unverified forever (S21: the confirmed address).
        await fetch(d.verification.url, { cache: "no-store" }).catch(() => {});
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

  // ---- S18: the recovery submit handlers ----
  /** A pasted reset LINK or a bare token — extract the token either way. */
  const tokenFrom = (raw: string): string => {
    const t = raw.trim();
    if (t.includes("token=")) {
      try {
        return new URL(t).searchParams.get("token") ?? t;
      } catch {
        return new URLSearchParams(t.split("?")[1] ?? "").get("token") ?? t;
      }
    }
    return t;
  };

  // Step 1 — request the link by email. Unknown addresses answer 200 with
  // no link (enumeration stays blind); console mode returns the link for a
  // real account — the gate jumps straight to step 2 with the token in hand.
  const requestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setRecoverBusy(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: recoverEmail.trim() }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        error?: string;
        reset?: { url?: string; expiresHours?: number };
      };
      if (!res.ok) throw new Error(d.error ?? "Could not request the reset");
      setRecoverLink(d.reset?.url ?? null);
      if (d.reset?.url) {
        setRecoverToken(tokenFrom(d.reset.url));
        setRecoverStep(2);
      } else {
        // smtp mode (or an unknown address — indistinguishable by design):
        // the link went to the inbox; the paste field below takes it.
        setRecoverToken("");
        setRecoverStep(2);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error — try again.");
    } finally {
      setRecoverBusy(false);
    }
  };

  // Step 2 — prove the token, set the new password. On success every live
  // session of the account dies (the route revokes them all); the gate
  // flips back to sign-in with the email kept.
  const confirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (recoverPw.length < 8) return setError("The new password needs at least 8 characters.");
    if (recoverPw !== recoverPw2) return setError("The two new passwords do not match.");
    const token = tokenFrom(recoverToken);
    if (token.length < 10) return setError("Paste the reset link (or its token) first.");
    setRecoverBusy(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: recoverPw }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Could not set the new password");
      setRecoverDone(true);
      setRecoverPw("");
      setRecoverPw2("");
      setRecoverToken("");
      setRecoverLink(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error — try again.");
    } finally {
      setRecoverBusy(false);
    }
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
            {flow === "recover"
              ? "Recover the account — request a reset link, then set a new password. Every device gets signed out."
              : mode === "register"
                ? "Create your account — your own studio, pipeline and settings, isolated from every other user."
                : "Sign in to reach your pipeline, library and settings."}
          </p>
        </div>

        {/* S21 — the verification landing note (a clicked email link ends here) */}
        {verifiedNote && (
          <div
            className={
              verifiedNote === "ok"
                ? "rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-300 mb-4"
                : "rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-300 mb-4"
            }
            role="status"
          >
            {verifiedNote === "ok"
              ? "Email confirmed — this address is now trusted for account recovery."
              : verifiedNote === "expired"
                ? "That verification link expired or was already used — sign in and send a fresh one from Settings → Security."
                : "That verification link was malformed — sign in and send a fresh one from Settings → Security."}
          </div>
        )}

        {/* S18 — the recovery flow replaces the card (only from LOGIN mode:
            a register-mode gate has no accounts, nothing to recover). */}
        {flow === "recover" && recoverStep === 1 && (
          <form onSubmit={requestReset} className="glass rounded-2xl border border-white/10 p-6 space-y-4">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Enter the account's email — the recovery link is sent there. Single-owner
              installs without a mail relay get the link right here instead.
            </p>
            <Input
              type="email"
              value={recoverEmail}
              onChange={(e) => setRecoverEmail(e.target.value)}
              placeholder="you@studio.com"
              autoComplete="email"
              required
              aria-label="Account email"
            />
            {error && (
              <p role="alert" className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={recoverBusy || !recoverEmail.trim()}
              className="w-full bg-brand-gradient hover:opacity-90 text-white font-semibold"
            >
              {recoverBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4 mr-1.5" />}
              Send the recovery link
            </Button>
            <button
              type="button"
              onClick={() => {
                setFlow("signin");
                setError(null);
              }}
              className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="inline h-3 w-3 mr-1 -mt-0.5" />
              Back to sign in
            </button>
          </form>
        )}

        {flow === "recover" && recoverStep === 2 && recoverDone && (
          <div className="glass rounded-2xl border border-white/10 p-6 space-y-4 text-center">
            <MailCheck className="h-8 w-8 mx-auto text-emerald-400" />
            <p className="text-sm font-medium">Password changed</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Every device was signed out — sign in with the new password.
            </p>
            <Button
              onClick={() => {
                setEmail(recoverEmail); // keep the address for the sign-in form
                setFlow("signin");
                setRecoverDone(false);
                setError(null);
              }}
              className="w-full bg-brand-gradient hover:opacity-90 text-white font-semibold"
            >
              Back to sign in
            </Button>
          </div>
        )}

        {flow === "recover" && recoverStep === 2 && !recoverDone && (
          <form onSubmit={confirmReset} className="glass rounded-2xl border border-white/10 p-6 space-y-4">
            {recoverLink ? (
              <p className="text-xs text-muted-foreground leading-relaxed">
                Single-owner mode — the link is{" "}
                <a href={recoverLink} className="text-foreground/85 underline underline-offset-2 hover:text-foreground">
                  right here
                </a>{" "}
                (already filled in below).
              </p>
            ) : (
              <p className="text-xs text-muted-foreground leading-relaxed">
                Check the inbox for the reset link, then paste it (or its token) below.
              </p>
            )}
            <Input
              type="text"
              value={recoverToken}
              onChange={(e) => setRecoverToken(e.target.value)}
              placeholder="The reset link, or its token"
              required
              aria-label="Reset link or token"
            />
            <Input
              type={reveal ? "text" : "password"}
              value={recoverPw}
              onChange={(e) => setRecoverPw(e.target.value)}
              placeholder="New password (8+ characters)"
              autoComplete="new-password"
              required
              aria-label="New password"
            />
            <Input
              type={reveal ? "text" : "password"}
              value={recoverPw2}
              onChange={(e) => setRecoverPw2(e.target.value)}
              placeholder="Repeat the new password"
              autoComplete="new-password"
              required
              aria-label="Repeat the new password"
            />
            {error && (
              <p role="alert" className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={recoverBusy || !recoverToken.trim() || !recoverPw || !recoverPw2}
              className="w-full bg-brand-gradient hover:opacity-90 text-white font-semibold"
            >
              {recoverBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4 mr-1.5" />}
              Set the new password
            </Button>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <button
                type="button"
                onClick={() => {
                  setRecoverStep(1);
                  setError(null);
                }}
                className="hover:text-foreground transition-colors"
              >
                Request a new link
              </button>
              <button
                type="button"
                onClick={() => {
                  setFlow("signin");
                  setError(null);
                }}
                className="hover:text-foreground transition-colors"
              >
                Back to sign in
              </button>
            </div>
          </form>
        )}

        {flow === "signin" && (
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

          {mode === "login" && (
            <button
              type="button"
              onClick={() => {
                setFlow("recover");
                setRecoverStep(1);
                setRecoverDone(false);
                setError(null);
              }}
              className="w-full text-right text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Forgot the password?
            </button>
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
        )}
      </div>
    </div>
  );
}
