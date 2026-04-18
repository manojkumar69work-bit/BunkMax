"use client";

import { useEffect, useMemo, useState } from "react";
import BottomNav from "@/components/BottomNav";
import { getSubjects, getTimetable, planBunks } from "@/lib/api";
import { useAppUser } from "@/lib/user";
import FullScreenLoader from "@/components/FullScreenLoader";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Subject = {
  id?: number;
  subject_name: string;
  attended_classes: number;
  total_classes: number;
  required_percentage?: number;
};

type Timetable = Record<string, string[]>;

type BunkResult = {
  scenario_label: string;
  new_overall: number;
  drop_overall: number;
  new_avg: number;
  drop_avg: number;
};

type RecoveryResult = {
  label: string;
  new_overall: number;
  increase_overall: number;
  new_avg: number;
  increase_avg: number;
};

function normalizeTimetable(data: any): Timetable {
  if (!data) return {};
  if (!Array.isArray(data)) return data;

  const map: Timetable = {};

  for (const row of data) {
    const day = row.day_name;
    const index = Number(row.period_no) - 1;
    const subject = row.subject_name || "";

    if (!map[day]) {
      map[day] = Array(6).fill("");
    }

    if (index >= 0 && index < 6) {
      map[day][index] = subject;
    }
  }

  return map;
}

function calcOverall(subjects: Subject[]) {
  const present = subjects.reduce((sum, s) => sum + (s.attended_classes || 0), 0);
  const total = subjects.reduce((sum, s) => sum + (s.total_classes || 0), 0);
  return total > 0 ? (present / total) * 100 : 0;
}

function calcAverage(subjects: Subject[]) {
  const validSubjects = subjects.filter((s) => (s.total_classes || 0) > 0);

  if (validSubjects.length === 0) return 0;

  const sum = validSubjects.reduce((acc, s) => {
    return acc + (s.attended_classes / s.total_classes) * 100;
  }, 0);

  return sum / validSubjects.length;
}

