"use client";

import { SessionProvider } from "next-auth/react";
import PushNotificationRegistrar from "@/components/PushNotificationRegistrar";

export default function Providers({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SessionProvider>
      <PushNotificationRegistrar />
      {children}
    </SessionProvider>
  );
}
