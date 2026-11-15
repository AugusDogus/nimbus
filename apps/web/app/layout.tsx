import { Toaster } from "@/components/ui/sonner";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Providers from "./providers";
import { ThemeBoot } from "@/components/theme-boot";
import { ThemeColor } from "@/components/theme-color";
import { nonceHeader } from "@/server/security-headers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Nimbus",
  description: "Nimbus is a fast, live-updating file browser for your data.",
  appleWebApp: { capable: true, title: "Nimbus", statusBarStyle: "default" },
};

// Defaults before scripts run; ThemeColor then follows the selected theme.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f8fa" },
    { media: "(prefers-color-scheme: dark)", color: "#222429" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The custom server sets a fresh Content-Security-Policy nonce for every document.
  const nonce = (await headers()).get(nonceHeader) ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head><ThemeBoot nonce={nonce} /><ThemeColor nonce={nonce} /></head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <Providers nonce={nonce}>{children}</Providers>
        <Toaster />
      </body>
    </html>
  );
}