export default function PlanPage() {
  const { appUser, loadingUser } = useAppUser();

  const [view, setView] = useState<"bunk" | "recovery">("bunk");

  const [mode, setMode] = useState("tomorrow");
  const [nDays, setNDays] = useState("");
  const [weeks, setWeeks] = useState("1");
  const [selectedDays, setSelectedDays] = useState<string[]>(["Monday"]);

  const [bunkResult, setBunkResult] = useState<BunkResult | null>(null);
  const [recoveryResult, setRecoveryResult] = useState<RecoveryResult | null>(null);

  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [timetable, setTimetable] = useState<Timetable>({});

  const [loadingPage, setLoadingPage] = useState(true);
  const [runningBunk, setRunningBunk] = useState(false);
  const [runningRecovery, setRunningRecovery] = useState(false);

  const [error, setError] = useState("");
  const [recoveryDays, setRecoveryDays] = useState("");

  useEffect(() => {
    if (!appUser?.id) return;
    loadPageData(appUser.id);
  }, [appUser]);

  async function loadPageData(userId: number) {
    try {
      setLoadingPage(true);
      setError("");

      const [subjectData, timetableData] = await Promise.all([
        getSubjects(userId),
        getTimetable(userId),
      ]);

      setSubjects(subjectData);
      setTimetable(normalizeTimetable(timetableData));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load planner data");
    } finally {
      setLoadingPage(false);
    }
  }

  function toggleDay(day: string) {
    setSelectedDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  }

  const currentOverall = useMemo(() => calcOverall(subjects), [subjects]);
  const currentAverage = useMemo(() => calcAverage(subjects), [subjects]);

  async function handleRun() {
    if (!appUser?.id) return;

    try {
      setRunningBunk(true);
      setError("");
      setBunkResult(null);

      let res: any;

      if (mode === "tomorrow") {
        res = await planBunks({ mode: "tomorrow" }, appUser.id);
      } else if (mode === "next_n_days") {
        const parsed = Number(nDays);
        if (!parsed || parsed <= 0) {
          setError("Enter number of days.");
          return;
        }

        res = await planBunks(
          { mode: "next_n_days", n_days: parsed },
          appUser.id
        );
      } else {
        const parsedWeeks = Number(weeks || 1);

        if (selectedDays.length === 0) {
          setError("Select at least one day.");
          return;
        }

        res = await planBunks(
          {
            mode: "selected_weekdays",
            selected_days: selectedDays,
            weeks: parsedWeeks > 0 ? parsedWeeks : 1,
          },
          appUser.id
        );
      }

      setBunkResult({
        scenario_label:
          mode === "tomorrow" && typeof res.scenario_label === "string"
            ? res.scenario_label.replace("Absent tomorrow", "Absent on next class day")
            : res.scenario_label,
        new_overall: Number(res.new_overall || 0),
        drop_overall: Number(res.drop_overall || 0),
        new_avg: Number(res.new_avg || 0),
        drop_avg: Number(res.drop_avg || 0),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to run prediction");
    } finally {
      setRunningBunk(false);
    }
  }

  async function runRecovery() {
    try {
      setRunningRecovery(true);
      setError("");
      setRecoveryResult(null);

      const parsedDays = Number(recoveryDays);
      if (!parsedDays || parsedDays <= 0) {
        setError("Enter number of recovery days.");
        return;
      }

      if (subjects.length === 0) {
        setError("Add subjects first.");
        return;
      }

      const dayOrder = DAYS.filter((day) =>
        (timetable[day] || []).some((s) => String(s || "").trim() !== "")
      );

      if (dayOrder.length === 0) {
        setError("Create your schedule first.");
        return;
      }

      const simulated: Subject[] = subjects.map((s) => ({ ...s }));

      for (let i = 0; i < parsedDays; i++) {
        const day = dayOrder[i % dayOrder.length];
        const periods = timetable[day] || [];

        for (const subjectName of periods) {
          const clean = String(subjectName || "").trim();
          if (!clean) continue;

          const subject = simulated.find(
            (s) => s.subject_name.trim().toLowerCase() === clean.toLowerCase()
          );

          if (subject) {
            subject.attended_classes += 1;
            subject.total_classes += 1;
          }
        }
      }

      const newOverall = calcOverall(simulated);
      const newAvg = calcAverage(simulated);

      setRecoveryResult({
        label: `Recovery for ${parsedDays} consecutive days`,
        new_overall: Number(newOverall.toFixed(2)),
        increase_overall: Number((newOverall - currentOverall).toFixed(2)),
        new_avg: Number(newAvg.toFixed(2)),
        increase_avg: Number((newAvg - currentAverage).toFixed(2)),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to calculate recovery");
    } finally {
      setRunningRecovery(false);
    }
  }

  if (loadingUser) {
    return <FullScreenLoader label="Loading BunkMax..." />;
  }

  if (!appUser) {
    return (
      <div className="min-h-screen bg-[#070a10] flex items-center justify-center px-4">
        <div className="w-full max-w-[380px] rounded-3xl border border-white/10 bg-white/5 p-8 text-center backdrop-blur-xl shadow-[0_20px_60px_rgba(0,0,0,0.45)] space-y-6">
          <h1 className="text-2xl font-bold">BunkMax</h1>
          <p className="text-sm text-gray-300">Please login to continue.</p>
          <a
            href="/login"
            className="inline-flex w-full items-center justify-center rounded-2xl border border-white/20 bg-white text-black px-4 py-3 font-semibold hover:bg-gray-200 active:scale-[0.98] transition"
          >
            Go to Login
          </a>
        </div>
      </div>
    );
  }

  if (loadingPage) {
    return <FullScreenLoader label="Loading planner..." />;
  }

  return (
    <div className="app-shell">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Plan My Bunks</h1>
        <p className="text-sm text-gray-400 mt-1">
          Predict bunk impact and plan attendance recovery
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => {
            setView("bunk");
            setError("");
          }}
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
          onClick={() => {
            setView("recovery");
            setError("");
          }}
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
              onChange={(e) => {
                setMode(e.target.value);
                setBunkResult(null);
                setError("");
              }}
              className="input-ui"
            >
              <option value="tomorrow">Absent on next class day</option>
              <option value="next_n_days">Absent for next N class days</option>
              <option value="selected_weekdays">Absent on selected weekdays</option>
            </select>

            {mode === "next_n_days" && (
              <input
                type="number"
                value={nDays}
                onChange={(e) => setNDays(e.target.value)}
                className="input-ui"
                placeholder="Enter number"
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
                  onChange={(e) => setWeeks(e.target.value)}
                  className="input-ui"
                  placeholder="Enter number"
                />
              </>
            )}

            <button
              onClick={handleRun}
              disabled={runningBunk}
              className="primary-btn disabled:opacity-60"
            >
              {runningBunk ? "Running Prediction..." : "Run Prediction"}
            </button>
          </div>

          {bunkResult && (
            <div className="glass-card p-4 space-y-3">
              <p className="font-semibold">{bunkResult.scenario_label}</p>

              <div className="grid grid-cols-2 gap-2">
                <MiniStatCard
                  title="New Overall"
                  value={`${bunkResult.new_overall.toFixed(2)}%`}
                  sub={`Drop ${bunkResult.drop_overall.toFixed(2)}%`}
                />
                <MiniStatCard
                  title="Drop in Overall"
                  value={`${bunkResult.drop_overall.toFixed(2)}%`}
                />
                <MiniStatCard
                  title="New Avg"
                  value={`${bunkResult.new_avg.toFixed(2)}%`}
                  sub={`Drop ${bunkResult.drop_avg.toFixed(2)}%`}
                />
                <MiniStatCard
                  title="Drop in Avg"
                  value={`${bunkResult.drop_avg.toFixed(2)}%`}
                />
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {subjects.length === 0 ? (
            <div className="glass-card p-4 text-sm text-gray-400">
              Add your subjects first to see recovery suggestions.
            </div>
          ) : (
            <>
              <div className="soft-card p-4 space-y-3">
                <input
                  type="number"
                  value={recoveryDays}
                  onChange={(e) => setRecoveryDays(e.target.value)}
                  className="input-ui"
                  placeholder="Enter number of days"
                />

                <button
                  onClick={runRecovery}
                  disabled={runningRecovery}
                  className="primary-btn disabled:opacity-60"
                >
                  {runningRecovery ? "Calculating..." : "Calculate Recovery"}
                </button>
              </div>

              {recoveryResult && (
                <div className="glass-card p-4 space-y-3">
                  <p className="font-semibold">{recoveryResult.label}</p>

                  <div className="grid grid-cols-2 gap-2">
                    <MiniStatCard
                      title="New Overall"
                      value={`${recoveryResult.new_overall.toFixed(2)}%`}
                      sub={`+${recoveryResult.increase_overall.toFixed(2)}%`}
                    />
                    <MiniStatCard
                      title="Increase in Overall"
                      value={`+${recoveryResult.increase_overall.toFixed(2)}%`}
                    />
                    <MiniStatCard
                      title="New Avg"
                      value={`${recoveryResult.new_avg.toFixed(2)}%`}
                      sub={`+${recoveryResult.increase_avg.toFixed(2)}%`}
                    />
                    <MiniStatCard
                      title="Increase in Avg"
                      value={`+${recoveryResult.increase_avg.toFixed(2)}%`}
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      <BottomNav />
    </div>
  );
}

function MiniStatCard({
  title,
  value,
  sub,
}: {
  title: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      <p className="text-[11px] text-gray-400">{title}</p>
      <p className="text-lg font-bold mt-1">{value}</p>
      {sub ? <p className="text-[11px] text-gray-400 mt-1">{sub}</p> : null}
    </div>
  );
}