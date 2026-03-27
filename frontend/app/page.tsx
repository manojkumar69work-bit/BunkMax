"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import BottomNav from "@/components/BottomNav";
import {
  getDashboard,
  getTomorrow,
  getBestDay,
  getWorstDay,
  getSubjects,
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

type QuickResult = {
  title: string;
  current: number;
  new: number;
  drop: number;
  safe: boolean;
};

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

export default function Home() {
  const { appUser, loadingUser } = useAppUser();
  const router = useRouter();

  const [data, setData] = useState<DashboardData | null>(null);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [tomorrow, setTomorrow] = useState<QuickResult | null>(null);
  const [best, setBest] = useState<QuickResult | null>(null);
  const [worst, setWorst] = useState<QuickResult | null>(null);

  const [busy, setBusy] = useState<"" | "tomorrow" | "best" | "worst">("");
  const [markingKey, setMarkingKey] = useState<string>("");

  useEffect(() => {
    if (!loadingUser && !appUser) {
      router.push("/login");
    }
  }, [loadingUser, appUser, router]);

  useEffect(() => {
    if (!appUser) return;
    loadDashboard(appUser.id);
  }, [appUser]);

  async function loadDashboard(userId: number) {
    try {
      setLoading(true);
      setError("");

      const [dashboardRes, subjectsRes] = await Promise.all([
        getDashboard(userId),
        getSubjects(userId),
      ]);

      setData(dashboardRes);
      setSubjects(subjectsRes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load dashboard");
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

          const attendance_percentage =
            total > 0 ? Number(((attended / total) * 100).toFixed(1)) : 0;

          let safe_bunks = 0;
          if (total > 0 && attendance_percentage >= subject.required_percentage) {
            const req = subject.required_percentage / 100;
            safe_bunks = Math.max(0, Math.floor(attended / req - total));
          }

          let need_to_recover = 0;
          if (attendance_percentage < subject.required_percentage) {
            const req = subject.required_percentage / 100;
            const x = ((req * total) - attended) / (1 - req);
            need_to_recover = Math.max(0, Math.ceil(x));
          }

          let updatedStatus = "Danger";
          if (attendance_percentage >= subject.required_percentage + 5) {
            updatedStatus = "Safe";
          } else if (attendance_percentage >= subject.required_percentage) {
            updatedStatus = "Warning";
          }

          return {
            ...subject,
            attended_classes: attended,
            total_classes: total,
            attendance_percentage,
            safe_bunks,
            need_to_recover,
            status: updatedStatus,
          };
        });

        const currentAvg =
          updatedSubjects.length > 0
            ? Number(
                (
                  updatedSubjects.reduce(
                    (sum, s) => sum + s.attendance_percentage,
                    0
                  ) / updatedSubjects.length
                ).toFixed(1)
              )
            : 0;

        const overallPct =
          newTotalPresent + newTotalAbsent > 0
            ? Number(
                (
                  (newTotalPresent / (newTotalPresent + newTotalAbsent)) *
                  100
                ).toFixed(1)
              )
            : 0;

        setData((prev) => {
          if (!prev) return prev;

          return {
            ...prev,
            current_avg: currentAvg,
            overall_percentage: overallPct,
            total_present: newTotalPresent,
            total_absent: newTotalAbsent,
            today_classes: prev.today_classes.map((item) =>
              item.period_no === periodNo
                ? {
                    ...item,
                    marked_status: isSameClick ? null : status,
                  }
                : item
            ),
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
    return <div className="app-shell text-sm text-gray-400">Loading user...</div>;
  }

  if (!appUser) {
    return <div className="app-shell text-sm text-gray-400">Redirecting to login...</div>;
  }

  return (
    <div className="app-shell">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">📘 BunkMax</h1>
          <p className="text-sm text-gray-400 mt-1">No tension. No condonation.</p>
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
            <MetricCard title="Average" value={`${data.current_avg.toFixed(1)}%`} />
            <MetricCard title="Overall" value={`${data.overall_percentage.toFixed(1)}%`} />
            <MetricCard title="Present" value={`${data.total_present}`} />
            <MetricCard title="Absent" value={`${data.total_absent}`} />
          </div>

          <div
            className={`rounded-2xl border p-3 text-sm font-medium ${
              data.overall_percentage >= 75
                ? "border-green-500/30 bg-green-500/10 text-green-200"
                : data.overall_percentage >= 65
                ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-200"
                : "border-red-500/30 bg-red-500/10 text-red-200"
            }`}
          >
            {data.overall_percentage >= 75
              ? "You are above 75% ✅"
              : data.overall_percentage >= 65
              ? "You are getting close to shortage ⚠️"
              : "Your attendance is low 🚨"}
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
  result: QuickResult | null;
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
            <MiniMetric title="Current" value={`${result.current.toFixed(1)}%`} />
            <MiniMetric title="New" value={`${result.new.toFixed(1)}%`} />
            <MiniMetric title="Drop" value={`${result.drop.toFixed(1)}%`} />
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