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

        // 1. Get session
        const sessionRes = await fetch("/api/auth/session", {
          cache: "no-store",
          credentials: "include",
        });

        const session = await sessionRes.json();
        const email = session?.user?.email?.trim().toLowerCase();

        if (!email) {
          setAppUser(null);
          return;
        }

        // 🔁 RETRY LOGIC (VERY IMPORTANT)
        let data = null;

        for (let i = 0; i < 3; i++) {
          try {
            const res = await fetch(`${API_BASE}/auth/google-user`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                email,
                name: session?.user?.name || "Student",
              }),
            });

            if (res.ok) {
              data = await res.json();
              break;
            }
          } catch (err) {
            console.log("Retrying...", i + 1);
          }

          // wait before retry
          await new Promise((r) => setTimeout(r, 1500));
        }

        if (!data) {
          console.error("All retries failed");
          setAppUser(null);
          return;
        }

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