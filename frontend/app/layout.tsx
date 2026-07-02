import "./globals.css";
import Providers from "./providers";
import { Analytics } from "@vercel/analytics/next";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "BunkMax",
  description: "Smart attendance planner",
  manifest: "/manifest.json",
  applicationName: "BunkMax",
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  // Makes it install and launch like a native app on iOS (standalone, no
  // Safari chrome). Android/Chrome uses manifest.json for the same.
  appleWebApp: {
    capable: true,
    title: "BunkMax",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#1d9bf0",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="max-w-md mx-auto min-h-screen pb-20">{children}</div>
        </Providers>
        <Analytics />
      </body>
    </html>
  );
}