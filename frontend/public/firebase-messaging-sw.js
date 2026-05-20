/* global firebase */

// Firebase Messaging service worker.
// Replace these placeholders with the Firebase web app config from
// Firebase Console > Project settings > General > Your apps > Web app.
const firebaseConfig = {
  apiKey: "AIzaSyDof2-mUmdMLpdioz30K6e3bbj0PIfG0h8",
  authDomain: "bunkmax-6969.firebaseapp.com",
  projectId: "bunkmax-6969",
  storageBucket: "bunkmax-6969.firebasestorage.app",
  messagingSenderId: "549390392813",
  appId: "1:549390392813:web:95addc1ba3391b4f401be4",
};

function hasFirebaseConfig(config) {
  return Boolean(
    config.apiKey &&
      config.projectId &&
      config.messagingSenderId &&
      config.appId &&
      !config.apiKey.startsWith("YOUR_") &&
      !config.projectId.startsWith("YOUR_") &&
      !config.messagingSenderId.startsWith("YOUR_") &&
      !config.appId.startsWith("YOUR_")
  );
}

if (hasFirebaseConfig(firebaseConfig)) {
  importScripts("https://www.gstatic.com/firebasejs/12.13.0/firebase-app-compat.js");
  importScripts("https://www.gstatic.com/firebasejs/12.13.0/firebase-messaging-compat.js");

  firebase.initializeApp(firebaseConfig);

  const messaging = firebase.messaging();

  messaging.onBackgroundMessage((payload) => {
    const notification = payload.notification || {};
    const data = payload.data || {};

    const title = notification.title || data.title || "BunkMax";
    const options = {
      body: notification.body || data.body || "You have a new BunkMax alert.",
      icon: notification.icon || data.icon || "/android-chrome-192x192.png",
      badge: data.badge || "/favicon-32x32.png",
      tag: data.tag || "bunkmax-notification",
      data: {
        url: data.url || "/",
      },
    };

    self.registration.showNotification(title, options);
  });
} else {
  console.warn(
    "BunkMax FCM service worker is installed, but Firebase config placeholders still need real values."
  );
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      const origin = self.location.origin;
      const target = new URL(targetUrl, origin).href;

      for (const client of clientList) {
        if (client.url === target && "focus" in client) {
          return client.focus();
        }
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow(target);
      }

      return undefined;
    })
  );
});
