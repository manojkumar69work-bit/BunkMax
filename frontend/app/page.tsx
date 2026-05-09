"use client";

import { useEffect, useMemo, useState } from "react";
import BottomNav from "@/components/BottomNav";
import Link from "next/link";
import {
  getHomeData,
  getSchedule,
  getTomorrow,
  getBestDay,
  getWorstDay,
} from "@/lib/api";
import FullScreenLoader from "@/components/FullScreenLoader";
import { Info } from "lucide-react";
import { useAppUser } from "@/lib/user";

type DashboardData = {
  current_avg: number;
  overall_percentage: number;
  total_present: number;
  total_absent: number;
  today_classes: {
    period_no: number;
    subject_name: string;
    marked_status?: "present" | "absent" | null;
  }[];
};

type HomeSubject = {
  subject_name: string;
  attended_classes: number;
  total_classes: number;
};

type QuickResult = {
  title: string;
  new_overall: number;
  new_avg: number;
  drop_overall: number;
  drop_avg: number;
};

const DAY_ORDER = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export default function Home() {
  const { appUser, loadingUser } = useAppUser();

  const [data, setData] = useState<DashboardData | null>(null);
  const [subjects, setSubjects] = useState<HomeSubject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [tomorrow, setTomorrow] = useState<QuickResult | null>(null);
  const [best, setBest] = useState<QuickResult | null>(null);
  const [worst, setWorst] = useState<QuickResult | null>(null);

  const [timetable, setTimetable] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<"" | "tomorrow" | "best" | "worst">("");

  const daysStatus = useMemo(() => {
    if (!data) return "Loading...";

    if (Object.keys(timetable).length === 0) {
      return "No schedule";
    }

    return getDaysStatus(
      data.total_present,
      data.total_present + data.total_absent,
      timetable
    );
  }, [data, timetable]);

  useEffect(() => {
    if (!appUser?.id) return;

    const userId = appUser.id;

    async function loadSchedule() {
      try {
        const scheduleData = await getSchedule(userId);
        const grouped: Record<string, string[]> = {};

        scheduleData.forEach((item: any) => {
          if (!item?.day_name) return;

          if (!grouped[item.day_name]) {
            grouped[item.day_name] = [];
          }

          if (item.subject_name && String(item.subject_name).trim()) {
            grouped[item.day_name].push(item.subject_name);
          }
        });

        setTimetable(grouped);
      } catch (err) {
        console.error("Schedule load failed:", err);
      }
    }

    loadSchedule();
  }, [appUser?.id]);

  useEffect(() => {
    if (!appUser?.id) return;

    const userId = appUser.id;
    loadDashboard(userId);
  }, [appUser?.id]);

  async function loadDashboard(userId: number) {
    try {
      setLoading(true);
      setError("");

      const homeData = await getHomeData(userId);

      setData(homeData.dashboard);
      setSubjects(homeData.subjects || []);
    } catch (e) {
      const errorMsg =
        e instanceof Error ? e.message : "Failed to load home data";
      setError(errorMsg);
      console.error("Dashboard load error:", errorMsg);
    } finally {
      setLoading(false);
    }
  }

  async function runTomorrow() {
    if (!appUser?.id || busy) return;

    const userId = appUser.id;

    try {
      setBusy("tomorrow");
      setError("");

      const result = await getTomorrow(userId);
      const nextClassDay = getNextClassDay(timetable);

      setTomorrow(
        nextClassDay
          ? {
              ...result,
              title: `Next Class Day (${nextClassDay})`,
            }
          : result
      );
    } catch (e) {
      const errorMsg =
        e instanceof Error ? e.message : "Failed to load prediction";
      setError(errorMsg);
      console.error("Tomorrow prediction error:", errorMsg);
    } finally {
      setBusy("");
    }
  }

  async function runBest() {
    if (!appUser?.id || busy) return;

    const userId = appUser.id;

    try {
      setBusy("best");
      setError("");
      setBest(await getBestDay(userId));
    } catch (e) {
      const errorMsg =
        e instanceof Error ? e.message : "Failed to find best day";
      setError(errorMsg);
      console.error("Best day error:", errorMsg);
    } finally {
      setBusy("");
    }
  }

  async function runWorst() {
    if (!appUser?.id || busy) return;

    const userId = appUser.id;

    try {
      setBusy("worst");
      setError("");
      setWorst(await getWorstDay(userId));
    } catch (e) {
      const errorMsg =
        e instanceof Error ? e.message : "Failed to find worst day";
      setError(errorMsg);
      console.error("Worst day error:", errorMsg);
    } finally {
      setBusy("");
    }
  }

  function getSubjectCounts(subjectName: string) {
    const subject = subjects.find((s) => s.subject_name === subjectName);
    if (!subject) return null;
    return `${subject.attended_classes}/${subject.total_classes}`;
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

  if (loading) {
    return <FullScreenLoader label="Loading dashboard..." />;
  }

  return (
    <div className="app-shell">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">BunkMax</h1>
          <p className="text-sm text-gray-400 mt-1">
            Stay above 75%, stress-free.
          </p>
        </div>

        <Link
          href="/about"
          className="h-10 w-10 flex items-center justify-center rounded-full border border-white/10 bg-white/5 text-gray-300 hover:text-white hover:bg-white/10 transition backdrop-blur-md"
        >
          <Info size={18} />
        </Link>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {data && (
        <>
          <StatsOverview
            overall={data.overall_percentage}
            avg={data.current_avg}
            present={data.total_present}
            absent={data.total_absent}
            daysStatus={daysStatus}
          />

          <div className="glass-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-semibold">Import from ERP</p>
                <p className="text-xs text-gray-400 mt-1">
                  Import subjects and attendance into BunkMax
                </p>
              </div>

              <Link
                href="/import"
                className="inline-flex min-w-[96px] items-center justify-center rounded-xl border border-white/10 bg-white/10 px-4 py-2 text-sm font-semibold text-white backdrop-blur-md"
              >
                Open
              </Link>
            </div>
          </div>

          <div className="section-title">Quick Actions</div>

          <QuickCard
            title="Should I skip tomorrow?"
            desc="Impact of missing the next class day."
            buttonText={busy === "tomorrow" ? "Checking..." : "Check Tomorrow"}
            onClick={runTomorrow}
            result={tomorrow}
            disabled={busy !== ""}
          />

          <QuickCard
            title="Best day to skip"
            desc="Find the day with least attendance impact."
            buttonText={busy === "best" ? "Finding..." : "Find Best Day"}
            onClick={runBest}
            result={best}
            disabled={busy !== ""}
          />

          <QuickCard
            title="Avoid skipping on"
            desc="Know the day with highest attendance impact."
            buttonText={busy === "worst" ? "Finding..." : "Find Worst Day"}
            onClick={runWorst}
            result={worst}
            disabled={busy !== ""}
          />

          <div className="section-title">Today&apos;s Classes</div>

          {data.today_classes.length === 0 ? (
            <div className="glass-card p-4 text-sm text-gray-400">
              No classes scheduled for today.
            </div>
          ) : (
            <div className="space-y-3">
              {data.today_classes.map((item) => {
                const counts = item.subject_name
                  ? getSubjectCounts(item.subject_name)
                  : null;

                return (
                  <div key={item.period_no} className="glass-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs text-gray-400">
                          Period {item.period_no}
                        </p>
                        <p className="text-lg font-semibold mt-1 truncate">
                          {item.subject_name || "---"}
                        </p>
                      </div>

                      {counts && (
                        <div className="shrink-0 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-gray-200">
                          {counts}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      <BottomNav />
    </div>
  );
}

function StatsOverview({
  overall,
  avg,
  present,
  absent,
  daysStatus,
}: {
  overall: number;
  avg: number;
  present: number;
  absent: number;
  daysStatus: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 items-stretch">
      <div className="glass-card p-4 row-span-2 min-h-[220px] flex flex-col items-center justify-center">
        <DonutChart percentage={overall} />
        <p className="mt-4 text-base font-semibold text-white">
          {daysStatus}
        </p>
      </div>

      <div className="glass-card p-4 min-h-[104px] flex flex-col justify-center">
        <p className="metric-title">Average</p>
        <p className="metric-value">{formatPercent(avg)}</p>
      </div>

      <div className="glass-card p-4 min-h-[104px] flex items-center">
        <div className="grid grid-cols-2 gap-6 w-full">
          <div>
            <p className="metric-title">Present</p>
            <p className="metric-value">{present}</p>
          </div>
          <div>
            <p className="metric-title">Absent</p>
            <p className="metric-value">{absent}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function DonutChart({ percentage }: { percentage: number }) {
  const value = Math.max(0, Math.min(100, percentage || 0));

  return (
    <div className="relative h-36 w-36 flex items-center justify-center">
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: `conic-gradient(
            #3b82f6 0% ${value}%,
            rgba(255,255,255,0.14) ${value}% 100%
          )`,
        }}
      />
      <div className="absolute inset-[14px] rounded-full bg-[#0f172a]" />
      <div className="absolute inset-[18px] rounded-full border border-white/10 flex flex-col items-center justify-center text-center">
        <p className="text-[11px] text-gray-400">Overall</p>
        <p className="text-2xl font-bold mt-1">{formatPercent(value)}</p>
      </div>
    </div>
  );
}

function QuickCard({
  title,
  desc,
  buttonText,
  onClick,
  result,
  disabled,
}: {
  title: string;
  desc: string;
  buttonText: string;
  onClick: () => void;
  result: QuickResult | null;
  disabled?: boolean;
}) {
  return (
    <div className="soft-card p-4 space-y-3">
      <div>
        <p className="font-semibold">{title}</p>
        <p className="text-xs text-gray-400 mt-1">{desc}</p>
      </div>

      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="secondary-btn disabled:opacity-60"
      >
        {buttonText}
      </button>

      {result && (
        <div className="glass-card p-4 space-y-3">
          <p className="font-semibold">{result.title}</p>

          <div className="grid grid-cols-2 gap-3">
            <ActionMetricCard
              title="New Overall"
              value={formatPercent(result.new_overall)}
              dropLabel={`Drop: ${formatPercent(result.drop_overall)}`}
            />
            <ActionMetricCard
              title="New Avg"
              value={formatPercent(result.new_avg)}
              dropLabel={`Drop: ${formatPercent(result.drop_avg)}`}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ActionMetricCard({
  title,
  value,
  dropLabel,
}: {
  title: string;
  value: string;
  dropLabel: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <p className="text-xs text-gray-400">{title}</p>
      <p className="text-2xl font-bold mt-2">{value}</p>
      <p className="text-xs text-gray-400 mt-2">{dropLabel}</p>
    </div>
  );
}

function formatPercent(value: number | undefined) {
  if (value === undefined || value === null || isNaN(value)) {
    return "0.00%";
  }

  return `${Number(value.toFixed(2))}%`;
}

function getDaysStatus(
  attended: number,
  total: number,
  timetable: Record<string, string[]>
) {
  const required = 0.75;

  if (total === 0) return "No data";

  const currentPct = attended / total;

  const getClassesForDay = (day: string) =>
    (timetable[day] || []).filter((s) => String(s || "").trim() !== "").length;

  const activeDays = DAY_ORDER.filter((day) => getClassesForDay(day) > 0);

  if (activeDays.length === 0) return "No schedule";

  if (currentPct >= required) {
    let simulatedTotal = total;
    let daysLeft = 0;
    let pointer = 0;

    while (pointer < 365) {
      const dayName = activeDays[pointer % activeDays.length];
      const classesThatDay = getClassesForDay(dayName);

      const nextTotal = simulatedTotal + classesThatDay;
      const nextPct = attended / nextTotal;

      if (nextPct < required) break;

      simulatedTotal = nextTotal;
      daysLeft += 1;
      pointer += 1;
    }

    return `${daysLeft} days left`;
  }

  let simulatedAttended = attended;
  let simulatedTotal = total;
  let recoveryDays = 0;
  let pointer = 0;

  while (pointer < 365) {
    const dayName = activeDays[pointer % activeDays.length];
    const classesThatDay = getClassesForDay(dayName);

    simulatedAttended += classesThatDay;
    simulatedTotal += classesThatDay;
    recoveryDays += 1;

    const newPct = simulatedAttended / simulatedTotal;

    if (newPct >= required) break;

    pointer += 1;
  }

  return `${recoveryDays} days to recover`;
}

function getNextClassDay(timetable: Record<string, string[]>): string | null {
  const now = new Date();

  for (let i = 1; i <= 7; i++) {
    const checkDay = new Date(now);
    checkDay.setDate(now.getDate() + i);

    const dayName = checkDay.toLocaleDateString("en-US", {
      weekday: "long",
    });

    if (
      timetable[dayName] &&
      timetable[dayName].some((s) => s && String(s).trim())
    ) {
      return dayName;
    }
  }

  return null;
}