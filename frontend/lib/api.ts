export const API_BASE = "/api/backend";

type JsonRecord = Record<string, unknown>;

export type AppUserResponse = {
  id: number;
  name: string;
  email?: string;
  college: string;
  branch: string;
  semester: string;
  section: string;
  default_target: number;
  is_pro: boolean;
  subscription_plan: string;
  subscription_status: string;
  subscription_renews_at?: string | null;
};

export type DashboardResponse = {
  current_avg: number;
  overall_percentage: number;
  total_present: number;
  total_absent: number;
  today_classes: {
    period_no: number;
    subject_name: string;
    marked_status?: "present" | "absent" | null;
  }[];
};

export type HomeSubject = {
  subject_name: string;
  attended_classes: number;
  total_classes: number;
};

export type QuickResultResponse = {
  title: string;
  new_overall: number;
  drop_overall: number;
  new_avg: number;
  drop_avg: number;
};

export type HomeDataResponse = {
  dashboard: DashboardResponse;
  subjects: HomeSubject[];
  tomorrow: QuickResultResponse;
  best_day: QuickResultResponse;
  worst_day: QuickResultResponse;
};

export type ImportSubject = {
  subjectid: string;
  subject_name: string;
};

export type ImportAttendanceStats = {
  totalsessions: number;
  presentSessionsCount: number;
  percentage?: string | number;
};

export type SubjectResponse = {
  id: number;
  subject_name: string;
  attended_classes: number;
  total_classes: number;
  required_percentage?: number;
  attendance_percentage?: number;
  safe_bunks?: number;
  need_to_recover?: number;
  status?: string;
};

export type ScheduleEntry = {
  day_name: string;
  period_no: number;
  subject_name: string;
};

export type SubscriptionPlan = {
  id: "free" | "pro_3mo" | "pro_6mo" | "pro_monthly" | "pro_yearly";
  name: string;
  price_rupees: number;
  billing_interval: string;
  description: string;
  features: string[];
  highlighted: boolean;
};

export type CurrentSubscription = {
  plan_id: string;
  plan_name: string;
  status: string;
  is_pro: boolean;
  renews_at?: string | null;
  provider: string;
};

export type SubscriptionResponse = {
  current: CurrentSubscription;
  plans: SubscriptionPlan[];
};

export type SubscriptionOrderResponse = {
  provider: string;
  plan: SubscriptionPlan;
  order_id: string;
  amount: number;
  currency: string;
  amount_rupees: number;
  message: string;
};

export type SubscriptionPaymentVerificationResponse = {
  message: string;
  current: CurrentSubscription;
};

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

class RequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestTimeoutError";
  }
}

function stringFromUnknown(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (isRecord(value)) return JSON.stringify(value);
  return null;
}

function isScheduleEntry(value: unknown): value is ScheduleEntry {
  if (!isRecord(value)) return false;

  return (
    typeof value.day_name === "string" &&
    typeof value.subject_name === "string" &&
    Number.isFinite(Number(value.period_no))
  );
}

// Request deduplication cache
const pendingRequests = new Map<string, Promise<unknown>>();

