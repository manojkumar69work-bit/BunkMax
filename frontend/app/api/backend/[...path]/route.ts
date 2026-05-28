import { auth } from "@/auth";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

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

type RouteContext = {
  params: Promise<{
    path?: string[];
  }>;
};

function backendUrl(path: string[], search: string) {
  const base = API_BASE.replace(/\/$/, "");
  const joinedPath = path.map(encodeURIComponent).join("/");
  return `${base}/${joinedPath}${search}`;
}

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

  let res: Response;

  try {
    res = await fetch(`${API_BASE}/auth/google-user`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bunkmax-service-secret": SERVICE_SECRET,
      },
      body: JSON.stringify({
        email,
        name,
      }),
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

  return res.json();
}

function requestedUserId(path: string[]) {
  if (path[0] !== "users") return null;

  const id = Number(path[1]);

  if (!Number.isFinite(id) || id <= 0) {
    return null;
  }

  return id;
}

function isSubscriptionRequest(path: string[]) {
  return path[0] === "users" && path[2] === "subscription";
}

async function proxyToBackend(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const path = params.path || [];

  if (path[0] !== "users") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const userOrResponse = await syncCurrentUser();

  if (userOrResponse instanceof Response) {
    return userOrResponse;
  }

  const userIdFromPath = requestedUserId(path);

  if (!userIdFromPath || userIdFromPath !== userOrResponse.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!userOrResponse.is_pro && !isSubscriptionRequest(path)) {
    return Response.json(
      {
        error: "Subscription required",
        detail: "Please choose a plan to unlock BunkMax.",
      },
      { status: 402 }
    );
  }

  const headers = new Headers();
  headers.set("x-bunkmax-service-secret", SERVICE_SECRET);

  const contentType = request.headers.get("content-type");
  if (contentType) {
    headers.set("content-type", contentType);
  }

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();

  let backendRes: Response;

  try {
    backendRes = await fetch(backendUrl(path, request.nextUrl.search), {
      method: request.method,
      headers,
      body,
      cache: "no-store",
    });
  } catch {
    return Response.json(
      { error: "Backend is unreachable. Please try again shortly." },
      { status: 502 }
    );
  }

  const responseHeaders = new Headers();

  const responseContentType = backendRes.headers.get("content-type");
  if (responseContentType) {
    responseHeaders.set("content-type", responseContentType);
  }

  return new Response(backendRes.body, {
    status: backendRes.status,
    headers: responseHeaders,
  });
}

export async function GET(request: NextRequest, context: RouteContext) {
  return proxyToBackend(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxyToBackend(request, context);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  return proxyToBackend(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxyToBackend(request, context);
}
