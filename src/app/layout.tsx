import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ServiceWorkerRegister } from "@/components/tubeforge/pwa";

// S104 CSP regression fix — the middleware stamps a FRESH per-request nonce
// into the Content-Security-Policy it attaches to every document
// (strict-dynamic; under strict-dynamic browsers IGNORE the 'self' fallback
// for scripts). Next.js can only inject that nonce into its bootstrap
// <script> tags when the document is rendered AT REQUEST TIME. The document
// routes were statically prerendered at build: that HTML carries NONCE-LESS
// scripts, so the browser refused every script — React never hydrated and
// the "Warming up the forge…" splash sat on screen forever (reproduced
// byte-identical on the standalone production build; hits every production
// surface since the nonce CSP landed: Vercel previews, Docker, standalone —
// the Docker smoke only curls APIs, so script execution was never exercised).
// Forcing the document segment dynamic renders it per request, where the
// nonce stamping engages. The shell is ~12 KB of HTML and all data flows
// through client fetches, so only the meaningless static cache is given up.
export const dynamic = "force-dynamic";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TubeForge — Automated YouTube Content Engine",
  description:
    "Fully-automated faceless YouTube platform: AI scripts, voiceovers, thumbnails and packaging on auto-pilot.",
  keywords: [
    "YouTube automation",
    "faceless channel",
    "AI script writer",
    "auto-pilot content",
    "TubeForge",
  ],
  // S25 — the installable app. The manifest + icons + service worker have
  // sat in public/ since day one; this is the wiring that makes the browser
  // (and the Settings "App on this device" card) actually see them.
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "TubeForge",
  },
  // Favicon comes from src/app/icon.svg (the red-orange TubeForge mark).
};

// theme_color / background_color for the installed shell (Next 16 moves
// themeColor out of metadata into the viewport export).
export const viewport: Viewport = {
  themeColor: "#0a0a0a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <ServiceWorkerRegister />
        <Toaster />
      </body>
    </html>
  );
}