// Request timeout wrapper
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 30000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      credentials: "include",
      ...options,
      signal: controller.signal,
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new RequestTimeoutError(
        "Server is waking up. Please try again in a few seconds."
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Retry logic with exponential backoff
async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  maxRetries: number = 2,
  timeoutMs: number = 30000
): Promise<Response> {
  let lastError: unknown = new Error("Request failed");

  for (let i = 0; i <= maxRetries; i++) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);

      if (response.status >= 400 && response.status < 500) {
        return response;
      }

      if (response.status < 500 || i === maxRetries) {
        return response;
      }
    } catch (error: unknown) {
      lastError = error;

      if (error instanceof RequestTimeoutError) {
        throw error;
      }

      if (i < maxRetries) {
        const delay = Math.pow(2, i) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      continue;
    }

    if (i < maxRetries) {
      const delay = Math.pow(2, i) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// Response handler with better error messages
async function handleResponse<T>(res: Response): Promise<T> {
  let data: unknown = null;

  try {
    data = await res.json();
  } catch {
    if (!res.ok) {
      throw new Error(
        `Server error ${res.status}: ${res.statusText || "Unknown error"}`
      );
    }
    throw new Error("Server returned invalid JSON response");
  }

  if (!res.ok) {
    const detail = isRecord(data) ? data.detail : undefined;
    const messageValue = isRecord(data) ? data.message : undefined;
    const errorValue = isRecord(data) ? data.error : undefined;
    const detailsValue = isRecord(data) ? data.details : undefined;

    const message =
      typeof detail === "string"
        ? detail
        : typeof messageValue === "string"
        ? messageValue
        : typeof detailsValue === "string"
        ? detailsValue
        : typeof errorValue === "string"
        ? errorValue
        : Array.isArray(detail)
        ? JSON.stringify(detail)
        : res.status === 404
        ? "Resource not found"
        : res.status === 403
        ? "Access denied"
        : res.status === 400
        ? "Invalid request"
        : res.status >= 500
        ? stringFromUnknown(data) || "Server error - please try again later"
        : JSON.stringify(detail || messageValue || errorValue || detailsValue || data);

    throw new Error(message || "Something went wrong");
  }

  return data as T;
}

// Deduplication wrapper - prevents duplicate requests
async function fetchDeduped<T>(
  key: string,
  fetcher: () => Promise<T>
): Promise<T> {
  const pending = pendingRequests.get(key);

  if (pending) {
    return pending as Promise<T>;
  }

  const promise = fetcher().finally(() => {
    pendingRequests.delete(key);
  });

  pendingRequests.set(key, promise);
  return promise;
}

// sessionStorage-backed TTL cache. Serves fresh cached data across client-side
// navigations without a network call; falls through to `fetcher` when stale.
function readCache<T>(key: string, ttlMs: number): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { t: number; v: T };
    if (!parsed || Date.now() - parsed.t > ttlMs) return null;

    return parsed.v;
  } catch {
    return null;
  }
}

function writeCache<T>(key: string, value: T) {
  const entry = JSON.stringify({ t: Date.now(), v: value });

  try {
    sessionStorage.setItem(key, entry);
  } catch {
    /* quota exceeded / unavailable */
  }

  // Mirror into localStorage so a peek can still paint something after the tab
  // was closed or the PWA was killed, when sessionStorage is already gone.
  try {
    localStorage.setItem(mirrorKey(key), entry);
  } catch {
    /* quota exceeded / unavailable */
  }
}

function mirrorKey(key: string) {
  return `swr:${key}`;
}

// Last known value for `key`, however old. Backs the stale half of
// stale-while-revalidate: paint this immediately, then let the network refresh
// replace it, so a revisit never sits on a skeleton.
function readStale<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(mirrorKey(key));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { t: number; v: T };
    return parsed ? parsed.v : null;
  } catch {
    return null;
  }
}

// Bumped by every invalidation. A read that started before the bump may be
// carrying pre-write data, so cachedFetch won't store a result whose epoch
// moved while it was in flight.
let cacheEpoch = 0;

export function invalidateCache(...keys: string[]) {
  cacheEpoch++;
  for (const key of keys) {
    try {
      sessionStorage.removeItem(key);
      localStorage.removeItem(mirrorKey(key));
    } catch {
      /* ignore */
    }
    pendingRequests.delete(key);
  }
}

// Drops every cached entry whose key starts with `prefix`. For key families
// that can't be listed up front — one buddy-plan entry per buddy, say.
export function invalidateCachePrefix(prefix: string) {
  cacheEpoch++;
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(prefix)) sessionStorage.removeItem(key);
    }
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(mirrorKey(prefix))) localStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }

  for (const key of pendingRequests.keys()) {
    if (key.startsWith(prefix)) pendingRequests.delete(key);
  }
}

async function cachedFetch<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const cached = readCache<T>(key, ttlMs);
  if (cached !== null) return cached;

  const epoch = cacheEpoch;
  const value = await fetchDeduped(key, fetcher);
  if (epoch === cacheEpoch) writeCache(key, value);
  return value;
}

