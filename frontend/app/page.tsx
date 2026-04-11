"use client";

import { useEffect, useMemo, useState } from "react";
import BottomNav from "@/components/BottomNav";
import Link from "next/link";
import { getHomeData, getTomorrow, getBestDay, getWorstDay, markAttendance, getSchedule } from "@/lib/api";
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

export default function Home() {
  const { appUser, loadingUser } = useAppUser();

  const [data, setData] = useState<DashboardData | null>(null);
  const [subjects, setSubjects] = useState<HomeSubject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [markingKey, setMarkingKey] = useState<string>("");

  const [tomorrow, setTomorrow] = useState<QuickResult | null>(null);
  const [best, setBest] = useState<QuickResult | null>(null);
  const [worst, setWorst] = useState<QuickResult | null>(null);
  const [timetable, setTimetable] = useState<Record<string, string[]>>({});

  const daysStatus = useMemo(() => {
    if (!data || Object.keys(timetable).length === 0) {
      return "Loading...";
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
        
        const data = await getSchedule(userId);

        const grouped: Record<string, string[]> = {};

        data.forEach((item: any) => {
          if (!grouped[item.day_name]) grouped[item.day_name] = [];
          grouped[item.day_name].push(item.subject_name);
        });

        setTimetable(grouped);
      } catch (err) {
        console.error("Schedule load failed", err);
      }
    }

    loadSchedule();
  }, [appUser]);

  const [busy, setBusy] = useState<"" | "tomorrow" | "best" | "worst">("");

  useEffect(() => {
    if (!appUser) return;
    loadDashboard(appUser.id);
  }, [appUser]);

  

  async function loadDashboard(userId: number) {
    try {
      setLoading(true);
      setError("");

      const homeData = await getHomeData(userId);
      setData(homeData.dashboard);
      setSubjects(homeData.subjects);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load home data");
    } finally {
      setLoading(false);
    }
  }

  async function runTomorrow() {
    if (!appUser) return;
    try {
      setBusy("tomorrow");
      setTomorrow(await getTomorrow(appUser.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy("");
    }
  }

  async function runBest() {
    if (!appUser) return;
    try {
      setBusy("best");
      setBest(await getBestDay(appUser.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy("");
    }
  }

  async function runWorst() {
    if (!appUser) return;
    try {
      setBusy("worst");
      setWorst(await getWorstDay(appUser.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy("");
    }
  }

  async function handleMark(
    subjectName: string,
    periodNo: number,
    status: "present" | "absent"
  ) {
    if (!appUser || !data) return;

    const key = `${periodNo}-${status}`;

    try {
      setMarkingKey(key);

      const todayItem = data.today_classes.find(
        (item) => item.period_no === periodNo
      );
      const oldStatus = todayItem?.marked_status ?? null;
      const isSameClick = oldStatus === status;

      await markAttendance(
        {
          subject_name: subjectName,
          period_no: periodNo,
          status,
        },
        appUser.id
      );

      let newTotalPresent = data.total_present;
      let newTotalAbsent = data.total_absent;

      setSubjects((prevSubjects) => {
        const updatedSubjects = prevSubjects.map((subject) => {
          if (subject.subject_name !== subjectName) return subject;

          let attended = subject.attended_classes;
          let total = subject.total_classes;

          if (isSameClick) {
            if (status === "present") {
              attended = Math.max(0, attended - 1);
              total = Math.max(0, total - 1);
              newTotalPresent = Math.max(0, newTotalPresent - 1);
            } else {
              total = Math.max(0, total - 1);
              newTotalAbsent = Math.max(0, newTotalAbsent - 1);
            }
          } else if (!oldStatus) {
            if (status === "present") {
              attended += 1;
              total += 1;
              newTotalPresent += 1;
            } else {
              total += 1;
              newTotalAbsent += 1;
            }
          } else if (oldStatus === "absent" && status === "present") {
            attended += 1;
            newTotalPresent += 1;
            newTotalAbsent = Math.max(0, newTotalAbsent - 1);
          } else if (oldStatus === "present" && status === "absent") {
            attended = Math.max(0, attended - 1);
            newTotalPresent = Math.max(0, newTotalPresent - 1);
            newTotalAbsent += 1;
          }

          return {
            ...subject,
            attended_classes: attended,
            total_classes: total,
          };
        });

        const currentAvg =
          updatedSubjects.length > 0
            ? Number(
                (
                  updatedSubjects.reduce(
                    (sum, s) =>
                      sum +
                      (s.total_classes > 0
                        ? (s.attended_classes / s.total_classes) * 100
                        : 0),
                    0
                  ) / updatedSubjects.length
                ).toFixed(2)
              )
            : 0;

        const overallPct =
          newTotalPresent + newTotalAbsent > 0
            ? Number(
                (
                  (newTotalPresent / (newTotalPresent + newTotalAbsent)) *
                  100
                ).toFixed(2)
              )
            : 0;

        const updatedTodayClasses = data.today_classes.map((item) =>
          item.period_no === periodNo
            ? {
                ...item,
                marked_status: isSameClick ? null : status,
              }
            : item
        );

        setData((prev) => {
          if (!prev) return prev;

          return {
            ...prev,
            current_avg: currentAvg,
            overall_percentage: overallPct,
            total_present: newTotalPresent,
            total_absent: newTotalAbsent,
            today_classes: updatedTodayClasses,
          };
        });

        return updatedSubjects;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to mark attendance");
    } finally {
      setMarkingKey("");
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
          <div>
            <h1 className="text-3xl font-bold tracking-tight">BunkMax</h1>
            <p className="text-sm text-gray-400 mt-2">
              Your attendance companion
            </p>
          </div>

          <p className="text-sm text-gray-300 leading-relaxed">
            Please sign in with your MLRIT student account to continue.
          </p>

          <a
            href="/login"
            className="inline-flex w-full items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-b from-white to-gray-200 text-black px-4 py-3 font-semibold hover:from-gray-100 hover:to-gray-300 active:scale-[0.98] transition shadow-lg"
          >
            Go to Login
          </a>
        </div>
      </div>
    );
  }

  return (
  <div className="app-shell">
    {/* HEADER */}
    <div className="flex items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">BunkMax</h1>
        <p className="text-sm text-gray-400 mt-1">
          No Shocks at Semester End.
        </p>
      </div>

      <Link
        href="/about"
        className="h-10 w-10 flex items-center justify-center rounded-full border border-white/10 bg-white/5 text-gray-300 hover:text-white hover:bg-white/10 transition backdrop-blur-md"
      >
        <Info size={18} />
      </Link>
          </div>

    {/* ERROR */}
    {error && (
      <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
        {error}
      </div>
    )}

    {/* LOADING / CONTENT */}
    {loading || !data ? (
      <FullScreenLoader label="Loading dashboard..." />
    ) : (
      <>
        <StatsOverview
          overall={data.overall_percentage}
          avg={data.current_avg}
          present={data.total_present}
          absent={data.total_absent}
          daysStatus={daysStatus}
        />

        {/* IMPORT */}
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

        {/* QUICK ACTIONS */}
        <div className="section-title">Quick Actions</div>

        <QuickCard
          title="Should I skip tomorrow?"
          desc="Instant answer for the next class day."
          buttonText={busy === "tomorrow" ? "Checking..." : "Check Tomorrow"}
          onClick={runTomorrow}
          result={tomorrow}
        />

        <QuickCard
          title="Best day to skip"
          desc="Find the safest upcoming day."
          buttonText={busy === "best" ? "Finding..." : "Find Best Day"}
          onClick={runBest}
          result={best}
        />

        <QuickCard
          title="Avoid skipping on"
          desc="Know the worst upcoming day to miss."
          buttonText={busy === "worst" ? "Finding..." : "Find Worst Day"}
          onClick={runWorst}
          result={worst}
        />

        {/* TODAY CLASSES */}
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

                    <div className="flex items-center gap-2">
                      {counts && (
                        <div className="shrink-0 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-gray-200">
                          {counts}
                        </div>
                      )}

                      {item.subject_name && (
                        <>
                          <button
                            type="button"
                            disabled={
                              markingKey === `${item.period_no}-present`
                            }
                            onClick={() =>
                              handleMark(
                                item.subject_name,
                                item.period_no,
                                "present"
                              )
                            }
                            className={`h-9 w-9 rounded-lg text-sm font-bold ${
                              item.marked_status === "present"
                                ? "border border-green-500/30 bg-green-500/25 text-green-200"
                                : "border border-white/10 bg-white/10 text-white"
                            } disabled:opacity-50`}
                          >
                            P
                          </button>

                          <button
                            type="button"
                            disabled={
                              markingKey === `${item.period_no}-absent`
                            }
                            onClick={() =>
                              handleMark(
                                item.subject_name,
                                item.period_no,
                                "absent"
                              )
                            }
                            className={`h-9 w-9 rounded-lg text-sm font-bold ${
                              item.marked_status === "absent"
                                ? "border border-red-500/30 bg-red-500/25 text-red-200"
                                : "border border-white/10 bg-white/10 text-white"
                            } disabled:opacity-50`}
                          >
                            A
                          </button>
                        </>
                      )}
                    </div>
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
  const value = Math.max(0, Math.min(100, percentage));

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
}: {
  title: string;
  desc: string;
  buttonText: string;
  onClick: () => void;
  result: QuickResult | null;
}) {
  return (
    <div className="soft-card p-4 space-y-3">
      <div>
        <p className="font-semibold">{title}</p>
        <p className="text-xs text-gray-400 mt-1">{desc}</p>
      </div>

      <button type="button" onClick={onClick} className="secondary-btn">
        {buttonText}
      </button>

      {result && (
        <div className="glass-card p-4 space-y-3">
          <p className="font-semibold">{result.title}</p>

          <div className="grid grid-cols-2 gap-3">
            <ActionMetricCard
              title="New Overall"
              value={formatPercent(result?.new_overall)}
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
  const dayOrder = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  if (total === 0) return "No data";

  const currentPct = attended / total;

  const getClassesForDay = (day: string) =>
    (timetable[day] || []).filter((s) => String(s || "").trim() !== "").length;

  const activeDays = dayOrder.filter((day) => getClassesForDay(day) > 0);
  if (activeDays.length === 0) return "No schedule";

  // ABOVE OR EQUAL TO 75% => how many full days can still be bunked
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

  // BELOW 75% => how many full days must be attended to recover
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
}