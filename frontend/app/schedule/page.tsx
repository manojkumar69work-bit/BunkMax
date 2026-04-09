"use client";

import { useEffect, useMemo, useState } from "react";
import BottomNav from "@/components/BottomNav";
import { getSubjects, getTimetable, saveTimetable } from "@/lib/api";
import { useAppUser } from "@/lib/user";
import FullScreenLoader from "@/components/FullScreenLoader";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const PERIODS = 6;

type SubjectItem = {
  subject_name: string;
};

type TimetableMap = Record<string, string[]>;

function normalizeTimetable(data: any): TimetableMap {
  if (!data) return {};

  if (!Array.isArray(data)) {
    return data;
  }

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

  const [subjects, setSubjects] = useState<string[]>([]);
  const [timetable, setTimetable] = useState<TimetableMap>({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [selectedDay, setSelectedDay] = useState("Monday");

  useEffect(() => {
    if (!appUser) return;
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

      setSubjects(subjectData.map((s: SubjectItem) => s.subject_name));
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
    if (!appUser) return;

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

  const daySubjectCounts = useMemo(() => {
    const counts: Record<string, number> = {};

    for (const day of DAYS) {
      const arr = timetable[day] || [];
      counts[day] = arr.filter((item) => String(item || "").trim() !== "").length;
    }

    return counts;
  }, [timetable]);

  if (loadingUser) {
    return <FullScreenLoader label="Loading BunkMax..." />;
  }

  if (!appUser) {
    return <div className="app-shell text-sm text-red-300">User not found.</div>;
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

      {loading ? (
        <div className="text-sm text-gray-400">Loading schedule...</div>
      ) : subjects.length === 0 ? (
        <div className="glass-card p-4 text-sm text-gray-400">
          Add subjects first before creating your schedule.
        </div>
      ) : (
        <>
          <div className="section-title">Choose Day</div>

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
                  className={`rounded-2xl border px-4 py-4 text-left transition ${
                    active
                      ? "border-white/20 bg-white/15 text-white"
                      : "border-white/10 bg-white/5 text-gray-300 hover:bg-white/10"
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
              <div key={i} className="space-y-1">
                <label className="text-xs text-gray-400">Period {i + 1}</label>
                <select
                  value={currentDayPeriods[i] || ""}
                  onChange={(e) => updateCell(i, e.target.value)}
                  className="input-ui"
                >
                  <option value="">Select subject</option>
                  {subjects.map((subject) => (
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