// Runs a write between two invalidations. The first stops pages serving the
// old value while the write is in flight; the second drops anything a read
// cached during that window, which can only be the pre-write data.
async function writeThrough<T>(
  invalidate: () => void,
  request: () => Promise<T>
): Promise<T> {
  invalidate();
  try {
    return await request();
  } finally {
    invalidate();
  }
}

// Every read that attendance, subjects or the timetable feed into.
function invalidateAttendanceReads(userId: number) {
  invalidateCache(
    `home-data-${userId}`,
    `dashboard-${userId}`,
    `subjects-${userId}`,
    `schedule-${userId}`
  );
  invalidateCachePrefix(buddyPlanPrefix(userId));
}

// Cache TTL for attendance/schedule reads (ms).
const READ_TTL = 60 * 1000;

// Synchronous cache peek. Lets a page seed its initial state from a prior
// fetch so cached content paints immediately instead of flashing a loader.
// Returns null when the entry is missing or older than READ_TTL.
// These peeks are stale-while-revalidate: they return the last known value at
// any age, so a page seeds from them and paints at once. They are for SEEDING
// ONLY — never gate a fetch on one, or the stale value suppresses the refresh
// that would replace it. Guard freshness with the TTL inside cachedFetch.
export function getCachedHomeData(userId: number): HomeDataResponse | null {
  const key = `home-data-${userId}`;
  return readCache<HomeDataResponse>(key, READ_TTL) ?? readStale<HomeDataResponse>(key);
}

export function getCachedSubjects(userId: number): SubjectResponse[] | null {
  const key = `subjects-${userId}`;
  return readCache<SubjectResponse[]>(key, READ_TTL) ?? readStale<SubjectResponse[]>(key);
}

export function getCachedSchedule(userId: number): ScheduleEntry[] | null {
  const key = `schedule-${userId}`;
  return readCache<ScheduleEntry[]>(key, READ_TTL) ?? readStale<ScheduleEntry[]>(key);
}

export function getCachedBuddies(userId: number): BuddyListResponse | null {
  const key = buddyListKey(userId);
  return readCache<BuddyListResponse>(key, READ_TTL) ?? readStale<BuddyListResponse>(key);
}

export function getCachedBuddyPlan(
  userId: number,
  buddyId: number
): BuddyPlanResponse | null {
  const key = buddyPlanKey(userId, buddyId);
  return readCache<BuddyPlanResponse>(key, READ_TTL) ?? readStale<BuddyPlanResponse>(key);
}

// Drop every cached read. Call on logout so the next account on this device
// can't be shown the previous one's buddies.
export function clearReadCache() {
  cacheEpoch++;
  try {
    sessionStorage.clear();
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("swr:")) localStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
  pendingRequests.clear();
}

/* ---------------- USER ---------------- */

export async function getUser(userId: number) {
  const res = await fetchWithRetry(`${API_BASE}/users/${userId}`);
  return handleResponse<AppUserResponse>(res);
}

