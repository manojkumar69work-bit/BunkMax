import { auth } from "@/auth";
import { NextRequest } from "next/server";
import { unstable_cache } from "next/cache";

export const dynamic = "force-dynamic";

// Allow the serverless function to stay alive long enough to survive a rare
// Render cold start (~50s). Vercel Hobby caps this at 60s.
export const maxDuration = 60;

const API_BASE =
  process.env.BACKEND_API_BASE ||
  "http://127.0.0.1:8000";

const SERVICE_SECRET = process.env.BACKEND_API_SECRET || "";

// How long to wait on the backend before giving up. Kept under maxDuration so
// we return a clean error instead of the platform killing the function. The old
// value here was 5s, which meant every request failed during a cold start.
const BACKEND_TIMEOUT_MS = Number(process.env.BACKEND_TIMEOUT_MS) || 30000;

// Read-only endpoints that we can let the Vercel CDN serve from cache. URLs
// already vary by user id in the path, so cross-user leakage isn't possible.
// Writes (mark-attendance / save / import / verify / delete / friends) are
// always passed through.
type CacheableSpec = {
  pattern: RegExp;
  sMaxAge: number; // seconds: how long the CDN serves from cache
  swr: number; // seconds: stale-while-revalidate window
};

const CACHEABLE_GETS: CacheableSpec[] = [
  { pattern: /^\/users\/\d+\/home-data$/, sMaxAge: 15, swr: 120 },
  { pattern: /^\/users\/\d+\/dashboard$/, sMaxAge: 15, swr: 120 },
  { pattern: /^\/users\/\d+\/subjects$/, sMaxAge: 20, swr: 180 },
  { pattern: /^\/users\/\d+\/schedule$/, sMaxAge: 30, swr: 240 },
  { pattern: /^\/users\/\d+\/tomorrow$/, sMaxAge: 15, swr: 120 },
  { pattern: /^\/users\/\d+\/best-day$/, sMaxAge: 15, swr: 120 },
  { pattern: /^\/users\/\d+\/worst-day$/, sMaxAge: 15, swr: 120 },
  // Two students' attendance moves at most once a day, so a longer window is
  // safe here — and this is the one read that touches two users' rows.
  { pattern: /^\/users\/\d+\/buddies\/\d+\/best-day$/, sMaxAge: 60, swr: 300 },
  { pattern: /^\/users\/\d+$/, sMaxAge: 60, swr: 300 },
  { pattern: /^\/users\/\d+\/subscription$/, sMaxAge: 60, swr: 300 },
];

function cacheDirectiveFor(path: string[]) {
  const fullPath = "/" + path.join("/");
  for (const spec of CACHEABLE_GETS) {
    if (spec.pattern.test(fullPath)) {
      return `private, s-maxage=${spec.sMaxAge}, stale-while-revalidate=${spec.swr}`;
    }
  }
  return null;
}

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
  // Next.js already decodes path segments before passing them to the handler,
  // so joining directly is correct. Re-encoding here would double-encode
  // characters like `(`, `)`, `&`, and `%` (e.g. subject "Maths (B)").
  const joinedPath = path.join("/");
  return `${base}/${joinedPath}${search}`;
}

// The auth-sync endpoint runs on every backend call, and the response (the
// user record) is essentially immutable for the duration of a session. We
// cache it via Vercel's Data Cache keyed by email for 240s so that:
//   * cold lambda → still cached → no DB hit
//   * parallel calls within a warm window → single backend call
// This is the single biggest backend load reduction: we go from "DB hit per
// API call" to "DB hit per (email, 240s)".
//
// We re-implement the sync locally rather than fetching through the cache
// wrapper so the cache key is just the args; unstable_cache wraps any async
// function. The cached function performs the actual /auth/google-user call.
async function syncUserUncached(
  emailKey: string,
  email: string,
  name: string,
): Promise<AppUser> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);

  try {
    const res = await fetch(`${API_BASE}/auth/google-user`, {
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
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw Object.assign(
        new Error(`Auth sync failed (${res.status}): ${text}`),
        { status: res.status },
      );
    }

    return (await res.json()) as AppUser;
  } finally {
    clearTimeout(timeout);
  }
}

