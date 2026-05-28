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

export type HomeDataResponse = {
  dashboard: DashboardResponse;
  subjects: HomeSubject[];
};

export type QuickResultResponse = {
  title: string;
  new_overall: number;
  drop_overall: number;
  new_avg: number;
  drop_avg: number;
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
  id: "free" | "pro_monthly" | "pro_yearly";
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
      throw new Error("Server is waking up. Please try again in a few seconds.");
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
      return await fetchWithTimeout(url, options, timeoutMs);
    } catch (error: unknown) {
      lastError = error;
      const message = errorMessage(error);

      // Don't retry on client errors (4xx) or timeout errors
      if (
        message.includes("timeout") ||
        message.includes("4")
      ) {
        throw error;
      }

      // Wait before retrying (exponential backoff)
      if (i < maxRetries) {
        const delay = Math.pow(2, i) * 1000; // 1s, 2s, 4s
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
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
  const res = await fetchWithRetry(`${API_BASE}/users/${userId}/clear-data`, {
    method: "DELETE",
  });

  return handleResponse<{ message: string }>(res);
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
  payload: { plan_id: "pro_monthly" | "pro_yearly" },
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

export async function getDashboard(userId: number) {
  return fetchDeduped(`dashboard-${userId}`, async () => {
    const res = await fetchWithRetry(`${API_BASE}/users/${userId}/dashboard`);
    return handleResponse<DashboardResponse>(res);
  });
}

export async function getHomeData(userId: number) {
  return fetchDeduped(`home-data-${userId}`, async () => {
    const res = await fetchWithRetry(`${API_BASE}/users/${userId}/home-data`);
    return handleResponse<HomeDataResponse>(res);
  });
}

export async function getTomorrow(userId: number) {
  const res = await fetchWithRetry(`${API_BASE}/users/${userId}/tomorrow`);
  return handleResponse<QuickResultResponse>(res);
}

export async function getBestDay(userId: number) {
  const res = await fetchWithRetry(`${API_BASE}/users/${userId}/best-day`);
  return handleResponse<QuickResultResponse>(res);
}

export async function getWorstDay(userId: number) {
  const res = await fetchWithRetry(`${API_BASE}/users/${userId}/worst-day`);
  return handleResponse<QuickResultResponse>(res);
}

export async function markAttendance(
  payload: {
    subject_name: string;
    period_no: number;
    status: "present" | "absent";
  },
  userId: number
) {
  const res = await fetchWithRetry(`${API_BASE}/users/${userId}/mark-attendance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return handleResponse<{ message: string }>(res);
}

/* ---------------- IMPORT ---------------- */

export async function importAttendance(
  payload: {
    subjects: ImportSubject[];
    attendance: Record<string, ImportAttendanceStats>;
  },
  userId: number
) {
  const res = await fetchWithRetry(
    `${API_BASE}/users/${userId}/import-attendance`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );

  return handleResponse<{ message: string; subjects_imported?: number }>(res);
}

/* ---------------- SUBJECTS ---------------- */

export async function getSubjects(userId: number) {
  return fetchDeduped(`subjects-${userId}`, async () => {
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
  // Clear cache after save
  pendingRequests.delete(`subjects-${userId}`);

  const res = await fetchWithRetry(`${API_BASE}/users/${userId}/subjects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return handleResponse<{ message: string }>(res);
}

export async function deleteSubject(subjectId: number, userId: number) {
  // Clear cache after delete
  pendingRequests.delete(`subjects-${userId}`);

  const res = await fetchWithRetry(
    `${API_BASE}/users/${userId}/subjects/${subjectId}`,
    {
      method: "DELETE",
    }
  );

  return handleResponse<{ message: string }>(res);
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
  return fetchDeduped(`schedule-${userId}`, async () => {
    const res = await fetchWithRetry(`${API_BASE}/users/${userId}/schedule`);
    const data = await handleResponse<unknown>(res);
    return normalizeScheduleResponse(data);
  });
}

export async function saveSchedule(payload: ScheduleEntry[], userId: number) {
  // Clear cache after save
  pendingRequests.delete(`schedule-${userId}`);

  const res = await fetchWithRetry(`${API_BASE}/users/${userId}/schedule`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return handleResponse<{ message: string }>(res);
}

/* ---------------- BACKWARD COMPATIBILITY ---------------- */

export async function getTimetable(userId: number) {
  return getSchedule(userId);
}

export async function saveTimetable(payload: ScheduleEntry[], userId: number) {
  return saveSchedule(payload, userId);
}

/* ---------------- PLAN ---------------- */

export async function planBunks(
  payload: {
    mode: "tomorrow" | "next_n_days" | "selected_weekdays";
    n_days?: number;
    weeks?: number;
    selected_days?: string[];
  },
  userId: number
) {
  const res = await fetchWithRetry(`${API_BASE}/users/${userId}/plan-bunks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return handleResponse<{
    scenario_label: string;
    new_overall: number;
    drop_overall: number;
    new_avg: number;
    drop_avg: number;
  }>(res);
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