export async function updateUser(
  payload: {
    name: string;
    college: string;
    branch: string;
    semester: string;
    section: string;
    default_target: number;
    tagline?: string;
    links?: { label: string; url: string }[];
  },
  userId: number
) {
  const res = await fetchWithRetry(`${API_BASE}/users/${userId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return handleResponse<{ message: string }>(res);
}

export async function clearAllUserData(userId: number) {
  const invalidate = () => {
    invalidateAttendanceReads(userId);
    invalidateCache(buddyListKey(userId));
  };

  return writeThrough(invalidate, async () => {
    const res = await fetchWithRetry(`${API_BASE}/users/${userId}/clear-data`, {
      method: "DELETE",
    });

    return handleResponse<{ message: string }>(res);
  });
}

export async function getSubscription(userId: number) {
  const res = await fetchWithRetry(
    `${API_BASE}/users/${userId}/subscription`,
    {},
    1,
    60000
  );
  return handleResponse<SubscriptionResponse>(res);
}

export async function createSubscriptionOrder(
  payload: { plan_id: "pro_3mo" | "pro_6mo" | "pro_monthly" | "pro_yearly" },
  userId: number
) {
  const res = await fetchWithRetry(
    `${API_BASE}/users/${userId}/subscription/create-order`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    1,
    60000
  );

  return handleResponse<SubscriptionOrderResponse>(res);
}

export async function verifySubscriptionPayment(
  payload: {
    razorpay_payment_id: string;
    razorpay_order_id: string;
    razorpay_signature: string;
  },
  userId: number
) {
  const res = await fetchWithRetry(
    `${API_BASE}/users/${userId}/subscription/verify-payment`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    1,
    60000
  );

  return handleResponse<SubscriptionPaymentVerificationResponse>(res);
}

/* ---------------- DASHBOARD / HOME ---------------- */

export async function getHomeData(userId: number) {
  return cachedFetch(`home-data-${userId}`, READ_TTL, async () => {
    const res = await fetchWithRetry(`${API_BASE}/users/${userId}/home-data`);
    return handleResponse<HomeDataResponse>(res);
  });
}

export async function markAttendance(
  payload: {
    subject_name: string;
    period_no: number;
    status: "present" | "absent";
  },
  userId: number
) {
  return writeThrough(() => invalidateAttendanceReads(userId), async () => {
    const res = await fetchWithRetry(`${API_BASE}/users/${userId}/mark-attendance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    return handleResponse<{ message: string }>(res);
  });
}

/* ---------------- IMPORT ---------------- */

