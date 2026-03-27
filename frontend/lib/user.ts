"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";

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
  const { data: session, status } = useSession();
  const [appUser, setAppUser] = useState<AppUser | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);

  useEffect(() => {
    async function syncUser() {
      if (status === "loading") return;

      if (!session?.user?.email) {
        setAppUser(null);
        setLoadingUser(false);
        return;
      }

      try {
        setLoadingUser(true);

        const res = await fetch(`${API_BASE}/auth/google-user`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: session.user.email,
            name: session.user.name || "Student",
          }),
        });

        if (!res.ok) {
          throw new Error("Failed to sync user");
        }

        const data = await res.json();
        setAppUser(data);
      } catch (err) {
        console.error(err);
        setAppUser(null);
      } finally {
        setLoadingUser(false);
      }
    }

    syncUser();
  }, [session, status]);

  return { appUser, loadingUser, session, status };
}