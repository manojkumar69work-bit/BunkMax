"use client";

import { useEffect, useMemo, useState } from "react";
import BottomNav from "@/components/BottomNav";
import Link from "next/link";
import {
  getHomeData,
  getSchedule,
  getCachedHomeData,
  getCachedSchedule,
  type ScheduleEntry,
  type HomeDataResponse,
} from "@/lib/api";
import FullScreenLoader from "@/components/FullScreenLoader";
import Skeleton from "@/components/Skeleton";
import { Info, Upload } from "lucide-react";
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

function groupSchedule(entries: ScheduleEntry[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};

  entries.forEach((item) => {
    if (!item?.day_name) return;

    if (!grouped[item.day_name]) {
      grouped[item.day_name] = [];
    }

    if (item.subject_name && String(item.subject_name).trim()) {
      grouped[item.day_name].push(item.subject_name);
    }
  });

  return grouped;
}

export default function Home() {
  const { appUser, loadingUser } = useAppUser();

  // Seed synchronously from the shared read cache so returning to the tab paints
  // instantly instead of flashing a loader while the network revalidates.
  const [data, setData] = useState<DashboardData | null>(
    () => (appUser?.id ? getCachedHomeData(appUser.id)?.dashboard ?? null : null)
  );
  const [subjects, setSubjects] = useState<HomeSubject[]>(
    () => (appUser?.id ? getCachedHomeData(appUser.id)?.subjects ?? [] : [])
  );
  const [loading, setLoading] = useState(
    () => !(appUser?.id && getCachedHomeData(appUser.id))
  );
  const [error, setError] = useState("");

  // Impacts ride along in the home-data payload, so they're seeded from the
  // shared read cache and refreshed by a single getHomeData() call. The button
  // handlers just reveal — they never refetch. This collapses what used to be
  // up to 4 separate API calls per home view into exactly 1.
  const [impacts, setImpacts] = useState<{
    tomorrow: QuickResult;
    best: QuickResult;
    worst: QuickResult;
  } | null>(() => {
    const cached = appUser?.id ? getCachedHomeData(appUser.id) : null;
    return cached
      ? {
          tomorrow: cached.tomorrow,
          best: cached.best_day,
          worst: cached.worst_day,
        }
      : null;
  });
  const [revealed, setRevealed] = useState<{
    tomorrow: boolean;
    best: boolean;
    worst: boolean;
  }>({ tomorrow: false, best: false, worst: false });

  const [timetable, setTimetable] = useState<Record<string, string[]>>(() => {
    const cached = appUser?.id ? getCachedSchedule(appUser.id) : null;
    return cached ? groupSchedule(cached) : {};
  });
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
        setTimetable(groupSchedule(scheduleData));
      } catch (err) {
        console.error("Schedule load failed:", err);
      }
    }

    // Always revalidate. The seed above may be arbitrarily old now, and
    // getSchedule() is TTL-cached, so a call inside the window costs nothing.
    loadSchedule();
  }, [appUser?.id]);

  useEffect(() => {
    if (!appUser?.id) return;

    const userId = appUser.id;
    loadDashboard(userId);
  }, [appUser?.id]);

  async function loadDashboard(userId: number) {
    try {
      setError("");

      // getHomeData serves + refreshes the shared read cache (home-data,
      // subjects, tomorrow, best_day, worst_day in one round-trip); revalidate
      // in the background while any cached content stays on screen.
      const homeData = await getHomeData(userId);

      applyHomeData(homeData);
    } catch (e) {
      const errorMsg =
        e instanceof Error ? e.message : "Failed to load home data";
      setError(errorMsg);
      console.error("Dashboard load error:", errorMsg);
    } finally {
      setLoading(false);
    }
  }

  function applyHomeData(homeData: HomeDataResponse) {
    setData(homeData.dashboard);
    setSubjects(homeData.subjects || []);
    setImpacts((prev) => ({
      tomorrow: homeData.tomorrow ?? prev?.tomorrow ?? {
        title: "Tomorrow",
        new_overall: 0,
        new_avg: 0,
        drop_overall: 0,
        drop_avg: 0,
      },
      best: homeData.best_day ?? prev?.best ?? {
        title: "Best day",
        new_overall: 0,
        new_avg: 0,
        drop_overall: 0,
        drop_avg: 0,
      },
      worst: homeData.worst_day ?? prev?.worst ?? {
        title: "Worst day",
        new_overall: 0,
        new_avg: 0,
        drop_overall: 0,
        drop_avg: 0,
      },
    }));
  }

  function revealImpact(key: "tomorrow" | "best" | "worst") {
    if (!impacts) {
      // Cache miss on first paint; refresh and try again.
      if (!busy && appUser?.id) {
        setBusy(key);
        loadDashboard(appUser.id).finally(() => setBusy(""));
      }
      return;
    }

    const override =
      key === "tomorrow"
        ? { ...impacts.tomorrow, title: titleForNextClass(timetable) }
        : null;

    if (override) {
      setImpacts({ ...impacts, tomorrow: override });
    }

    setRevealed((prev) => ({ ...prev, [key]: true }));
  }

  function titleForNextClass(schedule: Record<string, string[]>) {
    const nextClassDay = getNextClassDay(schedule);
    return nextClassDay ? `Next Class Day (${nextClassDay})` : "Tomorrow";
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
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">BunkMax</h1>
          <p className="text-sm text-gray-400 mt-1">
            Stay above 75%, stress-free.
          </p>
        </div>

        <div className="flex gap-2">

          <Link
            href="/about"
            className="icon-button"
            aria-label="About BunkMax"
          >
            <Info size={18} aria-hidden="true" />
          </Link>
        </div>
      </div>

      {loading && !data && <DashboardSkeleton />}

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
              <div className="min-w-0">
                <p className="font-semibold">Import from ERP</p>
                <p className="text-xs text-gray-400 mt-1">
                  Import subjects and attendance into BunkMax
                </p>
              </div>

              <Link
                href="/import"
                className="inline-flex min-w-[96px] items-center justify-center gap-2 rounded-full border border-[#1d9bf0]/25 bg-[#1d9bf0]/12 px-3 py-2 text-sm font-bold text-[#8ecdf8]"
              >
                <Upload size={15} aria-hidden="true" />
                Open
              </Link>
            </div>
          </div>

          <div className="section-title">Quick Actions</div>

          <QuickCard
            title="Should I skip tomorrow?"
            desc="Impact of missing the next class day."
            buttonText={revealed.tomorrow ? "Viewed" : "Check Tomorrow"}
            onClick={() => revealImpact("tomorrow")}
            result={impacts?.tomorrow ?? null}
            disabled={revealed.tomorrow || busy !== ""}
          />

          <QuickCard
            title="Best day to skip"
            desc="Find the day with least attendance impact."
            buttonText={revealed.best ? "Viewed" : "Find Best Day"}
            onClick={() => revealImpact("best")}
            result={impacts?.best ?? null}
            disabled={revealed.best || busy !== ""}
          />

          <QuickCard
            title="Avoid skipping on"
            desc="Know the day with highest attendance impact."
            buttonText={revealed.worst ? "Viewed" : "Find Worst Day"}
            onClick={() => revealImpact("worst")}
            result={impacts?.worst ?? null}
            disabled={revealed.worst || busy !== ""}
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

function DashboardSkeleton() {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 items-stretch">
        <Skeleton className="row-span-2 min-h-[220px]" />
        <Skeleton className="min-h-[104px]" />
        <Skeleton className="min-h-[104px]" />
      </div>

      <Skeleton className="h-[76px]" />

      <div className="section-title">Quick Actions</div>
      <Skeleton className="h-[120px]" />
      <Skeleton className="h-[120px]" />
      <Skeleton className="h-[120px]" />

      <div className="section-title">Today&apos;s Classes</div>
      <Skeleton className="h-[84px]" />
      <Skeleton className="h-[84px]" />
    </>
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
            #1d9bf0 0% ${value}%,
            rgba(255,255,255,0.14) ${value}% 100%
          )`,
        }}
      />
      <div className="absolute inset-[14px] rounded-full bg-[#101312]" />
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