export async function importAttendance(
  payload: {
    subjects: ImportSubject[];
    attendance: Record<string, ImportAttendanceStats>;
  },
  userId: number
) {
  return writeThrough(() => invalidateAttendanceReads(userId), async () => {
    const res = await fetchWithRetry(
      `${API_BASE}/users/${userId}/import-attendance`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    return handleResponse<{ message: string; subjects_imported?: number }>(res);
  });
}

/* ---------------- ERP PORTAL SYNC ---------------- */

export type ErpSyncResult = {
  message: string;
  subjects_imported: number;
  periods_imported?: number;
  timetable_conflicts?: string[];
  average?: number;
  student?: { name?: string; prn?: string; stuid?: number };
  credentials_saved?: boolean;
  // Set when the sync succeeded but the login could not be persisted
  // (server-side encrypted storage unconfigured). A warning, not a failure.
  credentials_error?: string;
};

export type ErpStatus = {
  saved: boolean;
  // False when the server has no ERP_CRED_KEY, so logins cannot be saved.
  crypto_available?: boolean;
  erp_username?: string;
  institute_slug?: string;
  last_synced_at?: string | null;
  last_sync_status?: string;
};

// Live server-side login to the college portal. Slow (several portal round
// trips + a possible backend cold start), so allow a generous timeout.
export async function erpSync(
  payload: {
    erp_username: string;
    erp_password: string;
    institute_slug?: string;
    save_credentials: boolean;
  },
  userId: number
) {
  // The portal sync replaces the timetable too, so the schedule read goes.
  return writeThrough(() => invalidateAttendanceReads(userId), async () => {
    const res = await fetchWithRetry(
      `${API_BASE}/users/${userId}/erp-sync`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      0,
      60000
    );

    return handleResponse<ErpSyncResult>(res);
  });
}

// Re-sync using credentials already stored on the server (no password sent).
export async function erpResync(userId: number) {
  return writeThrough(() => invalidateAttendanceReads(userId), async () => {
    const res = await fetchWithRetry(
      `${API_BASE}/users/${userId}/erp-resync`,
      { method: "POST" },
      0,
      60000
    );

    return handleResponse<ErpSyncResult>(res);
  });
}

export async function getErpStatus(userId: number) {
  const res = await fetchWithRetry(`${API_BASE}/users/${userId}/erp-status`);
  return handleResponse<ErpStatus>(res);
}

export async function deleteErpCredentials(userId: number) {
  const res = await fetchWithRetry(`${API_BASE}/users/${userId}/erp-credentials`, {
    method: "DELETE",
  });
  return handleResponse<{ message: string }>(res);
}

/* ---------------- SUBJECTS ---------------- */

export async function getSubjects(userId: number) {
  return cachedFetch(`subjects-${userId}`, READ_TTL, async () => {
    const res = await fetchWithRetry(`${API_BASE}/users/${userId}/subjects`);
    const data = await handleResponse<unknown>(res);

    if (Array.isArray(data)) return data as SubjectResponse[];
    if (isRecord(data) && Array.isArray(data.subjects)) {
      return data.subjects as SubjectResponse[];
    }
    return [];
  });
}

export async function saveSubject(
  payload: {
    subject_name: string;
    attended_classes: number;
    total_classes: number;
    required_percentage?: number;
  },
  userId: number
) {
  return writeThrough(() => invalidateAttendanceReads(userId), async () => {
    const res = await fetchWithRetry(`${API_BASE}/users/${userId}/subjects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    return handleResponse<{ message: string }>(res);
  });
}

export async function deleteSubject(subjectId: number, userId: number) {
  return writeThrough(() => invalidateAttendanceReads(userId), async () => {
    const res = await fetchWithRetry(
      `${API_BASE}/users/${userId}/subjects/${subjectId}`,
      {
        method: "DELETE",
      }
    );

    return handleResponse<{ message: string }>(res);
  });
}

/* ---------------- SCHEDULE / TIMETABLE ---------------- */

function normalizeScheduleResponse(data: unknown): ScheduleEntry[] {
  if (Array.isArray(data)) return data.filter(isScheduleEntry);

  if (isRecord(data) && Array.isArray(data.schedule)) {
    return data.schedule.filter(isScheduleEntry);
  }

  if (isRecord(data) && Array.isArray(data.timetable)) {
    return data.timetable.filter(isScheduleEntry);
  }

  return [];
}

export async function getSchedule(userId: number) {
  return cachedFetch(`schedule-${userId}`, READ_TTL, async () => {
    const res = await fetchWithRetry(`${API_BASE}/users/${userId}/schedule`);
    const data = await handleResponse<unknown>(res);
    return normalizeScheduleResponse(data);
  });
}

export async function saveSchedule(payload: ScheduleEntry[], userId: number) {
  return writeThrough(() => invalidateAttendanceReads(userId), async () => {
    const res = await fetchWithRetry(`${API_BASE}/users/${userId}/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    return handleResponse<{ message: string }>(res);
  });
}

/* ---------------- BACKWARD COMPATIBILITY ---------------- */

export async function getTimetable(userId: number) {
  return getSchedule(userId);
}

export async function saveTimetable(payload: ScheduleEntry[], userId: number) {
  return saveSchedule(payload, userId);
}

/* ---------------- CALENDAR PLAN ---------------- */

export async function calendarPlan(
  payload: {
    days: Array<{
      date: string;
      status: "present" | "absent";
    }>;
  },
  userId: number
) {
  const res = await fetchWithRetry(
    `${API_BASE}/users/${userId}/calendar-plan`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );

  return handleResponse<{
    scenario_label: string;
    current_overall: number;
    new_overall: number;
    change_overall: number;
    current_avg: number;
    new_avg: number;
    change_avg: number;
    simulated_sessions: number;
    skipped_dates: Array<{
      date: string;
      reason: string;
    }>;
  }>(res);
}

// ─── Feed Types ────────────────────────────────────────
export type FeedPollOption = {
  id: number;
  option_text: string;
  votes_count: number;
};

export type FeedPoll = {
  id: number;
  question: string;
  options: FeedPollOption[];
};

export type FeedPost = {
  id: number;
  user_id: number;
  user_name: string;
  content: string;
  media_url: string;
  view_count: number;
  created_at: string;
  like_count: number;
  comment_count: number;
  is_liked?: boolean;
  poll: FeedPoll | null;
};

export type FeedResponse = {
  posts: FeedPost[];
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
};

export type FeedComment = {
  id: number;
  user_id: number;
  user_name: string;
  content: string;
  created_at: string;
};

// ─── Feed Functions ────────────────────────────────────
export async function getFeedPosts(page: number = 1, limit: number = 10, userId?: number) {
  const url = userId
    ? `${API_BASE}/feed/posts?page=${page}&limit=${limit}&user_id=${userId}`
    : `${API_BASE}/feed/posts?page=${page}&limit=${limit}`;
  const res = await fetchWithRetry(url);
  return handleResponse<FeedResponse>(res);
}

export async function createFeedPost(payload: {
  user_id: number;
  content: string;
  media_url?: string;
  poll?: { question: string; options: { text: string }[] } | null;
}) {
  const res = await fetchWithRetry(`${API_BASE}/feed/posts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return handleResponse<FeedPost>(res);
}

export async function deleteFeedPost(postId: number, userId: number) {
  const res = await fetchWithRetry(`${API_BASE}/feed/posts/${postId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId }),
  });
  return handleResponse<{ message: string }>(res);
}

