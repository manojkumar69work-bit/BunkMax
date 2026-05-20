"use client";

import { Bell, BellOff } from "lucide-react";
import { usePushNotifications } from "@/utils/usePushNotifications";

type PushNotificationSettingsProps = {
  userId: number;
};

export default function PushNotificationSettings({
  userId,
}: PushNotificationSettingsProps) {
  const {
    permission,
    status,
    error,
    requestPermissionAndRegister,
  } = usePushNotifications({
    userId,
    listenForForegroundMessages: false,
    showForegroundNotifications: false,
  });

  const enabled = permission === "granted" && status !== "error";
  const unsupported = status === "unsupported";
  const missingConfig = status === "missing-config";
  const busy = status === "requesting";

  return (
    <div className="glass-card p-4">
      <div className="flex items-start gap-4">
        <div
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border ${
            enabled
              ? "border-green-500/30 bg-green-500/12 text-green-200"
              : "border-[#1d9bf0]/30 bg-[#1d9bf0]/12 text-[#8ecdf8]"
          }`}
        >
          {enabled ? (
            <Bell size={22} aria-hidden="true" />
          ) : (
            <BellOff size={22} aria-hidden="true" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="font-semibold">Notifications</p>
          <p className="mt-1 text-sm text-gray-400">
            {enabled
              ? "Alerts are enabled for this browser."
              : "Enable class and attendance alerts on this device."}
          </p>

          {error && (
            <p className="mt-2 text-xs leading-relaxed text-red-200">
              {error}
            </p>
          )}

          {missingConfig && (
            <p className="mt-2 text-xs leading-relaxed text-yellow-200">
              Firebase keys still need to be added before this can go live.
            </p>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={requestPermissionAndRegister}
        disabled={enabled || unsupported || busy}
        className="primary-btn mt-4 disabled:opacity-60"
      >
        {busy
          ? "Enabling..."
          : enabled
          ? "Enabled"
          : unsupported
          ? "Not Supported"
          : "Enable Notifications"}
      </button>
    </div>
  );
}
