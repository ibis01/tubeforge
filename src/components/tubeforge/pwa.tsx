"use client";

// PWA plumbing:
//   <ServiceWorkerRegister /> — mounts once in the root layout, registers /sw.js.
//   <InstallAppButton />      — "Install on this device" button. Renders nothing
//                               until the browser fires `beforeinstallprompt`
//                               (Android Chrome/Edge/Samsung Internet, desktop
//                               Chrome). iOS Safari has no programmatic install —
//                               the Settings card shows the manual A2HS steps.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Download, Smartphone } from "lucide-react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.warn("[pwa] service worker registration failed:", err);
      });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}

export function InstallAppButton() {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault(); // keep our own install flow
      setPromptEvent(e as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPromptEvent(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    // Deferred so lint's set-state-in-effect rule is satisfied; a microtask is
    // plenty for a purely cosmetic "already installed" flag.
    queueMicrotask(() => {
      if (window.matchMedia("(display-mode: standalone)").matches) setInstalled(true);
    });
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = async () => {
    if (!promptEvent) return;
    await promptEvent.prompt();
    await promptEvent.userChoice;
    setPromptEvent(null);
  };

  if (installed) {
    return (
      <p className="text-xs text-muted-foreground flex items-center gap-2">
        <Smartphone className="h-3.5 w-3.5 text-primary" />
        TubeForge is installed — you are running the app version.
      </p>
    );
  }

  return (
    <Button
      size="sm"
      onClick={install}
      disabled={!promptEvent}
      className="bg-brand-gradient text-white hover:opacity-90"
    >
      <Download className="h-4 w-4" />
      Install TubeForge
    </Button>
  );
}

/** Manual steps for browsers without beforeinstallprompt (iOS Safari, Firefox). */
export function ManualInstallHint() {
  const [ios, setIos] = useState(false);
  useEffect(() => {
    queueMicrotask(() => {
      const ua = window.navigator.userAgent.toLowerCase();
      setIos(/iphone|ipad|ipod/.test(ua) || (/macintosh/.test(ua) && "ontouchend" in document));
    });
  }, []);

  return (
    <div className="text-xs text-muted-foreground space-y-1.5">
      <p className="flex gap-2">
        <span className="text-primary font-semibold shrink-0">iOS</span>
        <span>
          Open TubeForge in Safari → tap <span className="text-foreground font-medium">Share</span>{" "}
          <span className="inline-block align-middle text-[10px] border rounded px-1">↑</span> →{" "}
          <span className="text-foreground font-medium">Add to Home Screen</span>.
        </span>
      </p>
      <p className="flex gap-2">
        <span className="text-primary font-semibold shrink-0">Android</span>
        <span>
          {ios
            ? "Open in Chrome → ⋮ menu → Add to Home screen (or use the install button above)."
            : "Open in Chrome → ⋮ menu → Add to Home screen — or tap Install TubeForge when it lights up."}
        </span>
      </p>
    </div>
  );
}
