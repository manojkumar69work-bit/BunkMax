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
};

export function useAppUser() {
  const [appUser, setAppUser] = useState<AppUser | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);

  useEffect(() => {
    async function loadUser() {
      try {
        setLoadingUser(true);

        const res = await fetch("/api/me", {
          cache: "no-store",
        });

        if (!res.ok) {
          setAppUser(null);
          return;
        }

        const data = await res.json();
        setAppUser(data);
      } catch (err) {
        console.error("LOAD USER ERROR:", err);
        setAppUser(null);
      } finally {
        setLoadingUser(false);
      }
    }

    loadUser();
  }, []);

  return { appUser, loadingUser };
}