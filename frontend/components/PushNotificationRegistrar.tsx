"use client";

import { useAppUser } from "@/lib/user";
import { usePushNotifications } from "@/utils/usePushNotifications";

export default function PushNotificationRegistrar() {
  const { appUser } = useAppUser();

  usePushNotifications({
    userId: appUser?.id,
    autoRegister: true,
    listenForForegroundMessages: true,
    showForegroundNotifications: true,
  });

  return null;
}
