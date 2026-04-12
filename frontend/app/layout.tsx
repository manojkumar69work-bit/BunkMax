import "./globals.css";
import Providers from "./providers";

export const metadata = {
  title: "BunkMax",
  description: "Smart attendance planner",
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  manifest: "/manifest.json", // optional but recommended
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
          <div className="max-w-md mx-auto min-h-screen pb-20">
            {children}
          </div>
        </Providers>
      </body>
    </html>
  );
}