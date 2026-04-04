"use client";

import { useEffect, useMemo, useState } from "react";
import BottomNav from "@/components/BottomNav";
import { getSubjects, getTimetable } from "@/lib/api";
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

type PredictionResult = {
  scenario_label: string;
  current_avg: number;
  predicted_avg: number;
  drop: number;
};

function normalizeSubjects(data: any[]): Subject[] {
  return data.map((s: any) => {
    const attended = Number(s.attended_classes ?? 0);
    const total = Number(s.total_classes ?? 0);
    const required = Number(s.required_percentage ?? 75);

    const attendance_percentage =
      total > 0 ? Number(((attended / total) * 100).toFixed(1)) : 0;

    let safe_bunks = 0;
    if (total > 0 && attendance_percentage >= required) {
      const req = required / 100;
      safe_bunks = Math.max(0, Math.floor(attended / req - total));
    }

    let need_to_recover = 0;
    if (attendance_percentage < required) {
      const req = required / 100;
      const x = ((req * total) - attended) / (1 - req);
      need_to_recover = Math.max(0, Math.ceil(x));
    }

    let status = "Danger";
    if (attendance_percentage >= required + 5) {
      status = "Safe";
    } else if (attendance_percentage >= required) {
      status = "Warning";
    }

    return {
      id: Number(s.id ?? 0),
      subject_name: String(s.subject_name ?? ""),
      attended_classes: attended,
      total_classes: total,
      required_percentage: required,
      attendance_percentage,
      safe_bunks,
      need_to_recover,
      status,
    };
  });
}

function normalizeTimetable(input: any): Timetable {
  const result: Timetable = Object.fromEntries(
    DAYS.map((day) => [day, []])
  ) as Timetable;

  if (!input) return result;

  if (!Array.isArray(input) && typeof input === "object") {
    for (const day of DAYS) {
      result[day] = Array.isArray(input[day]) ? input[day] : [];
    }
    return result;
  }

  if (Array.isArray(input)) {
    for (const row of input) {
      const day = row.day_name;
      const periodIndex = Number(row.period_no) - 1;
      const subject = row.subject_name || "";

      if (DAYS.includes(day)) {
        if (!result[day]) result[day] = [];
        result[day][periodIndex] = subject;
      }
    }
  }

  return result;
}

export default function PlanPage() {
  const { appUser, loadingUser } = useAppUser();

  const [view, setView] = useState<"bunk" | "recovery">("bunk");

  const [mode, setMode] = useState("tomorrow");
  const [nDays, setNDays] = useState(3);
  const [weeks, setWeeks] = useState(1);
  const [selectedDays, setSelectedDays] = useState<string[]>(["Monday"]);
  const [result, setResult] = useState<PredictionResult | null>(null);

  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [timetable, setTimetable] = useState<Timetable>({});
  const [loadingRecovery, setLoadingRecovery] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!appUser) return;
    loadRecoveryData(appUser.id);
  }, [appUser]);

  async function loadRecoveryData(userId: number) {
    try {
      setLoadingRecovery(true);
      setError("");

      const [subjectData, timetableData] = await Promise.all([
        getSubjects(userId),
        getTimetable(userId),
      ]);

      setSubjects(normalizeSubjects(subjectData));
      setTimetable(normalizeTimetable(timetableData));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load planning data");
    } finally {
      setLoadingRecovery(false);
    }
  }

  function toggleDay(day: string) {
    setSelectedDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  }

  function getScenarioDays(): string[] {
    if (mode === "tomorrow") {
      return [DAYS[0]];
    }

    if (mode === "next_n_days") {
      const expanded: string[] = [];
      for (let i = 0; i < nDays; i++) {
        expanded.push(DAYS[i % DAYS.length]);
      }
      return expanded;
    }

    const expanded: string[] = [];
    for (let w = 0; w < weeks; w++) {
      expanded.push(...selectedDays);
    }
    return expanded;
  }

  function handleRun() {
    const scenarioDays = getScenarioDays();
    const clonedSubjects = subjects.map((s) => ({ ...s }));
    const subjectMap = new Map(clonedSubjects.map((s) => [s.subject_name, s]));

    for (const day of scenarioDays) {
      const periods = timetable[day] || [];

      for (const subjectName of periods) {
        if (!subjectName) continue;

        const subject = subjectMap.get(subjectName);
        if (!subject) continue;

        subject.total_classes += 1;
        subject.attendance_percentage =
          subject.total_classes > 0
            ? Number(
                ((subject.attended_classes / subject.total_classes) * 100).toFixed(1)
              )
            : 0;
      }
    }

    const current_avg =
      subjects.length > 0
        ? subjects.reduce((sum, s) => sum + s.attendance_percentage, 0) / subjects.length
        : 0;

    const predicted_avg =
      clonedSubjects.length > 0
        ? clonedSubjects.reduce((sum, s) => sum + s.attendance_percentage, 0) /
          clonedSubjects.length
        : 0;

    setResult({
      scenario_label:
        mode === "tomorrow"
          ? "Absent tomorrow"
          : mode === "next_n_days"
          ? `Absent for next ${nDays} class days`
          : `Absent on ${selectedDays.join(", ")} for ${weeks} week(s)`,
      current_avg: Number(current_avg.toFixed(1)),
      predicted_avg: Number(predicted_avg.toFixed(1)),
      drop: Number((current_avg - predicted_avg).toFixed(1)),
    });
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

        totalGain += newPct - currentPct;

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

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

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
                onChange={(e) => setNDays(Number(e.target.value) || 1)}
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
                  onChange={(e) => setWeeks(Number(e.target.value) || 1)}
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