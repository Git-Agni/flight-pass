import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Anton, IBM_Plex_Mono, Inter } from "next/font/google";
import { config } from "@/lib/flight";
import "./flight.css";

// Anton carries the big ticket type, IBM Plex Mono the ticket data, Inter the body.
const anton = Anton({ weight: "400", subsets: ["latin"], variable: "--font-anton", display: "swap" });
const plexMono = IBM_Plex_Mono({ weight: ["400", "500", "600"], subsets: ["latin"], variable: "--font-plex-mono", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: config.airline,
  description: `Board ${config.airline}: swap contacts and fly to ${config.pass.dest.toLowerCase()}.`,
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#05060a", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`fly-root ${anton.variable} ${plexMono.variable} ${inter.variable}`}>{children}</body>
    </html>
  );
}
