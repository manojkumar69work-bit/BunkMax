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

      const email =
        session?.user?.email ||
        (session?.user as any)?.email ||
        undefined;

      if (!email) {
        console.log("SESSION DEBUG:", session);
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
            email,
            name: session?.user?.name || "Student",
          }),
        });

        if (!res.ok) {
          throw new Error("Failed to sync user");
        }

        const data = await res.json();
        console.log("APP USER DEBUG:", data);
        setAppUser(data);
      } catch (err) {
        console.error("SYNC USER ERROR:", err);
        setAppUser(null);
      } finally {
        setLoadingUser(false);
      }
    }

    syncUser();
  }, [session, status]);

  return { appUser, loadingUser, session, status };
}