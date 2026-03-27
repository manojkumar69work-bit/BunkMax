import { auth } from "@/auth";

const API_BASE = "https://bunkmax.onrender.com";

export async function GET() {
  const session = await auth();

  const email = session?.user?.email || (session?.user as any)?.email;
  const name = session?.user?.name || "Student";

  if (!email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const res = await fetch(`${API_BASE}/auth/google-user`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      name,
    }),
    cache: "no-store",
  });

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