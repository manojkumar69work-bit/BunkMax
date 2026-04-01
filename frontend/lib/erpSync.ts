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
    const subjectsJson = JSON.parse(subjectsText);

    // 2. Fetch attendance
    const attRes = await fetch(
      "https://portal.vmedulife.com/api/learner/academicPlanningDashboard.php",
      {
        method: "POST",
        credentials: "include",
      }
    );

    const attendanceText = await attRes.text();
    const attendanceJson = JSON.parse(attendanceText);

    // 3. Extract subjects
    const stream = Object.keys(subjectsJson.data)[0];
    const group = Object.keys(subjectsJson.data[stream])[0];
    const subjects = subjectsJson.data[stream][group] || [];

    const attendance = attendanceJson.data || {};

    // 4. Send to backend
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_API_BASE}/users/${userId}/import-attendance`,
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

    const data = await res.json();

    return {
      success: true,
      message: data.message,
    };
  } catch (err: any) {
    return {
      success: false,
      message: err.message || "Sync failed",
    };
  }
}