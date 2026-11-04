"use client";

// Studio access — the opt-in lock for the whole app. Off (default): anyone
// with the link uses the studio. On: every API call needs a signed session
// and the page shows the lock screen. The browser that enables it is signed
// in automatically, so you can never lock out the tab you enabled it from.

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { broadcastGateState } from "@/components/tubeforge/auth-gate";
import { Eye, EyeOff, KeyRound, Lock, Loader2, ShieldCheck, ShieldOff, TerminalSquare } from "lucide-react";

type Status = { configured: boolean; authenticated: boolean; gateEnabled: boolean };

export function SecurityAccessCard() {
  const { toast } = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [editing, setEditing] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);

  // S16 — the rotation form. The card has said "you can change it later from
  // here" since the lock shipped; now it tells the truth. Only for a signed-in
  // caller whose account HAS a password (the route needs a browser session).
  const [cpOpen, setCpOpen] = useState(false);
  const [cpCurrent, setCpCurrent] = useState("");
  const [cpNew, setCpNew] = useState("");
  const [cpNew2, setCpNew2] = useState("");
  const [cpReveal, setCpReveal] = useState(false);
  const [cpBusy, setCpBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/status", { cache: "no-store" });
      if (!res.ok) return;
      const d = (await res.json()) as Status;
      setStatus(d);
      broadcastGateState(d.gateEnabled);
    } catch {
      /* non-critical */
    }
  }, []);

  useEffect(() => {
    void load();
    const onGate = (e: Event) =>
      setStatus((s) => (s ? { ...s, gateEnabled: Boolean((e as CustomEvent).detail?.enabled) } : s));
    window.addEventListener("tf-gate", onGate);
    return () => window.removeEventListener("tf-gate", onGate);
  }, [load]);

  const post = async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await fetch("/api/auth/lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast({ title: "Security", description: d.error ?? "Something went wrong", variant: "destructive" });
        return false;
      }
      return true;
    } catch {
      toast({ title: "Security", description: "Network error — try again", variant: "destructive" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    if (!status?.configured && pw !== pw2) {
      toast({ title: "Security", description: "The two passwords do not match", variant: "destructive" });
      return;
    }
    const ok = await post({ enabled: true, password: pw });
    if (ok) {
      setPw("");
      setPw2("");
      setEditing(false);
      toast({ title: "Studio locked", description: "Password protection is on — this browser stays signed in." });
      await load();
    }
  };

  const disable = async () => {
    const ok = await post({ enabled: false });
    if (ok) {
      toast({ title: "Studio open", description: "Protection is off — anyone with the link can use the studio." });
      await load();
    }
  };

  const on = Boolean(status?.gateEnabled);
  const hasPassword = Boolean(status?.configured);

  const changePassword = async () => {
    if (cpNew.length < 8) {
      toast({ title: "Password", description: "The new password needs at least 8 characters", variant: "destructive" });
      return;
    }
    if (cpNew !== cpNew2) {
      toast({ title: "Password", description: "The two new passwords do not match", variant: "destructive" });
      return;
    }
    if (cpNew === cpCurrent) {
      toast({ title: "Password", description: "The new password is the same as the current one", variant: "destructive" });
      return;
    }
    setCpBusy(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: cpCurrent, newPassword: cpNew }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast({ title: "Password", description: d.error ?? "Something went wrong", variant: "destructive" });
        return;
      }
      setCpOpen(false);
      setCpCurrent("");
      setCpNew("");
      setCpNew2("");
      toast({
        title: "Password changed",
        description: "Every other device was signed out — this browser stays signed in.",
      });
      await load(); // the cookie rotated in place; status re-reads the fresh session
    } catch {
      toast({ title: "Password", description: "Network error — try again", variant: "destructive" });
    } finally {
      setCpBusy(false);
    }
  };

  return (
    <Card className="glass rounded-2xl p-5 sm:p-6">
      <div className="flex items-center gap-2.5 mb-5">
        <div className="h-9 w-9 rounded-xl bg-brand-gradient flex items-center justify-center glow-red-soft shrink-0">
          {on ? <ShieldCheck className="h-4.5 w-4.5 text-white" /> : <ShieldOff className="h-4.5 w-4.5 text-white" />}
        </div>
        <div>
          <h3 className="font-semibold leading-tight">Studio access</h3>
          <p className="text-xs text-muted-foreground">
            Optional password protection — off by default, you decide when to lock up
          </p>
        </div>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Lock className={`h-4.5 w-4.5 mt-0.5 shrink-0 ${on ? "text-primary" : "text-muted-foreground"}`} />
          <div>
            <p className="text-sm font-medium">{on ? "Password protection on" : "Studio open"}</p>
            <p className="text-xs text-muted-foreground mt-0.5 max-w-md">
              {on
                ? "Every visit needs your password; APIs reject anyone without a signed session. This browser stays signed in."
                : "Anyone with this link can open the studio, use your AI keys and reach the pipeline. Turn the switch on to require a password."}
            </p>
          </div>
        </div>
        <Switch
          checked={on}
          disabled={busy || !status}
          onCheckedChange={(v) => {
            if (v) setEditing(true);
            else void disable();
          }}
          aria-label="Toggle password protection"
        />
      </div>

      {editing && !on && (
        <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            {hasPassword
              ? "Re-enable the lock by confirming your current access password."
              : "Create the access password (at least 8 characters). You can change it later from here."}
          </p>
          <div className="relative">
            <Input
              type={reveal ? "text" : "password"}
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder={hasPassword ? "Current access password" : "New access password"}
              autoFocus
              autoComplete={hasPassword ? "current-password" : "new-password"}
              className="pr-10"
              aria-label={hasPassword ? "Current access password" : "New access password"}
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
          {!hasPassword && (
            <Input
              type={reveal ? "text" : "password"}
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              placeholder="Repeat the password"
              autoComplete="new-password"
              aria-label="Repeat the password"
            />
          )}
          <div className="flex items-center gap-2 pt-1">
            <Button
              onClick={() => void enable()}
              disabled={busy || !pw || (!hasPassword && !pw2)}
              className="bg-brand-gradient hover:opacity-90 text-white font-semibold"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Lock the studio
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setPw("");
                setPw2("");
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* S16 — the rotation surface. The copy above promised "you can change
          it later from here"; this is "here". Requires a signed-in browser
          (the route re-signs this tab on a fresh session and signs out every
          other device). */}
      {hasPassword && status?.authenticated && (
        <div className="mt-5 pt-5 border-t border-white/10">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <KeyRound className="h-4.5 w-4.5 mt-0.5 shrink-0 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Access password</p>
                <p className="text-xs text-muted-foreground mt-0.5 max-w-md">
                  Rotate the password you sign in with. Every other device is signed out — this browser stays signed in.
                </p>
              </div>
            </div>
            {!cpOpen && (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => {
                  setCpOpen(true);
                  setCpCurrent("");
                  setCpNew("");
                  setCpNew2("");
                }}
                disabled={cpBusy}
              >
                Change
              </Button>
            )}
          </div>

          {cpOpen && (
            <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
              <p className="text-xs text-muted-foreground">
                Prove the current password, then pick the new one (at least 8 characters, different from the current).
              </p>
              <div className="relative">
                <Input
                  type={cpReveal ? "text" : "password"}
                  value={cpCurrent}
                  onChange={(e) => setCpCurrent(e.target.value)}
                  placeholder="Current password"
                  autoFocus
                  autoComplete="current-password"
                  className="pr-10"
                  aria-label="Current password"
                />
                <button
                  type="button"
                  onClick={() => setCpReveal((r) => !r)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-muted-foreground hover:text-foreground rounded-md"
                  aria-label={cpReveal ? "Hide passwords" : "Show passwords"}
                >
                  {cpReveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Input
                type={cpReveal ? "text" : "password"}
                value={cpNew}
                onChange={(e) => setCpNew(e.target.value)}
                placeholder="New password"
                autoComplete="new-password"
                aria-label="New password"
              />
              <Input
                type={cpReveal ? "text" : "password"}
                value={cpNew2}
                onChange={(e) => setCpNew2(e.target.value)}
                placeholder="Repeat the new password"
                autoComplete="new-password"
                aria-label="Repeat the new password"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !cpBusy && cpCurrent && cpNew && cpNew2) void changePassword();
                }}
              />
              <div className="flex items-center gap-2 pt-1">
                <Button
                  onClick={() => void changePassword()}
                  disabled={cpBusy || !cpCurrent || !cpNew || !cpNew2}
                  className="bg-brand-gradient hover:opacity-90 text-white font-semibold"
                >
                  {cpBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                  Change the password
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setCpOpen(false);
                    setCpCurrent("");
                    setCpNew("");
                    setCpNew2("");
                  }}
                  disabled={cpBusy}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {on && hasPassword && (
        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground mt-4">
          <TerminalSquare className="h-3.5 w-3.5 shrink-0 mt-px" />
          <span>
            Locked out on another device? Run <code className="text-foreground/80">bun run auth:reset</code> on the
            server to switch the studio back to open.
          </span>
        </p>
      )}
    </Card>
  );
}
