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
  tagline?: string;
  links?: { label: string; url: string }[];
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
    tagline: typeof data.tagline === "string" ? data.tagline : "",
    links: Array.isArray(data.links) ? data.links.map((l: Record<string, unknown>) => ({ label: String(l.label || ""), url: String(l.url || "") })) : [],
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
  if (typeof localStorage === "undefined") return null;
  try {
    const cached = localStorage.getItem("bunkmax_user");
    if (!cached) return null;

    const parsed = JSON.parse(cached);
    return normalizeUser(parsed);
  } catch {
    try { localStorage.removeItem("bunkmax_user"); } catch {}
    return null;
  }
}

// ─── Shared session cache ──────────────────────────────
// Module-level state persists across client-side navigations (resets on hard
// reload). This collapses the many useAppUser() consumers into a single
// /api/me request per session and lets cached data paint with no loader.
const USER_TTL = 5 * 60 * 1000; // 5 min stale-while-revalidate

let sharedUser: AppUser | null = null;
let inflight: Promise<AppUser | null> | null = null;
let lastFetchedAt = 0;

const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

function setSharedUser(next: AppUser | null) {
  sharedUser = next;

  if (typeof localStorage !== "undefined") {
    try {
      if (next) {
        localStorage.setItem("bunkmax_user", JSON.stringify(next));
      } else {
        localStorage.removeItem("bunkmax_user");
      }
    } catch {
      /* ignore quota / unavailable storage */
    }
  }

  notify();
}

async function fetchUser(): Promise<AppUser | null> {
  const res = await fetch("/api/me", {
    cache: "no-store",
    credentials: "include",
  });

  if (!res.ok) {
    setSharedUser(null);
    return null;
  }

  const data = await res.json();
  const normalized = normalizeUser(data);

  if (!normalized) {
    throw new Error("Invalid user data from server");
  }

  setSharedUser(normalized);
  return normalized;
}

function ensureUser(force = false): Promise<AppUser | null> {
  const fresh = Date.now() - lastFetchedAt < USER_TTL;

  if (!force && sharedUser && fresh) {
    return Promise.resolve(sharedUser);
  }

  if (inflight) return inflight;

  inflight = fetchUser()
    .catch((err) => {
      console.error("useAppUser error:", err);
      return sharedUser; // keep last-known user on transient failures
    })
    .finally(() => {
      lastFetchedAt = Date.now();
      inflight = null;
    });

  return inflight;
}

export function useAppUser() {
  // Seed synchronously from the module cache (or localStorage) so pages render
  // instantly without a loader flash.
  const [appUser, setAppUser] = useState<AppUser | null>(() => {
    if (sharedUser) return sharedUser;
    const cached = getCachedUser();
    if (cached) sharedUser = cached;
    return cached;
  });

  const [loadingUser, setLoadingUser] = useState(
    () => !sharedUser && !(typeof localStorage !== "undefined" && getCachedUser())
  );

  useEffect(() => {
    const sync = () => setAppUser(sharedUser);
    listeners.add(sync);

    let active = true;
    ensureUser().finally(() => {
      if (active) setLoadingUser(false);
    });

    return () => {
      active = false;
      listeners.delete(sync);
    };
  }, []);

  return { appUser, loadingUser };
}

// Apply a local change to the cached user without a network round-trip.
export function mutateUser(patch: Partial<AppUser>) {
  if (!sharedUser) return;
  setSharedUser({ ...sharedUser, ...patch });
}

// Force a background revalidation (e.g. after a subscription change).
export function refreshUser() {
  return ensureUser(true);
}

export function clearUserCache() {
  sharedUser = null;
  lastFetchedAt = 0;
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem("bunkmax_user");
    } catch {
      /* ignore */
    }
  }
  notify();
}
