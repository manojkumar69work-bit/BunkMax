const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8000";

async function handleResponse<T>(res: Response): Promise<T> {
  let data: any = null;

  try {
    data = await res.json();
  } catch {
    if (!res.ok) {
      throw new Error(`Request failed with status ${res.status}`);
    }
    throw new Error("Invalid server response");
  }

  if (!res.ok) {
    const message =
      typeof data?.detail === "string"
        ? data.detail
        : typeof data?.message === "string"
        ? data.message
        : Array.isArray(data?.detail)
        ? JSON.stringify(data.detail)
        : JSON.stringify(data?.detail || data?.message || data);

    throw new Error(message || "Something went wrong");
  }

  return data;
}

/* ---------------- USER ---------------- */

export async function getUser(userId: number) {
  const res = await fetch(`${API_BASE}/users/${userId}`);
  return handleResponse<any>(res);
}

export async function updateUser(payload: any, userId: number) {
  const res = await fetch(`${API_BASE}/users/${userId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return handleResponse<{ message: string }>(res);
}

export async function clearAllUserData(userId: number) {
  const res = await fetch(`${API_BASE}/users/${userId}/clear-data`, {
    method: "DELETE",
  });

  return handleResponse<{ message: string }>(res);
}

/* ---------------- DASHBOARD / HOME ---------------- */

export async function getDashboard(userId: number) {
  const res = await fetch(`${API_BASE}/users/${userId}/dashboard`);
  return handleResponse<any>(res);
}

export async function getTomorrow(userId: number) {
  const res = await fetch(`${API_BASE}/users/${userId}/tomorrow`);
  return handleResponse<any>(res);
}

export async function getBestDay(userId: number) {
  const res = await fetch(`${API_BASE}/users/${userId}/best-day`);
  return handleResponse<any>(res);
}

export async function getWorstDay(userId: number) {
  const res = await fetch(`${API_BASE}/users/${userId}/worst-day`);
  return handleResponse<any>(res);
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

  return handleResponse<{ message: string }>(res);
}

/* ---------------- IMPORT ---------------- */

export async function importAttendance(
  payload: {
    subjects: any[];
    attendance: Record<string, any>;
  },
  userId: number
) {
  const res = await fetch(`${API_BASE}/users/${userId}/import-attendance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return handleResponse<{ message: string; subjects_imported?: number }>(res);
}

/* ---------------- SUBJECTS ---------------- */

export async function getSubjects(userId: number) {
  const res = await fetch(`${API_BASE}/users/${userId}/subjects`);
  const data = await handleResponse<any>(res);

  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.subjects)) return data.subjects;
  return [];
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
  const res = await fetch(`${API_BASE}/users/${userId}/subjects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return handleResponse<{ message: string }>(res);
}

export async function updateSubject(
  subjectId: number,
  payload: any,
  userId: number
) {
  const res = await fetch(`${API_BASE}/users/${userId}/subjects/${subjectId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return handleResponse<{ message: string }>(res);
}

export async function deleteSubject(subjectId: number, userId: number) {
  const res = await fetch(`${API_BASE}/users/${userId}/subjects/${subjectId}`, {
    method: "DELETE",
  });

  return handleResponse<{ message: string }>(res);
}

/* ---------------- SCHEDULE / TIMETABLE ---------------- */

function normalizeScheduleResponse(data: any) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.schedule)) return data.schedule;
  if (Array.isArray(data?.timetable)) return data.timetable;
  if (data && typeof data === "object") return data;
  return [];
}

export async function getSchedule(userId: number) {
  const res = await fetch(`${API_BASE}/users/${userId}/schedule`);
  const data = await handleResponse<any>(res);
  return normalizeScheduleResponse(data);
}

export async function saveSchedule(payload: any, userId: number) {
  const res = await fetch(`${API_BASE}/users/${userId}/schedule`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return handleResponse<{ message: string }>(res);
}

export async function updateScheduleItem(
  itemId: number,
  payload: any,
  userId: number
) {
  const res = await fetch(`${API_BASE}/users/${userId}/schedule/${itemId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return handleResponse<{ message: string }>(res);
}

export async function deleteScheduleItem(itemId: number, userId: number) {
  const res = await fetch(`${API_BASE}/users/${userId}/schedule/${itemId}`, {
    method: "DELETE",
  });

  return handleResponse<{ message: string }>(res);
}

/* ---------------- BACKWARD COMPATIBILITY ---------------- */

export async function getTimetable(userId: number) {
  return getSchedule(userId);
}

export async function saveTimetable(payload: any, userId: number) {
  return saveSchedule(payload, userId);
}

export async function updateTimetable(
  itemId: number,
  payload: any,
  userId: number
) {
  return updateScheduleItem(itemId, payload, userId);
}

export async function deleteTimetable(itemId: number, userId: number) {
  return deleteScheduleItem(itemId, userId);
}