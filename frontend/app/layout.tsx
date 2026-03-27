import "./globals.css";
import Providers from "./providers";
import { auth } from "@/auth";

export const metadata = {
  title: "BunkMax",
  description: "Smart attendance planner",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  return (
    <html lang="en">
      <body>
        <Providers session={session}>
          <div className="max-w-md mx-auto min-h-screen pb-20">{children}</div>
        </Providers>
      </body>
    </html>
  );
}