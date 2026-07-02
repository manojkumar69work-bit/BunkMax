"use client";

import PushNotificationRegistrar from "@/components/PushNotificationRegistrar";
import { useAppUser } from "@/lib/user";

export default function SubscriptionGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const { appUser } = useAppUser();

  return (
    <>
      {appUser?.is_pro && <PushNotificationRegistrar />}
      <div className="min-h-screen">{children}</div>
    </>
  );
}
