"use client";

import { useCallback, useEffect, useState } from "react";
import type { FirebaseApp, FirebaseOptions } from "firebase/app";
import type { MessagePayload, Messaging, Unsubscribe } from "firebase/messaging";

type PushNotificationStatus =
  | "idle"
  | "unsupported"
  | "missing-config"
  | "missing-user"
  | "requesting"
  | "granted"
  | "denied"
  | "error";

type UsePushNotificationsOptions = {
  userId?: number;
  autoRegister?: boolean;
  listenForForegroundMessages?: boolean;
  showForegroundNotifications?: boolean;
  onForegroundMessage?: (payload: MessagePayload) => void;
};

type PushNotificationResult = {
  permission: NotificationPermission | "unsupported";
  status: PushNotificationStatus;
  error: string;
  token: string;
  requestPermissionAndRegister: () => Promise<string | null>;
};

const firebaseConfig: FirebaseOptions = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY || "";

let cachedApp: FirebaseApp | null = null;
let cachedMessaging: Messaging | null = null;

function hasFirebaseConfig() {
  return Boolean(
    firebaseConfig.apiKey &&
      firebaseConfig.projectId &&
      firebaseConfig.messagingSenderId &&
      firebaseConfig.appId &&
      vapidKey
  );
}

function getNotificationSupport(): NotificationPermission | "unsupported" {
  if (
    typeof window === "undefined" ||
    !("Notification" in window) ||
    !("serviceWorker" in navigator)
  ) {
    return "unsupported";
  }

  return Notification.permission;
}

async function getFirebaseMessaging() {
  if (!hasFirebaseConfig()) {
    throw new Error("Firebase web config or VAPID key is missing.");
  }

  const [{ getApps, initializeApp }, { getMessaging, isSupported }] =
    await Promise.all([import("firebase/app"), import("firebase/messaging")]);

  const supported = await isSupported();

  if (!supported) {
    throw new Error("This browser does not support Firebase web push messaging.");
  }

  if (!cachedApp) {
    cachedApp = getApps()[0] ?? initializeApp(firebaseConfig);
  }

  if (!cachedMessaging) {
    cachedMessaging = getMessaging(cachedApp);
  }

  return cachedMessaging;
}

async function registerMessagingServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service workers are not supported in this browser.");
  }

  const registration = await navigator.serviceWorker.register(
    "/firebase-messaging-sw.js",
    { scope: "/" }
  );

  await navigator.serviceWorker.ready;

  return registration;
}

async function saveTokenToBackend(userId: number, token: string) {
  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };

  const response = await fetch("/api/save-token", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      user_id: userId,
      token,
      platform:
        navigatorWithUserAgentData.userAgentData?.platform ||
        navigator.platform ||
        "",
      user_agent: navigator.userAgent || "",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Failed to save notification token.");
  }
}

function payloadToNotification(payload: MessagePayload) {
  const data = payload.data || {};
  const notification = payload.notification || {};

  return {
    title: notification.title || data.title || "BunkMax",
    options: {
      body: notification.body || data.body || "You have a new BunkMax alert.",
      icon: data.icon || "/android-chrome-192x192.png",
      tag: data.tag || "bunkmax-notification",
      data: {
        url: data.url || "/",
      },
    } satisfies NotificationOptions,
  };
}

export function usePushNotifications({
  userId,
  autoRegister = false,
  listenForForegroundMessages = true,
  showForegroundNotifications = true,
  onForegroundMessage,
}: UsePushNotificationsOptions = {}): PushNotificationResult {
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported"
  >("default");
  const [status, setStatus] = useState<PushNotificationStatus>("idle");
  const [error, setError] = useState("");
  const [token, setToken] = useState("");

  const requestPermissionAndRegister = useCallback(async () => {
    const currentSupport = getNotificationSupport();
    setPermission(currentSupport);
    setError("");

    if (currentSupport === "unsupported") {
      setStatus("unsupported");
      return null;
    }

    if (!userId) {
      setStatus("missing-user");
      return null;
    }

    if (!hasFirebaseConfig()) {
      setStatus("missing-config");
      setError("Firebase web config or VAPID key is missing.");
      return null;
    }

    try {
      setStatus("requesting");

      const registration = await registerMessagingServiceWorker();
      const nextPermission = await Notification.requestPermission();
      setPermission(nextPermission);

      if (nextPermission !== "granted") {
        setStatus(nextPermission === "denied" ? "denied" : "idle");
        return null;
      }

      const [{ getToken }, messaging] = await Promise.all([
        import("firebase/messaging"),
        getFirebaseMessaging(),
      ]);

      const currentToken = await getToken(messaging, {
        vapidKey,
        serviceWorkerRegistration: registration,
      });

      if (!currentToken) {
        throw new Error("Firebase did not return a device token.");
      }

      await saveTokenToBackend(userId, currentToken);

      localStorage.setItem(`bunkmax_fcm_token_${userId}`, currentToken);
      setToken(currentToken);
      setStatus("granted");

      return currentToken;
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Failed to enable notifications.";

      setError(message);
      setStatus("error");
      return null;
    }
  }, [userId]);

  useEffect(() => {
    const currentSupport = getNotificationSupport();
    setPermission(currentSupport);

    if (currentSupport === "unsupported") {
      setStatus("unsupported");
      return;
    }

    if (currentSupport === "granted") {
      setStatus("granted");

      if (userId) {
        const cachedToken = localStorage.getItem(`bunkmax_fcm_token_${userId}`);
        if (cachedToken) {
          setToken(cachedToken);
        }
      }

      if (autoRegister) {
        void requestPermissionAndRegister();
      }
    } else if (currentSupport === "denied") {
      setStatus("denied");
    }
  }, [autoRegister, requestPermissionAndRegister, userId]);

  useEffect(() => {
    if (!listenForForegroundMessages || permission !== "granted") {
      return undefined;
    }

    let unsubscribe: Unsubscribe | undefined;
    let cancelled = false;

    async function listen() {
      try {
        const [{ onMessage }, messaging] = await Promise.all([
          import("firebase/messaging"),
          getFirebaseMessaging(),
        ]);

        if (cancelled) return;

        unsubscribe = onMessage(messaging, (payload) => {
          onForegroundMessage?.(payload);

          if (showForegroundNotifications && Notification.permission === "granted") {
            const { title, options } = payloadToNotification(payload);
            new Notification(title, options);
          }
        });
      } catch (caughtError) {
        console.warn("Unable to listen for foreground push messages.", caughtError);
      }
    }

    void listen();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [
    listenForForegroundMessages,
    onForegroundMessage,
    permission,
    showForegroundNotifications,
  ]);

  return {
    permission,
    status,
    error,
    token,
    requestPermissionAndRegister,
  };
}
