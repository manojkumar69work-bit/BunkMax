"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import BottomNav from "@/components/BottomNav";
import {
  getSubjects,
  getTimetable,
  saveTimetable,
  type ScheduleEntry,
  type SubjectResponse,
} from "@/lib/api";
import { useAppUser } from "@/lib/user";
import FullScreenLoader from "@/components/FullScreenLoader";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const PERIODS = 6;

type TimetableMap = Record<string, string[]>;

function normalizeTimetable(data: ScheduleEntry[]): TimetableMap {
  const map: TimetableMap = {};

  for (const row of data) {
    const day = row.day_name;
    const periodIndex = Number(row.period_no) - 1;
    const subject = row.subject_name || "";

    if (!map[day]) {
      map[day] = Array(PERIODS).fill("");
    }

    if (periodIndex >= 0 && periodIndex < PERIODS) {
      map[day][periodIndex] = subject;
    }
  }

  return map;
}

export default function SchedulePage() {
  const { appUser, loadingUser } = useAppUser();

  const [subjects, setSubjects] = useState<SubjectResponse[]>([]);
  const [timetable, setTimetable] = useState<TimetableMap>({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [selectedDay, setSelectedDay] = useState("Monday");

  useEffect(() => {
    if (!appUser?.id) return;
    load(appUser.id);
  }, [appUser]);

  async function load(userId: number) {
    try {
      setLoading(true);
      setError("");
      setMessage("");

      const [subjectData, timetableData] = await Promise.all([
        getSubjects(userId),
        getTimetable(userId),
      ]);

      setSubjects(subjectData);
      setTimetable(normalizeTimetable(timetableData));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load schedule");
    } finally {
      setLoading(false);
    }
  }

  function updateCell(index: number, value: string) {
    setTimetable((prev) => {
      const current = prev[selectedDay]
        ? [...prev[selectedDay]]
        : Array(PERIODS).fill("");

      current[index] = value;
      return { ...prev, [selectedDay]: current };
    });
  }

  async function handleSaveDay() {
    if (!appUser?.id) return;

    try {
      setError("");
      setMessage("");

      const arr = timetable[selectedDay] || Array(PERIODS).fill("");

      const entries = arr.map((subject, i) => ({
        day_name: selectedDay,
        period_no: i + 1,
        subject_name: subject || "",
      }));

      await saveTimetable(entries, appUser.id);
      setMessage(`${selectedDay} schedule saved successfully.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save schedule");
    }
  }

  const currentDayPeriods = timetable[selectedDay] || Array(PERIODS).fill("");
  const subjectNames = subjects.map((subject) => subject.subject_name);

  const daySubjectCounts = useMemo(() => {
    const counts: Record<string, number> = {};

    for (const day of DAYS) {
      const arr = timetable[day] || [];
      counts[day] = arr.filter((item) => String(item || "").trim() !== "").length;
    }

    return counts;
  }, [timetable]);

  const selectedDayFilledPeriods = currentDayPeriods.filter((item) =>
    String(item || "").trim()
  ).length;

  const totalScheduledPeriods = DAYS.reduce(
    (sum, day) => sum + (daySubjectCounts[day] || 0),
    0
  );

  const lowestSubjects = [...subjects]
    .sort((a, b) => {
      const aPct =
        a.total_classes > 0 ? a.attended_classes / a.total_classes : 0;
      const bPct =
        b.total_classes > 0 ? b.attended_classes / b.total_classes : 0;
      return aPct - bPct;
    })
    .slice(0, 4);

  if (loadingUser) {
    return <FullScreenLoader label="Loading BunkMax..." />;
  }

  if (!appUser) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <h1 className="text-2xl font-bold">BunkMax</h1>
          <p className="text-sm text-gray-300">
            Please login to continue.
          </p>
          <a
            href="/login"
            className="primary-btn inline-flex items-center justify-center px-4"
          >
            Go to Login
          </a>
        </div>
      </div>
    );
  }

  if (loading) {
    return <FullScreenLoader label="Loading schedule..." />;
  }

  return (
    <div className="app-shell">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">My Schedule</h1>
        <p className="text-sm text-gray-400 mt-1">
          Select a day and edit its periods
        </p>
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

      {subjects.length === 0 ? (
        <div className="glass-card p-4 text-sm text-gray-400">
          Add subjects first before creating your schedule.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className="glass-card p-3">
              <p className="metric-title">Subjects</p>
              <p className="metric-value">{subjects.length}</p>
            </div>
            <div className="glass-card p-3">
              <p className="metric-title">Periods</p>
              <p className="metric-value">{totalScheduledPeriods}</p>
            </div>
            <div className="glass-card p-3">
              <p className="metric-title">{selectedDay.slice(0, 3)}</p>
              <p className="metric-value">{selectedDayFilledPeriods}</p>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="section-title">Subjects</div>
            <Link
              href="/subjects"
              className="rounded-full border border-[#2f3336] px-3 py-1.5 text-xs font-bold text-[#1d9bf0]"
            >
              Manage
            </Link>
          </div>

          <div className="glass-card p-3">
            <div className="flex gap-2 overflow-x-auto pb-1">
              {lowestSubjects.map((subject) => {
                const percentage =
                  subject.total_classes > 0
                    ? (subject.attended_classes / subject.total_classes) * 100
                    : 0;

                return (
                  <div
                    key={subject.id}
                    className="min-w-[190px] rounded-xl border border-[#2f3336] bg-black p-3"
                  >
                    <p className="truncate text-sm font-bold">
                      {subject.subject_name}
                    </p>
                    <p className="mt-2 text-xl font-black">
                      {percentage.toFixed(1)}%
                    </p>
                    <p className="mt-1 text-xs text-[#71767b]">
                      {subject.attended_classes}/{subject.total_classes}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="section-title">Timetable</div>

          <div className="grid grid-cols-2 gap-3">
            {DAYS.map((day) => {
              const active = selectedDay === day;
              const count = daySubjectCounts[day] || 0;

              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => {
                    setSelectedDay(day);
                    setMessage("");
                  }}
                  className={`rounded-lg border px-4 py-4 text-left transition ${
                    active
                      ? "border-[#1d9bf0]/45 bg-[#1d9bf0]/12 text-white"
                      : "border-[#2f3336] bg-[#16181c] text-gray-300 hover:bg-[#202327]"
                  }`}
                >
                  <div className="font-semibold">{day}</div>
                  <div className="text-xs text-gray-400 mt-1">
                    {count} {count === 1 ? "subject" : "subjects"}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="section-title">Edit {selectedDay}</div>

          <div className="soft-card p-4 space-y-3">
            {Array.from({ length: PERIODS }).map((_, i) => (
              <div key={i} className="grid grid-cols-[68px_1fr] items-center gap-3">
                <label className="text-xs font-bold uppercase text-[#71767b]">
                  P{i + 1}
                </label>
                <select
                  value={currentDayPeriods[i] || ""}
                  onChange={(e) => updateCell(i, e.target.value)}
                  className="input-ui"
                >
                  <option value="">Select subject</option>
                  {subjectNames.map((subject) => (
                    <option key={subject} value={subject}>
                      {subject}
                    </option>
                  ))}
                </select>
              </div>
            ))}

            <button onClick={handleSaveDay} className="primary-btn">
              Save {selectedDay}
            </button>
          </div>
        </>
      )}

      <BottomNav />
    </div>
  );
}
