"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import BottomNav from "@/components/BottomNav";
import SubjectsManager from "@/components/SubjectsManager";
import {
  getSubjects,
  getTimetable,
  saveTimetable,
  type ScheduleEntry,
  type SubjectResponse,
} from "@/lib/api";
import { useAppUser } from "@/lib/user";
import FullScreenLoader from "@/components/FullScreenLoader";
import { SchedulePageSkeleton } from "@/components/PageSkeleton";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const PERIODS = 6;

type TimetableMap = Record<string, string[]>;
type Tab = "timetable" | "subjects";

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
  return (
    <Suspense
      fallback={
        <div className="app-shell">
          <SchedulePageSkeleton />
          <BottomNav />
        </div>
      }
    >
      <ScheduleView />
    </Suspense>
  );
}

function ScheduleView() {
  const { appUser, loadingUser } = useAppUser();
  const router = useRouter();
  const searchParams = useSearchParams();

  // ?tab=subjects keeps the old /subjects bookmarks landing on the right view.
  const tab: Tab = searchParams.get("tab") === "subjects" ? "subjects" : "timetable";

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

  function switchTab(next: Tab) {
    setMessage("");
    setError("");
    router.replace(next === "subjects" ? "/schedule?tab=subjects" : "/schedule", {
      scroll: false,
    });
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

  if (loadingUser) {
    return <FullScreenLoader label="Loading BunkMax..." />;
  }

  if (!appUser) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <h1 className="text-2xl font-bold">BunkMax</h1>
          <p className="text-sm text-gray-300">Please login to continue.</p>
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

  return (
    <div className="app-shell">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">My Schedule</h1>
        <p className="text-sm text-gray-400 mt-1">
          {tab === "timetable"
            ? "Select a day and edit its periods"
            : "Manage attendance for each subject"}
        </p>
      </div>

      <div
        role="tablist"
        aria-label="Schedule sections"
        className="grid grid-cols-2 gap-1 rounded-2xl border border-[#2f3336] bg-[#16181c] p-1"
      >
        {(
          [
            ["timetable", "Timetable"],
            ["subjects", "Subjects"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => switchTab(value)}
            className={`rounded-xl px-4 py-2.5 text-sm font-bold transition ${
              tab === value
                ? "bg-[#1d9bf0] text-white shadow-[0_8px_20px_rgba(29,155,240,0.28)]"
                : "text-[#71767b] hover:bg-white/5 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "subjects" ? (
        <SubjectsManager
          userId={appUser.id}
          // Keep the timetable dropdown in step with edits made here.
          onSubjectsChange={(next) => setSubjects(next as SubjectResponse[])}
        />
      ) : (
        <>
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
            <SchedulePageSkeleton />
          ) : subjects.length === 0 ? (
            <div className="glass-card p-4 space-y-3">
              <p className="text-sm text-gray-400">
                Add subjects first before creating your schedule.
              </p>
              <button
                type="button"
                onClick={() => switchTab("subjects")}
                className="secondary-btn"
              >
                Go to Subjects
              </button>
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

              <div className="section-title">Timetable</div>

              {/* The day picker sits on the same label column as the periods
                  below it, so choosing a day and filling it read as one job. */}
              <div className="soft-card p-4 space-y-3">
                <div className="grid grid-cols-[68px_1fr] items-center gap-3">
                  <label
                    htmlFor="day-select"
                    className="text-xs font-bold uppercase text-[#71767b]"
                  >
                    Day
                  </label>
                  <select
                    id="day-select"
                    value={selectedDay}
                    onChange={(e) => {
                      setSelectedDay(e.target.value);
                      setMessage("");
                    }}
                    className="input-ui font-semibold"
                  >
                    {DAYS.map((day) => {
                      const count = daySubjectCounts[day] || 0;

                      return (
                        <option key={day} value={day}>
                          {day} · {count} {count === 1 ? "subject" : "subjects"}
                        </option>
                      );
                    })}
                  </select>
                </div>

                <div className="border-t border-[#2f3336]" />

                {Array.from({ length: PERIODS }).map((_, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[68px_1fr] items-center gap-3"
                  >
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
        </>
      )}

      <BottomNav />
    </div>
  );
}
