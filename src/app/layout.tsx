import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

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
  // Favicon comes from src/app/icon.svg (the red-orange TubeForge mark).
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
        <Toaster />
      </body>
    </html>
  );
}
