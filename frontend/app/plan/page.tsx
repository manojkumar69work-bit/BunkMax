"use client";

import { useEffect, useMemo, useState } from "react";
import BottomNav from "@/components/BottomNav";
import { getSubjects, getTimetable, planBunks } from "@/lib/api";
import { useAppUser } from "@/lib/user";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Subject = {
  id: number;
  subject_name: string;
  attended_classes: number;
  total_classes: number;
  required_percentage: number;
  attendance_percentage: number;
  safe_bunks: number;
  need_to_recover: number;
  status: string;
};

type Timetable = Record<string, string[]>;

export default function PlanPage() {
  const { appUser, loadingUser } = useAppUser();

  const [view, setView] = useState<"bunk" | "recovery">("bunk");

  const [mode, setMode] = useState("tomorrow");
  const [nDays, setNDays] = useState(3);
  const [weeks, setWeeks] = useState(1);
  const [selectedDays, setSelectedDays] = useState<string[]>(["Monday"]);
  const [result, setResult] = useState<null | {
    scenario_label: string;
    current_avg: number;
    predicted_avg: number;
    drop: number;
  }>(null);

  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [timetable, setTimetable] = useState<Timetable>({});
  const [loadingRecovery, setLoadingRecovery] = useState(true);

  useEffect(() => {
    if (!appUser) return;
    loadRecoveryData(appUser.id);
  }, [appUser]);

  async function loadRecoveryData(userId: number) {
    try {
      setLoadingRecovery(true);
      const [subjectData, timetableData] = await Promise.all([
        getSubjects(userId),
        getTimetable(userId),
      ]);
      setSubjects(subjectData);
      setTimetable(timetableData);
    } finally {
      setLoadingRecovery(false);
    }
  }

  async function handleRun() {
    if (!appUser) return;

    if (mode === "tomorrow") {
      setResult(await planBunks({ mode: "tomorrow" }, appUser.id));
    } else if (mode === "next_n_days") {
      setResult(await planBunks({ mode: "next_n_days", n_days: nDays }, appUser.id));
    } else {
      setResult(
        await planBunks(
          { mode: "selected_weekdays", selected_days: selectedDays, weeks },
          appUser.id
        )
      );
    }
  }

  function toggleDay(day: string) {
    setSelectedDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  }

  const currentAverage = useMemo(() => {
    if (subjects.length === 0) return 0;
    const total = subjects.reduce((sum, s) => sum + s.attendance_percentage, 0);
    return total / subjects.length;
  }, [subjects]);

  const dayRecovery = useMemo(() => {
    if (subjects.length === 0) return [];

    const subjectMap = new Map(subjects.map((s) => [s.subject_name, s]));
    const results = DAYS.map((day) => {
      const periods = timetable[day] || [];
      const countedSubjects: string[] = [];
      let totalGain = 0;

      for (const subjectName of periods) {
        if (!subjectName) continue;

        const subject = subjectMap.get(subjectName);
        if (!subject) continue;

        const currentPct =
          subject.total_classes > 0
            ? (subject.attended_classes / subject.total_classes) * 100
            : 0;

        const newPct =
          ((subject.attended_classes + 1) / (subject.total_classes + 1)) * 100;

        const gain = newPct - currentPct;
        totalGain += gain;

        if (!countedSubjects.includes(subjectName)) {
          countedSubjects.push(subjectName);
        }
      }

      const averageGain = subjects.length > 0 ? totalGain / subjects.length : 0;

      const recoveryHelpSubjects = countedSubjects.filter((name) => {
        const subject = subjectMap.get(name);
        return subject && subject.need_to_recover > 0;
      });

      return {
        day,
        gain: averageGain,
        subjects: recoveryHelpSubjects,
        currentAverage,
      };
    });

    return results.sort((a, b) => b.gain - a.gain);
  }, [subjects, timetable, currentAverage]);

  const bestRecoveryDay = dayRecovery.length > 0 ? dayRecovery[0] : null;

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
          <h1 className="text-2xl font-bold tracking-tight">⚡ Plan My Bunks</h1>
          <p className="text-sm text-gray-400 mt-1">
            Predict bunk impact and plan attendance recovery
          </p>
        </div>
        <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-300">
          Plan
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setView("bunk")}
          className={`rounded-2xl border px-4 py-3 text-sm font-semibold transition ${
            view === "bunk"
              ? "border-white/20 bg-white/15 text-white"
              : "border-white/10 bg-white/5 text-gray-300"
          }`}
        >
          Bunk Impact
        </button>

        <button
          type="button"
          onClick={() => setView("recovery")}
          className={`rounded-2xl border px-4 py-3 text-sm font-semibold transition ${
            view === "recovery"
              ? "border-white/20 bg-white/15 text-white"
              : "border-white/10 bg-white/5 text-gray-300"
          }`}
        >
          Recovery
        </button>
      </div>

      {view === "bunk" ? (
        <>
          <div className="soft-card p-4 space-y-3">
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              className="input-ui"
            >
              <option value="tomorrow">Absent tomorrow</option>
              <option value="next_n_days">Absent for next N class days</option>
              <option value="selected_weekdays">Absent on selected weekdays</option>
            </select>

            {mode === "next_n_days" && (
              <input
                type="number"
                value={nDays}
                onChange={(e) => setNDays(Number(e.target.value))}
                className="input-ui"
                placeholder="Number of days"
              />
            )}

            {mode === "selected_weekdays" && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  {DAYS.map((day) => (
                    <button
                      key={day}
                      type="button"
                      onClick={() => toggleDay(day)}
                      className={`rounded-xl border px-3 py-2 text-sm font-medium ${
                        selectedDays.includes(day)
                          ? "border-white/20 bg-white/15 text-white"
                          : "border-white/10 bg-white/5 text-gray-300"
                      }`}
                    >
                      {day}
                    </button>
                  ))}
                </div>

                <input
                  type="number"
                  value={weeks}
                  onChange={(e) => setWeeks(Number(e.target.value))}
                  className="input-ui"
                  placeholder="Weeks"
                />
              </>
            )}

            <button onClick={handleRun} className="primary-btn">
              Run Prediction
            </button>
          </div>

          {result && (
            <div className="glass-card p-4 space-y-3">
              <p className="font-semibold">{result.scenario_label}</p>

              <div className="grid grid-cols-3 gap-2">
                <MiniMetric title="Current" value={`${result.current_avg.toFixed(1)}%`} />
                <MiniMetric title="Predicted" value={`${result.predicted_avg.toFixed(1)}%`} />
                <MiniMetric title="Drop" value={`${result.drop.toFixed(1)}%`} />
              </div>

              <div
                className={`rounded-xl border p-2 text-sm ${
                  result.predicted_avg >= 75
                    ? "border-green-500/30 bg-green-500/10 text-green-200"
                    : "border-yellow-500/30 bg-yellow-500/10 text-yellow-200"
                }`}
              >
                {result.predicted_avg >= 75
                  ? "Still safe after this bunk plan ✅"
                  : "This bunk plan may push your attendance down ⚠️"}
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {loadingRecovery ? (
            <div className="text-sm text-gray-400">Loading recovery details...</div>
          ) : subjects.length === 0 ? (
            <div className="glass-card p-4 text-sm text-gray-400">
              Add your subjects first to see recovery suggestions.
            </div>
          ) : (
            <>
              {bestRecoveryDay && (
                <div className="rounded-2xl border border-green-500/30 bg-green-500/10 p-4 text-green-200">
                  <p className="font-semibold">Best day to recover attendance</p>
                  <p className="mt-1 text-sm">
                    Attending <span className="font-semibold">{bestRecoveryDay.day}</span> can improve your
                    overall average by about{" "}
                    <span className="font-semibold">{bestRecoveryDay.gain.toFixed(2)}%</span>.
                  </p>
                </div>
              )}

              <div className="section-title">Recovery by Day</div>

              <div className="space-y-3">
                {dayRecovery.map((day) => (
                  <div key={day.day} className="glass-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold">{day.day}</p>
                      </div>

                      <div className="rounded-xl border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-200">
                        +{day.gain.toFixed(2)}%
                      </div>
                    </div>

                    <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-gray-300">
                      {day.subjects.length > 0 ? (
                        <>
                          Helps recover:{" "}
                          <span className="font-semibold">
                            {day.subjects.join(", ")}
                          </span>
                        </>
                      ) : (
                        <>This day mainly helps maintain already safe subjects.</>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      <BottomNav />
    </div>
  );
}

function MiniMetric({
  title,
  value,
}: {
  title: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-center">
      <p className="text-[11px] text-gray-400">{title}</p>
      <p className="text-sm font-bold mt-1">{value}</p>
    </div>
  );
}