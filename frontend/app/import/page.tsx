"use client";

import { useMemo, useState } from "react";
import { importAttendance } from "@/lib/api";
import { useAppUser } from "@/lib/user";
import BottomNav from "@/components/BottomNav";

type SubjectItem = {
  subjectid: string;
  subject_name: string;
  subject_type?: string;
  course_code?: string;
  semesterName?: string;
};

type AttendanceMap = Record<
  string,
  {
    totalsessions: number;
    presentSessionsCount: number;
    percentage?: string | number;
  }
>;

export default function ImportPage() {
  const { appUser, loadingUser } = useAppUser();

  const [subjectsText, setSubjectsText] = useState("");
  const [attendanceText, setAttendanceText] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const parsed = useMemo(() => {
    try {
      const subjectsJson = subjectsText ? JSON.parse(subjectsText) : null;
      const attendanceJson = attendanceText ? JSON.parse(attendanceText) : null;

      let subjects: SubjectItem[] = [];
      let attendance: AttendanceMap = {};

      if (subjectsJson?.data) {
        const data = subjectsJson.data;
        const streamKey = Object.keys(data)[0];
        const groupMap = data[streamKey] || {};
        const groupKey = Object.keys(groupMap)[0];
        subjects = groupMap[groupKey] || [];
      }

      if (attendanceJson?.data) {
        attendance = attendanceJson.data;
      }

      return { subjects, attendance, ok: true };
    } catch {
      return { subjects: [], attendance: {}, ok: false };
    }
  }, [subjectsText, attendanceText]);

  async function handleImport() {
    if (!appUser) return;

    setError("");
    setMessage("");
    setLoading(true);

    try {
      if (!parsed.ok) {
        throw new Error("Invalid JSON format");
      }

      if (parsed.subjects.length === 0) {
        throw new Error("Subjects JSON is empty or invalid");
      }

      const res = await importAttendance(
        {
          subjects: parsed.subjects,
          attendance: parsed.attendance,
        },
        appUser.id
      );

      setMessage(`${res.subjects_imported} subjects imported successfully.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setLoading(false);
    }
  }

  if (loadingUser) {
    return <div className="app-shell text-sm text-gray-400">Loading user...</div>;
  }

  if (!appUser) {
    return <div className="app-shell text-sm text-red-300">Please log in first.</div>;
  }

  return (
    <div className="app-shell">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Import from ERP</h1>
          <p className="text-sm text-gray-400 mt-1">
            Paste subject JSON and attendance JSON from ERP, then import.
          </p>
        </div>
        <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-300">
          Import
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {message && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-200">
          {message}
        </div>
      )}

      <div className="soft-card p-4 space-y-3">
        <p className="text-sm font-semibold">How to import</p>
        <div className="text-sm text-gray-300 space-y-1">
          <p>1. Open ERP and go to the attendance area.</p>
          <p>2. Copy the full subject JSON response.</p>
          <p>3. Copy the full attendance JSON response.</p>
          <p>4. Paste both below and click Import Attendance.</p>
        </div>
      </div>

      <div className="soft-card p-4 space-y-3">
        <p className="text-sm font-semibold">Subjects JSON</p>
        <textarea
          className="input-ui min-h-44"
          value={subjectsText}
          onChange={(e) => setSubjectsText(e.target.value)}
          placeholder='Paste the full subject JSON here'
        />
      </div>

      <div className="soft-card p-4 space-y-3">
        <p className="text-sm font-semibold">Attendance JSON</p>
        <textarea
          className="input-ui min-h-44"
          value={attendanceText}
          onChange={(e) => setAttendanceText(e.target.value)}
          placeholder='Paste the full attendance JSON here'
        />
      </div>

      {parsed.ok && parsed.subjects.length > 0 && (
        <div className="glass-card p-4 space-y-3">
          <p className="font-semibold">Preview</p>
          <div className="space-y-2">
            {parsed.subjects.slice(0, 10).map((s) => {
              const a = parsed.attendance[String(s.subjectid)];
              return (
                <div
                  key={s.subjectid}
                  className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 p-3 text-sm"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{s.subject_name}</div>
                    <div className="text-xs text-gray-400">
                      {(s.course_code || "No code").trim()} · {s.subject_type || "Unknown"}
                    </div>
                  </div>
                  <div className="text-right text-xs shrink-0">
                    <div>
                      {a?.presentSessionsCount ?? 0}/{a?.totalsessions ?? 0}
                    </div>
                    <div className="text-gray-400">{a?.percentage ?? 0}%</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <button onClick={handleImport} disabled={loading} className="primary-btn">
        {loading ? "Importing..." : "Import Attendance"}
      </button>

      <BottomNav />
    </div>
  );
}