"use client";

import PaywallModal from "@/components/PaywallModal";
import PushNotificationRegistrar from "@/components/PushNotificationRegistrar";
import { useAppUser } from "@/lib/user";

export default function SubscriptionGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const { appUser, loadingUser } = useAppUser();

  if (appUser && !appUser.is_pro) {
    return (
      <PaywallModal
        key={appUser.id}
        appUser={appUser}
        loadingUser={loadingUser}
      />
    );
  }

  return (
    <>
      {appUser?.is_pro && <PushNotificationRegistrar />}
      <div className="min-h-screen">{children}</div>
    </>
  );
}
