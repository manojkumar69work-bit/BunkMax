"use client";

import { useEffect, useState } from "react";

export type AppUser = {
  id: number;
  email?: string;
  name: string;
  college: string;
  branch: string;
  semester: string;
  section: string;
  default_target: number;
  is_pro: boolean;
  subscription_plan: string;
  subscription_status: string;
  subscription_renews_at?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeUser(data: unknown): AppUser | null {
  if (!isRecord(data)) return null;

  const id = Number(data.id);

  if (!Number.isFinite(id) || id <= 0) return null;

  return {
    id,
    email: typeof data.email === "string" ? data.email : "",
    name: typeof data.name === "string" ? data.name : "Student",
    college: typeof data.college === "string" ? data.college : "",
    branch: typeof data.branch === "string" ? data.branch : "",
    semester: typeof data.semester === "string" ? data.semester : "",
    section: typeof data.section === "string" ? data.section : "",
    default_target: Number(data.default_target || 75),
    is_pro: data.is_pro === true,
    subscription_plan:
      typeof data.subscription_plan === "string"
        ? data.subscription_plan
        : "free",
    subscription_status:
      typeof data.subscription_status === "string"
        ? data.subscription_status
        : "free",
    subscription_renews_at:
      typeof data.subscription_renews_at === "string"
        ? data.subscription_renews_at
        : null,
  };
}

function getCachedUser(): AppUser | null {
  try {
    const cached = localStorage.getItem("bunkmax_user");
    if (!cached) return null;

    const parsed = JSON.parse(cached);
    return normalizeUser(parsed);
  } catch {
    localStorage.removeItem("bunkmax_user");
    return null;
  }
}

export function useAppUser() {
  const [appUser, setAppUser] = useState<AppUser | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function loadUser() {
      const cachedUser = getCachedUser();

      if (cachedUser && mounted) {
        setAppUser(cachedUser);
      }

      try {
        setLoadingUser(true);

        const res = await fetch("/api/me", {
          cache: "no-store",
          credentials: "include",
        });

        if (!res.ok) {
          setAppUser(null);
          localStorage.removeItem("bunkmax_user");
          return;
        }

        const data = await res.json();
        const normalized = normalizeUser(data);

        if (!normalized) {
          throw new Error("Invalid user data from server");
        }

        if (mounted) {
          setAppUser(normalized);
        }

        localStorage.setItem("bunkmax_user", JSON.stringify(normalized));
      } catch (err) {
        console.error("useAppUser error:", err);

        if (!cachedUser && mounted) {
          setAppUser(null);
          localStorage.removeItem("bunkmax_user");
        }
      } finally {
        if (mounted) {
          setLoadingUser(false);
        }
      }
    }

    loadUser();

    return () => {
      mounted = false;
    };
  }, []);

  return { appUser, loadingUser };
}

export function clearUserCache() {
  localStorage.removeItem("bunkmax_user");
}