export async function toggleFeedLike(postId: number, userId: number) {
  const res = await fetchWithRetry(`${API_BASE}/feed/posts/${postId}/like`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId }),
  });
  return handleResponse<{ liked: boolean; message: string }>(res);
}

export async function getFeedComments(postId: number) {
  const res = await fetchWithRetry(`${API_BASE}/feed/posts/${postId}/comments`);
  return handleResponse<FeedComment[]>(res);
}

export async function addFeedComment(
  postId: number,
  payload: { user_id: number; content: string },
) {
  const res = await fetchWithRetry(`${API_BASE}/feed/posts/${postId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return handleResponse<FeedComment>(res);
}

export async function trackPostView(postId: number) {
  const res = await fetchWithRetry(`${API_BASE}/feed/posts/${postId}/view`, {
    method: "POST",
  });
  return handleResponse<{ view_count: number }>(res);
}

export async function voteOnPoll(postId: number, userId: number, optionId: number) {
  const res = await fetchWithRetry(`${API_BASE}/feed/posts/${postId}/vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, option_id: optionId }),
  });
  return handleResponse<{ message: string }>(res);
}

export async function getUserByEmailPrefix(prefix: string) {
  const res = await fetchWithRetry(
    `${API_BASE}/users/by-email-prefix/${encodeURIComponent(prefix)}`,
  );
  return handleResponse<{ id: number; name: string; email: string }>(res);
}

// ─── Friends Types ─────────────────────────────────────
export type FriendUser = {
  id: number;
  user_id: number;
  friendship_id: number;
  name: string;
  email: string;
};

export type SearchUserResult = {
  id: number;
  name: string;
  email: string;
};

// ─── Friends Functions ─────────────────────────────────
export async function getFriends(userId: number) {
  const res = await fetchWithRetry(`${API_BASE}/users/${userId}/friends`);
  return handleResponse<{ friends: FriendUser[] }>(res);
}

export async function getFriendRequests(userId: number) {
  const res = await fetchWithRetry(`${API_BASE}/users/${userId}/friend-requests`);
  return handleResponse<{ incoming: FriendUser[]; outgoing: FriendUser[] }>(res);
}

export async function sendFriendRequest(userId: number, targetUserId: number) {
  const res = await fetchWithRetry(    `${API_BASE}/users/${userId}/friend-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target_user_id: targetUserId }),
  });
  return handleResponse<{ message: string; status?: string }>(res);
}

export async function respondFriendRequest(userId: number, requesterId: number, accept: boolean | string) {
  const accepted = typeof accept === "boolean" ? accept : accept === "accept";
  const res = await fetchWithRetry(
    `${API_BASE}/users/${userId}/friend-requests/${requesterId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accept: accepted }),
    },
  );
  return handleResponse<{ message: string; status?: string }>(res);
}

export async function removeFriend(userId: number, friendId: number) {
  const res = await fetchWithRetry(
    `${API_BASE}/users/${userId}/friends/${friendId}`,
    { method: "DELETE" },
  );
  return handleResponse<{ message: string }>(res);
}

export async function searchUsers(query: string) {
  const res = await fetchWithRetry(
    `${API_BASE}/users/search?q=${encodeURIComponent(query)}`,
  );
  return handleResponse<SearchUserResult[]>(res);
}

// ─── Profile Types ─────────────────────────────────────
export type UserProfile = {
  id: number;
  name: string;
  email: string;
  college: string;
  branch: string;
  semester: string;
  section: string;
  photo?: string;
  tagline?: string;
  links?: { label: string; url: string }[];
  post_count: number;
  friend_count: number;
  relationship?: string;
  relationship_friendship_id?: number;
  recent_posts?: FeedPost[];
};

