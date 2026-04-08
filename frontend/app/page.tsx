"use client";

import { useEffect, useState } from "react";
import BottomNav from "@/components/BottomNav";
import Link from "next/link";
import { API_BASE } from "@/lib/api";
import FullScreenLoader from "@/components/FullScreenLoader";
import {
  getTomorrow,
  getBestDay,
  getWorstDay,
  markAttendance,
} from "@/lib/api";
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

export default function Home() {
  const { appUser, loadingUser } = useAppUser();

  const [data, setData] = useState<DashboardData | null>(null);
  const [subjects, setSubjects] = useState<HomeSubject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [markingKey, setMarkingKey] = useState<string>("");
  const [tomorrow, setTomorrow] = useState<any>(null);
  const [best, setBest] = useState<any>(null);
  const [worst, setWorst] = useState<any>(null);
  const [busy, setBusy] = useState<"" | "tomorrow" | "best" | "worst">("");

  useEffect(() => {
    if (!appUser) return;
    loadDashboard(appUser.id);
  }, [appUser]);

  async function loadDashboard(userId: number) {
    try {
      setLoading(true);
      setError("");

      const cacheKey = `bunkmax_home_${userId}`;
      const cached = sessionStorage.getItem(cacheKey);

      if (cached) {
        const homeData = JSON.parse(cached);
        setData(homeData.dashboard);
        setSubjects(homeData.subjects);
        setLoading(false);
        return;
      }

      const res = await fetch(`${API_BASE}/users/${userId}/home-data`);

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Failed to load home data");
      }

      const homeData = await res.json();

      sessionStorage.setItem(cacheKey, JSON.stringify(homeData));

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

        if (appUser) {
          const cacheKey = `bunkmax_home_${appUser.id}`;
          sessionStorage.setItem(
            cacheKey,
            JSON.stringify({
              dashboard: {
                current_avg: currentAvg,
                overall_percentage: overallPct,
                total_present: newTotalPresent,
                total_absent: newTotalAbsent,
                today_classes: updatedTodayClasses,
              },
              subjects: updatedSubjects,
            })
          );
        }

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
      <div className="app-shell">
        <div className="glass-card p-5 text-center space-y-3">
          <h1 className="text-xl font-bold">BunkMax</h1>
          <p className="text-sm text-gray-400">
            Please continue from the login page.
          </p>
          <a
            href="/login"
            className="inline-block rounded-xl bg-white px-4 py-2 font-semibold text-black"
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
          <h1 className="text-2xl font-bold tracking-tight">📘 BunkMax</h1>
          <p className="text-sm text-gray-400 mt-1">No Shocks at Semester End.</p>
        </div>
        <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-300">
          Home
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {loading || !data ? (
        <div className="text-sm text-gray-400">Loading dashboard...</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <MetricCard title="Average" value={formatPercent(data.current_avg)} />
            <MetricCard title="Overall" value={formatPercent(data.overall_percentage)} />
            <MetricCard title="Present" value={`${data.total_present}`} />
            <MetricCard title="Absent" value={`${data.total_absent}`} />
          </div>

          

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
            desc="Instant answer for the next class day."
            buttonText={busy === "tomorrow" ? "Checking..." : "Check Tomorrow"}
            onClick={runTomorrow}
            result={tomorrow}
            type="normal"
          />

          <QuickCard
            title="Best day to skip"
            desc="Find the safest upcoming day."
            buttonText={busy === "best" ? "Finding..." : "Find Best Day"}
            onClick={runBest}
            result={best}
            type="best"
          />

          <QuickCard
            title="Avoid skipping on"
            desc="Know the worst upcoming day to miss."
            buttonText={busy === "worst" ? "Finding..." : "Find Worst Day"}
            onClick={runWorst}
            result={worst}
            type="worst"
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
                        <p className="text-xs text-gray-400">Period {item.period_no}</p>
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
                              disabled={markingKey === `${item.period_no}-present`}
                              onClick={() =>
                                handleMark(item.subject_name, item.period_no, "present")
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
                              disabled={markingKey === `${item.period_no}-absent`}
                              onClick={() =>
                                handleMark(item.subject_name, item.period_no, "absent")
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
}

function MetricCard({
  title,
  value,
}: {
  title: string;
  value: string;
}) {
  return (
    <div className="glass-card p-4">
      <p className="metric-title">{title}</p>
      <p className="metric-value">{value}</p>
    </div>
  );
}
function QuickCard({
  title,
  desc,
  buttonText,
  onClick,
  result,
  type,
}: {
  title: string;
  desc: string;
  buttonText: string;
  onClick: () => void;
  result: any;
  type: "normal" | "best" | "worst";
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

          <div className="grid grid-cols-3 gap-2">
            <MiniMetric title="Current" value={`${Number(result.current || 0).toFixed(1)}%`} />
            <MiniMetric title="New" value={`${Number(result.new || 0).toFixed(1)}%`} />
            <MiniMetric title="Drop" value={`${Number(result.drop || 0).toFixed(1)}%`} />
          </div>

          <div
            className={`rounded-xl border p-2 text-sm ${
              type === "worst"
                ? "border-red-500/30 bg-red-500/10 text-red-200"
                : result.safe
                ? "border-green-500/30 bg-green-500/10 text-green-200"
                : "border-yellow-500/30 bg-yellow-500/10 text-yellow-200"
            }`}
          >
            {type === "worst"
              ? "Avoid skipping on this day ❌"
              : result.safe
              ? "Safe to skip ✅"
              : "Not safe to skip ⚠️"}
          </div>
        </div>
      )}
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
function formatPercent(value: number) {
  return `${Number(value.toFixed(2))}%`;
}
