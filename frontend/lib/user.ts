"use client";

import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/api";

export type AppUser = {
  id: number;
  email?: string;
  name: string;
  college: string;
  branch: string;
  semester: string;
  section: string;
  default_target: number;
};

function normalizeUser(data: any): AppUser | null {
  if (!data || typeof data !== "object") return null;

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

        const sessionRes = await fetch("/api/auth/session", {
          cache: "no-store",
          credentials: "include",
        });

        if (!sessionRes.ok) {
          if (!cachedUser) {
            setAppUser(null);
            localStorage.removeItem("bunkmax_user");
          }
          return;
        }

        const session = await sessionRes.json();
        const email = session?.user?.email?.trim().toLowerCase();

        if (!email) {
          setAppUser(null);
          localStorage.removeItem("bunkmax_user");
          return;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        try {
          const backendRes = await fetch(`${API_BASE}/auth/google-user`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email,
              name: session?.user?.name || "Student",
            }),
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (!backendRes.ok) {
            const errorText = await backendRes.text().catch(() => "");
            throw new Error(errorText || `Auth failed: ${backendRes.status}`);
          }

          const data = await backendRes.json();
          const normalized = normalizeUser(data);

          if (!normalized) {
            throw new Error("Invalid user data from server");
          }

          if (mounted) {
            setAppUser(normalized);
          }

          localStorage.setItem("bunkmax_user", JSON.stringify(normalized));
        } catch (backendError) {
          clearTimeout(timeoutId);

          console.error("Backend auth failed:", backendError);

          if (cachedUser && mounted) {
            setAppUser(cachedUser);
            return;
          }

          throw backendError;
        }
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