// ─── Profile Functions ─────────────────────────────────
export async function getUserProfile(userId: number, currentUserId?: number) {
  const url = currentUserId
    ? `${API_BASE}/users/${userId}/profile?current_user_id=${currentUserId}`
    : `${API_BASE}/users/${userId}/profile`;
  const res = await fetchWithRetry(url);
  return handleResponse<UserProfile>(res);
}

// ─── Spidy Types ───────────────────────────────────────
export type SpidySearchResult = {
  id: number;
  subject_name: string;
  drive_link: string;
  description: string;
};

// ─── Spidy Functions ───────────────────────────────────
export async function spidySearch(query: string) {
  const res = await fetchWithRetry(`${API_BASE}/spidy/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return handleResponse<{ results: SpidySearchResult[]; message: string }>(res);
}

// ─── Buddy Types ───────────────────────────────────────
export type Buddy = {
  id: number;
  name: string;
  email: string;
  since: string | null;
};

export type BuddyInvite = {
  code: string;
  expires_at: string;
};

export type BuddyListResponse = {
  buddies: Buddy[];
  max_buddies: number;
  invite: BuddyInvite | null;
};

export type BuddySide = {
  new_overall: number;
  drop_overall: number;
  classes_missed: number;
  subjects_missed: string[];
};

export type BuddyDay = {
  day: string;
  you: BuddySide;
  buddy: BuddySide;
  worst_drop: number;
  total_drop: number;
  is_best: boolean;
};

export type BuddyPlanResponse = {
  buddy: { id: number; name: string };
  current: { you: number; buddy: number };
  days: BuddyDay[];
  best_day: string | null;
  worst_day: string | null;
};

// ─── Buddy Functions ───────────────────────────────────
// Cache keys for the buddy page. The plan key carries both ids so every buddy
// gets its own entry, and `buddyPlanPrefix` clears the whole family at once.
function buddyListKey(userId: number) {
  return `buddies-${userId}`;
}

function buddyPlanPrefix(userId: number) {
  return `buddy-plan-${userId}-`;
}

function buddyPlanKey(userId: number, buddyId: number) {
  return `${buddyPlanPrefix(userId)}${buddyId}`;
}

export async function getBuddies(userId: number) {
  return cachedFetch(buddyListKey(userId), READ_TTL, async () => {
    const res = await fetchWithRetry(`${API_BASE}/users/${userId}/buddies`);
    return handleResponse<BuddyListResponse>(res);
  });
}

export async function createBuddyInvite(userId: number) {
  // The list response carries the active invite, so a new code stales it.
  return writeThrough(() => invalidateCache(buddyListKey(userId)), async () => {
    const res = await fetchWithRetry(`${API_BASE}/users/${userId}/buddy-invite`, {
      method: "POST",
    });
    return handleResponse<BuddyInvite & { expires_in_hours: number }>(res);
  });
}

export async function redeemBuddyCode(userId: number, code: string) {
  return writeThrough(() => invalidateCache(buddyListKey(userId)), async () => {
    const res = await fetchWithRetry(`${API_BASE}/users/${userId}/buddies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    return handleResponse<{ message: string; buddy: Buddy }>(res);
  });
}

export async function removeBuddy(userId: number, buddyId: number) {
  return writeThrough(
    () => invalidateCache(buddyListKey(userId), buddyPlanKey(userId, buddyId)),
    async () => {
      const res = await fetchWithRetry(
        `${API_BASE}/users/${userId}/buddies/${buddyId}`,
        { method: "DELETE" },
      );
      return handleResponse<{ message: string }>(res);
    },
  );
}

export async function getBuddyBestDay(userId: number, buddyId: number) {
  return cachedFetch(buddyPlanKey(userId, buddyId), READ_TTL, async () => {
    const res = await fetchWithRetry(
      `${API_BASE}/users/${userId}/buddies/${buddyId}/best-day`,
    );
    return handleResponse<BuddyPlanResponse>(res);
  });
}
