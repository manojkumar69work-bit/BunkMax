"use client";

import { useEffect, useState } from "react";
import BottomNav from "@/components/BottomNav";
import { getSubjects, getTimetable, calendarPlan } from "@/lib/api";
import { useAppUser } from "@/lib/user";
import FullScreenLoader from "@/components/FullScreenLoader";

type Subject = {
  id?: number;
  subject_name: string;
  attended_classes: number;
  total_classes: number;
  required_percentage?: number;
};

type Timetable = Record<string, string[]>;

type CalendarResult = {
  scenario_label: string;
  current_overall: number;
  new_overall: number;
  change_overall: number;
  current_avg: number;
  new_avg: number;
  change_avg: number;
  simulated_sessions: number;
  skipped_dates: Array<{
    date: string;
    reason: string;
  }>;
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

/* ✅ FIXED: Calendar now aligns with Mon Tue Wed Thu Fri Sat Sun */
function generateCalendarDays(date: Date): (number | null)[] {
  const year = date.getFullYear();
  const month = date.getMonth();

  const jsFirstDay = new Date(year, month, 1).getDay(); 
  // JS: 0 = Sunday, 1 = Monday, ..., 6 = Saturday

  const mondayFirstIndex = jsFirstDay === 0 ? 6 : jsFirstDay - 1;
  // Calendar UI: 0 = Monday, ..., 6 = Sunday

  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const days: (number | null)[] = [];

  for (let i = 0; i < mondayFirstIndex; i++) {
    days.push(null);
  }

  for (let i = 1; i <= daysInMonth; i++) {
    days.push(i);
  }

  return days;
}

function formatDateString(day: number, month: number, year: number): string {
  const monthStr = String(month + 1).padStart(2, "0");
  const dayStr = String(day).padStart(2, "0");
  return `${year}-${monthStr}-${dayStr}`;
}

function formatDateDisplay(dateStr: string): string {
  const [year, month, day] = dateStr.split("-");
  const date = new Date(`${year}-${month}-${day}T00:00:00`);

  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function PlanPage() {
  const { appUser, loadingUser } = useAppUser();

  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [timetable, setTimetable] = useState<Timetable>({});
  const [loadingPage, setLoadingPage] = useState(true);

  const [currentMonth, setCurrentMonth] = useState(new Date());

  const [selectedDates, setSelectedDates] = useState<
    Map<string, "present" | "absent">
  >(new Map());

  const [showDateModal, setShowDateModal] = useState(false);
  const [selectedDateForModal, setSelectedDateForModal] =
    useState<Date | null>(null);

  const [calendarResult, setCalendarResult] =
    useState<CalendarResult | null>(null);

  const [runningPrediction, setRunningPrediction] = useState(false);
  const [error, setError] = useState("");

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

  function previousMonth() {
    setCurrentMonth(
      new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1)
    );
    setCalendarResult(null);
    setError("");
  }

  function nextMonth() {
    setCurrentMonth(
      new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1)
    );
    setCalendarResult(null);
    setError("");
  }

  function handleDateClick(day: number) {
    const dateStr = formatDateString(
      day,
      currentMonth.getMonth(),
      currentMonth.getFullYear()
    );

    const dateObj = new Date(`${dateStr}T00:00:00`);

    setSelectedDateForModal(dateObj);
    setShowDateModal(true);
  }

  function markDateStatus(status: "present" | "absent") {
    if (!selectedDateForModal) return;

    const dateStr = formatDateString(
      selectedDateForModal.getDate(),
      selectedDateForModal.getMonth(),
      selectedDateForModal.getFullYear()
    );

    const newMap = new Map(selectedDates);
    newMap.set(dateStr, status);

    setSelectedDates(newMap);
    setShowDateModal(false);
    setSelectedDateForModal(null);
    setCalendarResult(null);
    setError("");
  }

  function clearDateSelection() {
    if (!selectedDateForModal) return;

    const dateStr = formatDateString(
      selectedDateForModal.getDate(),
      selectedDateForModal.getMonth(),
      selectedDateForModal.getFullYear()
    );

    const newMap = new Map(selectedDates);
    newMap.delete(dateStr);

    setSelectedDates(newMap);
    setShowDateModal(false);
    setSelectedDateForModal(null);
    setCalendarResult(null);
    setError("");
  }

  function removeSelectedDate(dateStr: string) {
    const newMap = new Map(selectedDates);
    newMap.delete(dateStr);

    setSelectedDates(newMap);
    setCalendarResult(null);
    setError("");
  }

  async function handleRunPrediction() {
    if (!appUser?.id) return;

    if (selectedDates.size === 0) {
      setError("Please select at least one date.");
      return;
    }

    try {
      setRunningPrediction(true);
      setError("");
      setCalendarResult(null);

      const days = Array.from(selectedDates.entries()).map(
        ([date, status]) => ({
          date,
          status,
        })
      );

      const result = await calendarPlan({ days }, appUser.id);

      setCalendarResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to run prediction");
    } finally {
      setRunningPrediction(false);
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

  const calendarDays = generateCalendarDays(currentMonth);

  const monthName = currentMonth.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  return (
    <div className="app-shell">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Plan My Bunks</h1>
        <p className="text-sm text-gray-400 mt-1">
          Select dates and predict your attendance.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {/* Month Navigation */}
      <div className="flex items-center justify-between px-2">
        <button
          type="button"
          onClick={previousMonth}
          className="h-10 w-10 rounded-xl border border-white/10 bg-white/5 text-gray-300 hover:bg-white/10 transition"
        >
          ←
        </button>

        <h2 className="text-lg font-semibold">{monthName}</h2>

        <button
          type="button"
          onClick={nextMonth}
          className="h-10 w-10 rounded-xl border border-white/10 bg-white/5 text-gray-300 hover:bg-white/10 transition"
        >
          →
        </button>
      </div>

      {/* Calendar Grid */}
      <div className="soft-card p-4">
        <div className="grid grid-cols-7 gap-1">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
            <div
              key={day}
              className="text-xs font-semibold text-gray-400 text-center py-2"
            >
              {day}
            </div>
          ))}

          {calendarDays.map((day, idx) => {
            if (day === null) {
              return <div key={`empty-${idx}`} className="aspect-square" />;
            }

            const dateStr = formatDateString(
              day,
              currentMonth.getMonth(),
              currentMonth.getFullYear()
            );

            const isSelected = selectedDates.has(dateStr);
            const status = selectedDates.get(dateStr);

            const today = new Date();
            const isToday =
              today.getDate() === day &&
              today.getMonth() === currentMonth.getMonth() &&
              today.getFullYear() === currentMonth.getFullYear();

            return (
              <button
                key={dateStr}
                type="button"
                onClick={() => handleDateClick(day)}
                className={`aspect-square rounded-lg border transition flex flex-col items-center justify-center text-sm ${
                  isSelected
                    ? status === "present"
                      ? "border-green-500/50 bg-green-500/15 text-green-200"
                      : "border-red-500/50 bg-red-500/15 text-red-200"
                    : "border-white/10 bg-white/5 text-white hover:bg-white/10"
                } ${isToday ? "ring-2 ring-blue-500/50" : ""}`}
              >
                <span className="font-semibold">{day}</span>

                {isSelected && (
                  <span className="text-xs mt-0.5">
                    {status === "present" ? "✓" : "✗"}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <SelectedDatesSummary
        dates={selectedDates}
        onRemove={removeSelectedDate}
      />

      <button
        type="button"
        onClick={handleRunPrediction}
        disabled={runningPrediction || selectedDates.size === 0}
        className="primary-btn disabled:opacity-60"
      >
        {runningPrediction ? "Calculating..." : "Run Prediction"}
      </button>

      {calendarResult && <ResultsDisplay result={calendarResult} />}

      {calendarResult && calendarResult.skipped_dates.length > 0 && (
        <SkippedDatesDisplay skipped={calendarResult.skipped_dates} />
      )}

      <BottomNav />

      {showDateModal && selectedDateForModal && (
        <DateSelectionModal
          date={selectedDateForModal}
          isOpen={showDateModal}
          onClose={() => {
            setShowDateModal(false);
            setSelectedDateForModal(null);
          }}
          onPresent={() => markDateStatus("present")}
          onAbsent={() => markDateStatus("absent")}
          onClear={clearDateSelection}
          currentStatus={
            selectedDates.get(
              formatDateString(
                selectedDateForModal.getDate(),
                selectedDateForModal.getMonth(),
                selectedDateForModal.getFullYear()
              )
            ) || undefined
          }
        />
      )}
    </div>
  );
}

function SelectedDatesSummary({
  dates,
  onRemove,
}: {
  dates: Map<string, "present" | "absent">;
  onRemove: (dateStr: string) => void;
}) {
  const dateArray = Array.from(dates.entries()).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  if (dateArray.length === 0) {
    return (
      <div className="glass-card p-4">
        <p className="text-gray-400 text-sm text-center">
          No dates selected yet.
        </p>
      </div>
    );
  }

  return (
    <div className="soft-card p-4 space-y-2">
      <p className="text-sm font-semibold text-gray-300 mb-3">
        Selected Dates
      </p>

      {dateArray.map(([dateStr, status]) => (
        <div
          key={dateStr}
          className="flex items-center justify-between p-3 rounded-lg border border-white/10 bg-white/5"
        >
          <div>
            <p className="text-sm font-medium">{formatDateDisplay(dateStr)}</p>
            <p
              className={`text-xs ${
                status === "present" ? "text-green-300" : "text-red-300"
              }`}
            >
              {status === "present" ? "✓ Present" : "✗ Absent"}
            </p>
          </div>

          <button
            type="button"
            onClick={() => onRemove(dateStr)}
            className="text-gray-400 hover:text-white transition text-lg font-bold"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function ResultsDisplay({ result }: { result: CalendarResult }) {
  function formatChange(change: number) {
    if (change > 0) return `Gain +${change.toFixed(2)}%`;
    if (change < 0) return `Drop ${Math.abs(change).toFixed(2)}%`;
    return "No change";
  }

  return (
    <div className="glass-card p-4 space-y-3">
      <p className="font-semibold text-gray-200">{result.scenario_label}</p>

      <div className="grid grid-cols-2 gap-2">
        <StatCard
          title="New Overall"
          value={`${result.new_overall.toFixed(2)}%`}
          sub={formatChange(result.change_overall)}
        />

        <StatCard
          title="Overall Change"
          value={`${
            result.change_overall > 0 ? "+" : ""
          }${result.change_overall.toFixed(2)}%`}
        />

        <StatCard
          title="New Average"
          value={`${result.new_avg.toFixed(2)}%`}
          sub={formatChange(result.change_avg)}
        />

        <StatCard
          title="Average Change"
          value={`${
            result.change_avg > 0 ? "+" : ""
          }${result.change_avg.toFixed(2)}%`}
        />
      </div>

      <div className="rounded-lg border border-white/10 bg-white/5 p-3">
        <p className="text-xs text-gray-400">Simulated Sessions</p>
        <p className="text-2xl font-bold mt-1">
          {result.simulated_sessions}
        </p>
      </div>
    </div>
  );
}

function StatCard({
  title,
  value,
  sub,
}: {
  title: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-3">
      <p className="text-xs text-gray-400">{title}</p>
      <p className="text-lg font-bold mt-1">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  );
}

function SkippedDatesDisplay({
  skipped,
}: {
  skipped: Array<{ date: string; reason: string }>;
}) {
  if (!skipped || skipped.length === 0) return null;

  return (
    <div className="soft-card p-4 space-y-2">
      <p className="text-sm font-semibold text-gray-300 mb-3">
        ⚠️ Skipped Dates
      </p>

      {skipped.map(({ date, reason }) => (
        <div
          key={`${date}-${reason}`}
          className="flex items-center justify-between gap-3 text-sm px-3 py-2 rounded-lg border border-white/10 bg-white/5"
        >
          <p className="text-gray-300">{formatDateDisplay(date)}</p>
          <p className="text-xs text-gray-400 text-right">{reason}</p>
        </div>
      ))}
    </div>
  );
}

function DateSelectionModal({
  date,
  isOpen,
  onClose,
  onPresent,
  onAbsent,
  onClear,
  currentStatus,
}: {
  date: Date;
  isOpen: boolean;
  onClose: () => void;
  onPresent: () => void;
  onAbsent: () => void;
  onClear: () => void;
  currentStatus?: "present" | "absent";
}) {
  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      <div className="fixed bottom-0 left-0 right-0 z-50 rounded-t-3xl border-t border-white/10 bg-[#0f172a] p-6 space-y-4">
        <div className="text-center">
          <p className="text-gray-400 text-sm">Selected Date</p>

          <p className="text-xl font-semibold mt-1">
            {date.toLocaleDateString("en-GB", {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </p>

          {currentStatus && (
            <p className="text-xs text-gray-400 mt-2">
              Currently:{" "}
              <span className="font-semibold">
                {currentStatus === "present" ? "Present" : "Absent"}
              </span>
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onPresent}
          className="w-full px-4 py-3 rounded-2xl border border-green-500/30 bg-green-500/20 text-green-200 font-semibold hover:bg-green-500/30 transition"
        >
          Mark Present ✓
        </button>

        <button
          type="button"
          onClick={onAbsent}
          className="w-full px-4 py-3 rounded-2xl border border-red-500/30 bg-red-500/20 text-red-200 font-semibold hover:bg-red-500/30 transition"
        >
          Mark Absent ✗
        </button>

        {currentStatus && (
          <button
            type="button"
            onClick={onClear}
            className="w-full text-gray-400 hover:text-white transition py-2 text-sm font-medium"
          >
            Clear Selection
          </button>
        )}

        <button
          type="button"
          onClick={onClose}
          className="w-full text-gray-400 text-sm py-2 font-medium"
        >
          Close
        </button>
      </div>
    </>
  );
}