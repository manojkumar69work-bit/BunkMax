const API_BASE = "https://bunkmax.onrender.com";

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = "Request failed";
    try {
      const data = await res.json();
      message = data.detail || data.message || message;
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

export async function getDashboard(userId: number) {
  const res = await fetch(`${API_BASE}/users/${userId}/dashboard`, {
    cache: "no-store",
  });
  return handleResponse<{
    current_avg: number;
    overall_percentage: number;
    total_present: number;
    total_absent: number;
    today_classes: {
      period_no: number;
      subject_name: string;
      marked_status?: "present" | "absent" | null;
    }[];
  }>(res);
}

export async function getTomorrow(userId: number) {
  const res = await fetch(`${API_BASE}/users/${userId}/quick-actions/tomorrow`, {
    cache: "no-store",
  });
  return handleResponse<{
    title: string;
    current: number;
    new: number;
    drop: number;
    safe: boolean;
  }>(res);
}

export async function getBestDay(userId: number) {
  const res = await fetch(`${API_BASE}/users/${userId}/quick-actions/best-day`, {
    cache: "no-store",
  });
  return handleResponse<{
    title: string;
    current: number;
    new: number;
    drop: number;
    safe: boolean;
  }>(res);
}

export async function getWorstDay(userId: number) {
  const res = await fetch(`${API_BASE}/users/${userId}/quick-actions/worst-day`, {
    cache: "no-store",
  });
  return handleResponse<{
    title: string;
    current: number;
    new: number;
    drop: number;
    safe: boolean;
  }>(res);
}

export async function getSubjects(userId: number) {
  const res = await fetch(`${API_BASE}/users/${userId}/subjects`, {
    cache: "no-store",
  });
  return handleResponse<
    {
      id: number;
      subject_name: string;
      attended_classes: number;
      total_classes: number;
      required_percentage: number;
      attendance_percentage: number;
      safe_bunks: number;
      need_to_recover: number;
      status: string;
    }[]
  >(res);
}

export async function saveSubject(
  payload: {
    subject_name: string;
    attended_classes: number;
    total_classes: number;
    required_percentage: number;
  },
  userId: number
) {
  const res = await fetch(`${API_BASE}/users/${userId}/subjects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return handleResponse<{ message: string }>(res);
}

export async function deleteSubject(subjectName: string, userId: number) {
  const res = await fetch(
    `${API_BASE}/users/${userId}/subjects/${encodeURIComponent(subjectName)}`,
    { method: "DELETE" }
  );
  return handleResponse<{ message: string }>(res);
}

export async function getTimetable(userId: number) {
  const res = await fetch(`${API_BASE}/users/${userId}/timetable`, {
    cache: "no-store",
  });
  return handleResponse<Record<string, string[]>>(res);
}

export async function saveTimetable(
  entries: { day_name: string; period_no: number; subject_name: string }[],
  userId: number
) {
  const res = await fetch(`${API_BASE}/users/${userId}/timetable`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entries),
  });
  return handleResponse<{ message: string }>(res);
}

export async function getUser(userId: number) {
  const res = await fetch(`${API_BASE}/users/${userId}`, {
    cache: "no-store",
  });
  return handleResponse<{
    id: number;
    email?: string;
    name: string;
    college: string;
    branch: string;
    semester: string;
    section: string;
    default_target: number;
  }>(res);
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
  const res = await fetch(`${API_BASE}/users/${userId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return handleResponse<{ message: string }>(res);
}

export async function planBunks(
  payload:
    | { mode: "tomorrow" }
    | { mode: "next_n_days"; n_days: number }
    | { mode: "selected_weekdays"; selected_days: string[]; weeks: number },
  userId: number
) {
  const res = await fetch(`${API_BASE}/users/${userId}/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return handleResponse<{
    scenario_label: string;
    current_avg: number;
    predicted_avg: number;
    drop: number;
  }>(res);
}

export async function markAttendance(
  payload: {
    subject_name: string;
    period_no: number;
    status: "present" | "absent";
  },
  userId: number
) {
  const res = await fetch(`${API_BASE}/users/${userId}/mark-attendance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return handleResponse<{ message: string; status: string | null }>(res);
}