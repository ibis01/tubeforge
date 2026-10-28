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
import { Eye, EyeOff, Lock, Loader2, ShieldCheck, ShieldOff, TerminalSquare } from "lucide-react";

type Status = { configured: boolean; authenticated: boolean; gateEnabled: boolean };

export function SecurityAccessCard() {
  const { toast } = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [editing, setEditing] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);

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
