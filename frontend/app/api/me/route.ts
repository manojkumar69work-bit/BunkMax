import { auth } from "@/auth";

const API_BASE =
  process.env.BACKEND_API_BASE ||
  "http://127.0.0.1:8000";

const SERVICE_SECRET = process.env.BACKEND_API_SECRET || "";

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

  let res: Response;

  try {
    res = await fetch(`${API_BASE}/auth/google-user`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bunkmax-service-secret": SERVICE_SECRET,
      },
      body: JSON.stringify({ email, name }),
      cache: "no-store",
    });
  } catch {
    return Response.json(
      { error: "Backend is unreachable. Please try again shortly." },
      { status: 502 }
    );
  }

  if (!res.ok) {
    const text = await res.text();
    return Response.json(
      { error: "Failed to sync user", details: text },
      { status: res.status }
    );
  }

  const data = await res.json();
  return Response.json(data);
}
