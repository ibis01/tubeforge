import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ServiceWorkerRegister } from "@/components/tubeforge/pwa";

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