const cachedSyncUser = unstable_cache(
  // signature: (key, email, name) => Promise<AppUser>
  syncUserUncached as unknown as (
    a: string,
    b: string,
    c: string,
  ) => Promise<AppUser>,
  ["bunkmax:google-user-sync"],
  { revalidate: 240, tags: ["user-sync"] },
);

async function syncCurrentUser(): Promise<AppUser | Response> {
  const session = await auth();

  const email = session?.user?.email?.trim().toLowerCase();
  const name = session?.user?.name || "Student";

  if (!email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // If the JWT already has the backend user ID, skip the auth sync call
  if (typeof session?.backendUserId === "number") {
    return { id: session.backendUserId } as AppUser;
  }

  if (!SERVICE_SECRET) {
    return Response.json(
      { error: "Backend service secret is missing" },
      { status: 500 },
    );
  }

  try {
    const user = await cachedSyncUser(email, email, name);

    if (!user || typeof user.id !== "number") {
      return Response.json(
        { error: "Invalid user data from backend" },
        { status: 502 },
      );
    }

    return user;
  } catch (err: unknown) {
    const status =
      typeof err === "object" && err && "status" in err
        ? Number((err as { status: number }).status)
        : 0;

    if (status === 403) {
      return Response.json(
        { error: "Only MLRIT accounts are allowed" },
        { status: 403 },
      );
    }

    if (
      typeof err === "object" &&
      err &&
      "name" in err &&
      (err as { name: string }).name === "AbortError"
    ) {
      return Response.json(
        { error: "Server is waking up. Please try again in a few seconds." },
        { status: 504 },
      );
    }

    console.error("auth-sync failed for", email, err);
    return Response.json(
      { error: "Backend is unreachable. Please try again shortly." },
      { status: 502 },
    );
  }
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

// Next decodes each segment before we see it, so `%2F` arrives as a literal
// "/" *inside* a segment and `..%2F` as a dot segment. backendUrl() joins the
// segments verbatim (it must not re-encode — see the note there), and fetch()
// then resolves the dot segments: "users/1/../2/home-data" becomes
// "/users/2/home-data". That walks straight past the ownership check below,
// which only inspects path[1], and "users/1/..%2F..%2Fauth%2Fgoogle-user"
// escapes /users entirely onto a service-secret route. Since re-encoding is
// ruled out, refuse traversal instead.
function hasUnsafeSegment(path: string[]) {
  return path.some(
    (segment) =>
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\"),
  );
}

async function proxyToBackend(request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const path = params.path || [];

  // Must run before the ownership check: a traversal segment makes path[1]
  // look like the session's own id while the forwarded URL points elsewhere.
  if (hasUnsafeSegment(path)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

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

  // Subscription check disabled — uncomment to re-enable paywall
  // if (!userOrResponse.is_pro && !isSubscriptionRequest(path)) {
  //   return Response.json(
  //     {
  //       error: "Subscription required",
  //       detail: "Please choose a plan to unlock BunkMax.",
  //     },
  //     { status: 402 }
  //   );
  // }

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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);

  let backendRes: Response;

  try {
    backendRes = await fetch(backendUrl(path, request.nextUrl.search), {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      return Response.json(
        { error: "Backend request timed out. Please try again." },
        { status: 504 },
      );
    }
    return Response.json(
      { error: "Backend is unreachable. Please try again shortly." },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }

  const responseHeaders = new Headers();

  const responseContentType = backendRes.headers.get("content-type");
  if (responseContentType) {
    responseHeaders.set("content-type", responseContentType);
  }

  // Let the Vercel CDN cache safe read endpoints. Writes never reach here with
  // a Cache-Control because the matcher excludes them. We only set the header
  // on GETs to avoid leaking it onto responses with non-cacheable status codes
  // (e.g. errors from the backend).
  if (
    request.method === "GET" &&
    backendRes.ok
  ) {
    const directive = cacheDirectiveFor(path);
    if (directive) {
      responseHeaders.set("Cache-Control", directive);
    }
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
