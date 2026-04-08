"use client";

import { useEffect, useState } from "react";

const API_BASE = "https://bunkmax.onrender.com";

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

export function useAppUser() {
  const [appUser, setAppUser] = useState<AppUser | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);

  useEffect(() => {
    async function loadUser() {
      try {
        setLoadingUser(true);

        // ⚡ 1. Check cache first (INSTANT LOAD)
        const cached = localStorage.getItem("bunkmax_user");
        if (cached) {
          setAppUser(JSON.parse(cached));
          setLoadingUser(false);
          return;
        }

        // ⚡ 2. Get session
        const sessionRes = await fetch("/api/auth/session", {
          cache: "no-store",
          credentials: "include",
        });

        if (!sessionRes.ok) {
          setAppUser(null);
          return;
        }

        const session = await sessionRes.json();
        const email = session?.user?.email?.trim().toLowerCase();

        if (!email) {
          setAppUser(null);
          return;
        }

        // ⚡ 3. SINGLE request (NO RETRIES)
        const res = await fetch(`${API_BASE}/auth/google-user`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            name: session?.user?.name || "Student",
          }),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || "Failed to load user");
        }

        const data = await res.json();

        // ⚡ 4. Save cache
        setAppUser(data);
        localStorage.setItem("bunkmax_user", JSON.stringify(data));
      } catch (err) {
        console.error("useAppUser error:", err);
        setAppUser(null);
      } finally {
        setLoadingUser(false);
      }
    }

    loadUser();
  }, []);

  return { appUser, loadingUser };
}