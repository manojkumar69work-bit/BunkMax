"use client";

import { useEffect, useState } from "react";
import BottomNav from "@/components/BottomNav";
import { getSubjects, getTimetable, saveTimetable } from "@/lib/api";
import { useAppUser } from "@/lib/user";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const PERIODS = 6;

export default function SchedulePage() {
  const { appUser, loadingUser } = useAppUser();

  const [subjects, setSubjects] = useState<string[]>([]);
  const [timetable, setTimetable] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [selectedDay, setSelectedDay] = useState("Monday");

  useEffect(() => {
    if (!appUser) return;
    load(appUser.id);
  }, [appUser]);

  async function load(userId: number) {
    try {
      setLoading(true);
      const [subjectData, timetableData] = await Promise.all([
        getSubjects(userId),
        getTimetable(userId),
      ]);
      setSubjects(subjectData.map((s) => s.subject_name));
      setTimetable(timetableData);
    } finally {
      setLoading(false);
    }
  }

  function updateCell(index: number, value: string) {
    setTimetable((prev) => {
      const current = prev[selectedDay] ? [...prev[selectedDay]] : Array(PERIODS).fill("");
      current[index] = value;
      return { ...prev, [selectedDay]: current };
    });
  }

  async function handleSaveDay() {
    if (!appUser) return;

    const arr = timetable[selectedDay] || Array(PERIODS).fill("");

    const entries = arr.map((subject, i) => ({
      day_name: selectedDay,
      period_no: i + 1,
      subject_name: subject || "",
    }));

    await saveTimetable(entries, appUser.id);
    setMessage(`${selectedDay} schedule saved successfully.`);
  }

  const currentDayPeriods = timetable[selectedDay] || Array(PERIODS).fill("");

  if (loadingUser) {
    return <div className="app-shell text-sm text-gray-400">Loading user...</div>;
  }

  if (!appUser) {
    return <div className="app-shell text-sm text-red-300">User not found.</div>;
  }

  return (
    <div className="app-shell">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">🗓 My Schedule</h1>
          <p className="text-sm text-gray-400 mt-1">
            Select a day and edit its periods
          </p>
        </div>
        <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-300">
          Schedule
        </div>
      </div>

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
                  <div className="text-xs text-gray-400 mt-1">Tap to edit</div>
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