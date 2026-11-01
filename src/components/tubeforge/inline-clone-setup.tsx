"use client";

// Inline self-hosted voice-server setup shown inside the Clone tab of the
// video detail dialog (and Voice Studio) when no clone-capable provider is
// fully configured. Lets the user paste the Oracle VM URL + key (or a Zhipu
// key) without leaving the dialog — saves through /api/settings/ai and
// re-fetches the clone-provider state via the shared voices-changed event.
//
// The clone itself doesn't need the server (the sample is stored locally);
// this form exists so synthesis later doesn't fail with "no server".

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Server, KeyRound, ChevronDown, ChevronUp } from "lucide-react";
import { VOICES_CHANGED_EVENT } from "@/components/tubeforge/shared";

/**
 * @param hint one-line status from /api/voices/clone-providers.pick.hint
 */
export function InlineCloneSetup({ hint }: { hint?: string }) {
  const [open, setOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function save() {
    setErr(null);
    setOk(null);
    if (!baseUrl.trim() && !key.trim()) {
      setErr("Paste at least the server URL (and its key if you set one).");
      return;
    }
    setSaving(true);
    try {
      // Save under the selfhost provider, but DON'T switch the active voiceover
      // (the user may have Z.ai or another provider as their default). The
      // dedicated credentials endpoint stores the creds without flipping the
      // active capability; cloned voices route to selfhost at synthesis time
      // via ttsSynthesize's cloned-voice auto-routing.
      const res = await fetch("/api/settings/ai/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capability: "tts",
          provider: "selfhost",
          baseUrl: baseUrl.trim() || undefined,
          apiKey: key.trim() || undefined,
        }),
      });
      const d = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(d?.error ?? `HTTP ${res.status}`);
      setOk("Saved — clones will synthesize through your self-hosted server.");
      window.dispatchEvent(new Event(VOICES_CHANGED_EVENT));
      setBaseUrl("");
      setKey("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save — try again");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-amber-400/25 bg-amber-400/6 px-3 py-2.5 space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-left"
      >
        <span className="text-[11px] leading-relaxed text-amber-200/95">
          {hint ?? "Set up your self-hosted voice server to synthesize cloned voices."}
        </span>
        {open ? (
          <ChevronUp className="h-3.5 w-3.5 text-amber-300/80 shrink-0 ml-2" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-amber-300/80 shrink-0 ml-2" />
        )}
      </button>
      {open && (
        <div className="space-y-1.5">
          <div className="grid grid-cols-1 gap-1.5">
            <div className="relative">
              <Server className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://your-oracle-vm-public-ip:8931"
                className="bg-white/5 h-9 text-xs pl-7"
                disabled={saving}
                spellCheck={false}
                autoComplete="url"
              />
            </div>
            <div className="relative">
              <KeyRound className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                type="password"
                placeholder="X-Voice-Key (the --key value the server runs with)"
                className="bg-white/5 h-9 text-xs pl-7"
                disabled={saving}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            className="w-full font-medium"
            disabled={saving}
            onClick={save}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {saving ? "Saving…" : "Save server"}
          </Button>
          {err && (
            <p className="text-[10px] leading-relaxed text-red-300/90" role="alert">
              {err}
            </p>
          )}
          {ok && (
            <p className="text-[10px] leading-relaxed text-emerald-300/90">{ok}</p>
          )}
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            Saved under the <b>self-hosted</b> provider — your active voiceover stays
            unchanged. Cloned voices route to this server at synthesis time.
          </p>
        </div>
      )}
    </div>
  );
}
