import { API_BASE } from "@/lib/api";

type ErpSubject = {
  subjectid: string;
  subject_name: string;
};

type ErpAttendanceStats = {
  totalsessions: number;
  presentSessionsCount: number;
  percentage?: string | number;
};

type ErpSubjectResponse = {
  data?: Record<string, Record<string, ErpSubject[]>>;
};

type ErpAttendanceResponse = {
  data?: Record<string, ErpAttendanceStats>;
};

export async function autoSyncERP(userId: number) {
  try {
    // 1. Fetch subjects from ERP
    const subRes = await fetch(
      "https://portal.vmedulife.com/api/learner/subject_api.php",
      {
        method: "POST",
        credentials: "include",
      }
    );

    const subjectsText = await subRes.text();
    const subjectsJson = JSON.parse(subjectsText) as ErpSubjectResponse;

    // 2. Fetch attendance
    const attRes = await fetch(
      "https://portal.vmedulife.com/api/learner/academicPlanningDashboard.php",
      {
        method: "POST",
        credentials: "include",
      }
    );

    const attendanceText = await attRes.text();
    const attendanceJson = JSON.parse(attendanceText) as ErpAttendanceResponse;

    // 3. Extract subjects
    const subjectData = subjectsJson.data || {};
    const stream = Object.keys(subjectData)[0];
    const group = stream ? Object.keys(subjectData[stream] || {})[0] : "";
    const subjects = stream && group ? subjectData[stream]?.[group] || [] : [];

    const attendance = attendanceJson.data || {};

    // 4. Send to backend
    const res = await fetch(
      `${API_BASE}/users/${userId}/import-attendance`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          subjects,
          attendance,
        }),
      }
    );

    const data = (await res.json()) as { message?: string };

    return {
      success: true,
      message: data.message || "Sync completed",
    };
  } catch (err: unknown) {
    return {
      success: false,
      message: err instanceof Error ? err.message : "Sync failed",
    };
  }
}
