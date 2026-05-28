"use client";

import { SessionProvider } from "next-auth/react";
import SubscriptionGate from "@/components/SubscriptionGate";

export default function Providers({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SessionProvider>
      <SubscriptionGate>{children}</SubscriptionGate>
    </SessionProvider>
  );
}
