import { auth } from "@/auth";
import { unstable_cache } from "next/cache";

const API_BASE =
  process.env.BACKEND_API_BASE ||
  "http://127.0.0.1:8000";

const SERVICE_SECRET = process.env.BACKEND_API_SECRET || "";

export const dynamic = "force-dynamic";

// Every app load calls this to identify the user, and the record it returns
// barely changes. Share the proxy route's Data Cache entry (same 240s window,
// same "user-sync" tag) so an app open costs a DB pool checkout at most once
// per user per 4 minutes instead of once per open. Profile writes go through
// the proxy, which revalidates the tag, so an edit still shows up immediately.
const USER_SYNC_TTL = 240;

async function syncUserUncached(
  _emailKey: string,
  email: string,
  name: string,
): Promise<unknown> {
  const res = await fetch(`${API_BASE}/auth/google-user`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bunkmax-service-secret": SERVICE_SECRET,
    },
    body: JSON.stringify({ email, name }),
    cache: "no-store",
  });

  if (!res.ok) {
    // Thrown, not returned: unstable_cache stores resolved values, so a
    // returned error would be served to this user for the whole window.
    throw Object.assign(new Error(await res.text()), { status: res.status });
  }

  return res.json();
}

const cachedSyncUser = unstable_cache(
  syncUserUncached as (a: string, b: string, c: string) => Promise<unknown>,
  ["bunkmax:google-user-sync"],
  { revalidate: USER_SYNC_TTL, tags: ["user-sync"] },
);

export async function GET() {
  const session = await auth();

  const email = session?.user?.email?.trim().toLowerCase();
  const name = session?.user?.name || "Student";

  if (!email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!SERVICE_SECRET) {
    return Response.json(
      { error: "Backend service secret is missing" },
      { status: 500 }
    );
  }

  try {
    return Response.json(await cachedSyncUser(email, email, name));
  } catch (err: unknown) {
    const status =
      typeof err === "object" && err && "status" in err
        ? Number((err as { status: number }).status)
        : 0;

    if (status >= 400 && status < 600) {
      return Response.json(
        { error: "Failed to sync user", details: (err as Error).message },
        { status }
      );
    }

    return Response.json(
      { error: "Backend is unreachable. Please try again shortly." },
      { status: 502 }
    );
  }
}
