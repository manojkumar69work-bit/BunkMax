import "./globals.css";
import Providers from "./providers";
import { Analytics } from "@vercel/analytics/next"

export const metadata = {
  title: "BunkMax",
  description: "Smart attendance planner",
  manifest: "/manifest.json",
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
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
      </body>
    </html>
  );
}