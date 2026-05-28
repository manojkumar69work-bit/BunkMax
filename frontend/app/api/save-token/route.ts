import { auth } from "@/auth";

const API_BASE =
  process.env.BACKEND_API_BASE ||
  "http://127.0.0.1:8000";

const SERVICE_SECRET = process.env.BACKEND_API_SECRET || "";

type AppUser = {
  id: number;
  email?: string;
  name: string;
  college: string;
  branch: string;
  semester: string;
  section: string;
  default_target: number;
  is_pro?: boolean;
  subscription_plan?: string;
  subscription_status?: string;
};

type SaveTokenBody = {
  user_id?: unknown;
  token?: unknown;
  platform?: unknown;
  user_agent?: unknown;
};

async function syncCurrentUser(): Promise<AppUser | Response> {
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

  let response: Response;

  try {
    response = await fetch(`${API_BASE}/auth/google-user`, {
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

  if (!response.ok) {
    const text = await response.text();
    return Response.json(
      { error: "Failed to sync user", details: text },
      { status: response.status }
    );
  }

  return response.json();
}

function cleanOptionalString(value: unknown) {
  return typeof value === "string" ? value.slice(0, 512) : "";
}

export async function POST(request: Request) {
  const userOrResponse = await syncCurrentUser();

  if (userOrResponse instanceof Response) {
    return userOrResponse;
  }

  let body: SaveTokenBody;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const requestedUserId = Number(body.user_id);
  const token = typeof body.token === "string" ? body.token.trim() : "";

  if (!Number.isFinite(requestedUserId) || requestedUserId <= 0) {
    return Response.json({ error: "Invalid user id" }, { status: 400 });
  }

  if (requestedUserId !== userOrResponse.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!token) {
    return Response.json({ error: "Missing push token" }, { status: 400 });
  }

  let backendResponse: Response;

  try {
    backendResponse = await fetch(`${API_BASE}/api/save-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bunkmax-service-secret": SERVICE_SECRET,
      },
      body: JSON.stringify({
        user_id: userOrResponse.id,
        token,
        platform: cleanOptionalString(body.platform),
        user_agent: cleanOptionalString(body.user_agent),
      }),
      cache: "no-store",
    });
  } catch {
    return Response.json(
      { error: "Backend is unreachable. Please try again shortly." },
      { status: 502 }
    );
  }

  const text = await backendResponse.text();

  return new Response(text, {
    status: backendResponse.status,
    headers: {
      "Content-Type":
        backendResponse.headers.get("content-type") || "application/json",
    },
  });
}
