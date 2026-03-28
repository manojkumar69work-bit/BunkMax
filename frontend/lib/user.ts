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

type AuthSession = {
  user?: {
    name?: string | null;
    email?: string | null;
  } | null;
  expires?: string;
};

export function useAppUser() {
  const [appUser, setAppUser] = useState<AppUser | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);

  useEffect(() => {
    async function loadUser() {
      try {
        setLoadingUser(true);

        const sessionRes = await fetch("/api/auth/session", {
          method: "GET",
          cache: "no-store",
          credentials: "include",
        });

        if (!sessionRes.ok) {
          setAppUser(null);
          return;
        }

        const session: AuthSession = await sessionRes.json();
        const email = session?.user?.email?.trim().toLowerCase();

        if (!email) {
          setAppUser(null);
          return;
        }

        const backendRes = await fetch(`${API_BASE}/auth/google-user`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email,
            name: session?.user?.name || "Student",
          }),
        });

        if (!backendRes.ok) {
          const text = await backendRes.text();
          console.error("google-user failed:", text);
          setAppUser(null);
          return;
        }

        const data: AppUser = await backendRes.json();
        setAppUser(data);
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