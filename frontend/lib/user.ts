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

// Validate cached user data
function isValidCachedUser(data: any): data is AppUser {
  return (
    data &&
    typeof data === "object" &&
    typeof data.id === "number" &&
    typeof data.name === "string" &&
    typeof data.email === "string"
  );
}

export function useAppUser() {
  const [appUser, setAppUser] = useState<AppUser | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);

  useEffect(() => {
    async function loadUser() {
      try {
        setLoadingUser(true);

        // Step 1: Check localStorage cache (but validate it)
        try {
          const cached = localStorage.getItem("bunkmax_user");
          if (cached) {
            const parsed = JSON.parse(cached);
            if (isValidCachedUser(parsed)) {
              setAppUser(parsed);
              // Don't return yet - still validate with server
            }
          }
        } catch (e) {
          // localStorage read or parse failed - clear it
          localStorage.removeItem("bunkmax_user");
        }

        // Step 2: Get session from NextAuth
        let sessionRes: Response;
        try {
          sessionRes = await fetch("/api/auth/session", {
            cache: "no-store",
            credentials: "include",
            signal: AbortSignal.timeout(10000), // 10 second timeout
          });
        } catch (e: any) {
          if (e.name === "AbortError") {
            throw new Error("Session check timeout");
          }
          throw e;
        }

        if (!sessionRes.ok) {
          setAppUser(null);
          localStorage.removeItem("bunkmax_user");
          return;
        }

        let session: any;
        try {
          session = await sessionRes.json();
        } catch {
          setAppUser(null);
          localStorage.removeItem("bunkmax_user");
          return;
        }

        const email = session?.user?.email?.trim().toLowerCase();

        if (!email) {
          setAppUser(null);
          localStorage.removeItem("bunkmax_user");
          return;
        }

        // Step 3: Fetch user from backend
        let backendRes: Response;
        try {
          backendRes = await fetch(`${API_BASE}/auth/google-user`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email,
              name: session?.user?.name || "Student",
            }),
            signal: AbortSignal.timeout(10000), // 10 second timeout
          });
        } catch (e: any) {
          if (e.name === "AbortError") {
            throw new Error(
              "Authentication timeout - server took too long to respond"
            );
          }
          throw e;
        }

        if (!backendRes.ok) {
          const errorText = await backendRes.text().catch(() => "Unknown error");
          throw new Error(
            errorText || `Auth failed with status ${backendRes.status}`
          );
        }

        let data: any;
        try {
          data = await backendRes.json();
        } catch {
          throw new Error("Invalid response from server");
        }

        // Validate backend response
        if (!isValidCachedUser(data)) {
          throw new Error("Invalid user data from server");
        }

        setAppUser(data);
        localStorage.setItem("bunkmax_user", JSON.stringify(data));
      } catch (err: any) {
        console.error("useAppUser error:", err?.message || err);
        setAppUser(null);
        localStorage.removeItem("bunkmax_user");
      } finally {
        setLoadingUser(false);
      }
    }

    loadUser();
  }, []);

  return { appUser, loadingUser };
}

// Helper to clear user (for logout)
export function clearUserCache() {
  localStorage.removeItem("bunkmax_user");
}