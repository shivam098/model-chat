import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Self-hosted (SIL Open Font License, see app/fonts); no runtime requests to font services.
const sans = localFont({ src: "./fonts/InstrumentSans-Variable.woff2", variable: "--font-sans", weight: "400 600", display: "swap" });
const mono = localFont({ src: "./fonts/JetBrainsMono-Variable.woff2", variable: "--font-mono", weight: "400 500", display: "swap" });

export const metadata: Metadata = {
  title: "Model Chat",
  description: "Chat with Copilot models about your files. Runs on the host's computer.",
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={`${sans.variable} ${mono.variable}`}><body>{children}</body></html>;
}
