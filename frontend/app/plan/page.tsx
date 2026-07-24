"use client";

import { useState } from "react";
import BottomNav from "@/components/BottomNav";
import { calendarPlan } from "@/lib/api";
import { useAppUser } from "@/lib/user";
import FullScreenLoader from "@/components/FullScreenLoader";
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  TrendingUp,
  Target,
  BarChart3,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  X,
  Sparkles,
} from "lucide-react";

type CalendarStatus = "present" | "absent";

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

const INDIAN_HOLIDAYS: Record<string, string> = {
  "2026-01-26": "Republic Day",
  "2026-03-14": "Holi",
  "2026-03-30": "Ramadan (Idul Fitr)",
  "2026-04-02": "Ram Navami",
  "2026-04-14": "Mahavir Jayanti",
  "2026-04-21": "Good Friday",
  "2026-05-01": "Labour Day",
  "2026-05-06": "Buddha Purnima",
  "2026-07-06": "Idul Juha (Bakrid)",
  "2026-08-05": "Muharram",
  "2026-08-15": "Independence Day",
  "2026-08-27": "Janmashtami",
  "2026-10-02": "Gandhi Jayanti",
  "2026-10-05": "Milad-un-Nabi",
  "2026-10-12": "Dussehra",
  "2026-10-31": "Diwali",
  "2026-11-01": "Diwali",
  "2026-11-15": "Guru Nanak Jayanti",
  "2026-12-25": "Christmas Day",
};

const INDIAN_HOLIDAYS_2025: Record<string, string> = {
  "2025-01-26": "Republic Day",
  "2025-03-14": "Holi",
  "2025-03-31": "Ramadan (Idul Fitr)",
  "2025-04-06": "Ram Navami",
  "2025-04-10": "Mahavir Jayanti",
  "2025-04-18": "Good Friday",
  "2025-05-01": "Labour Day",
  "2025-05-12": "Buddha Purnima",
  "2025-06-12": "Idul Juha (Bakrid)",
  "2025-07-03": "Muharram",
  "2025-08-15": "Independence Day",
  "2025-08-16": "Janmashtami",
  "2025-09-05": "Milad-un-Nabi",
  "2025-10-02": "Gandhi Jayanti",
  "2025-10-07": "Dussehra",
  "2025-10-22": "Diwali",
  "2025-10-23": "Diwali",
  "2025-11-05": "Guru Nanak Jayanti",
  "2025-12-25": "Christmas Day",
};

const INDIAN_HOLIDAYS_2027: Record<string, string> = {
  "2027-01-26": "Republic Day",
  "2027-03-03": "Holi",
  "2027-03-20": "Ramadan (Idul Fitr)",
  "2027-03-23": "Ram Navami",
  "2027-04-02": "Mahavir Jayanti",
  "2027-05-01": "Labour Day",
  "2027-04-26": "Buddha Purnima",
  "2027-06-20": "Idul Juha (Bakrid)",
  "2027-07-10": "Muharram",
  "2027-08-15": "Independence Day",
  "2027-08-26": "Janmashtami",
  "2027-10-02": "Gandhi Jayanti",
  "2027-09-15": "Milad-un-Nabi",
  "2027-10-01": "Dussehra",
  "2027-10-19": "Diwali",
  "2027-10-20": "Diwali",
  "2027-11-07": "Guru Nanak Jayanti",
  "2027-12-25": "Christmas Day",
};

function getHolidaysForYear(year: number): Record<string, string> {
  if (year === 2025) return INDIAN_HOLIDAYS_2025;
  if (year === 2027) return INDIAN_HOLIDAYS_2027;
  return INDIAN_HOLIDAYS;
}

function generateCalendarDays(date: Date): (number | null)[] {
  const year = date.getFullYear();
  const month = date.getMonth();

  const jsFirstDay = new Date(year, month, 1).getDay();
  const mondayFirstIndex = jsFirstDay === 0 ? 6 : jsFirstDay - 1;

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

function isPastDateString(dateStr: string): boolean {
  const date = new Date(`${dateStr}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return date < today;
}

export default function PlanPage() {
  const { appUser, loadingUser } = useAppUser();

  const [currentMonth, setCurrentMonth] = useState(new Date());

  const [selectedDates, setSelectedDates] = useState<
    Map<string, CalendarStatus>
  >(new Map());

  const [showDateModal, setShowDateModal] = useState(false);
  const [selectedDateForModal, setSelectedDateForModal] =
    useState<Date | null>(null);

  const [calendarResult, setCalendarResult] =
    useState<CalendarResult | null>(null);

  const [runningPrediction, setRunningPrediction] = useState(false);
  const [error, setError] = useState("");

  const holidays = getHolidaysForYear(currentMonth.getFullYear());

  function previousMonth() {
    const today = new Date();
    const currentStart = new Date(
      currentMonth.getFullYear(),
      currentMonth.getMonth(),
      1
    );
    const todayStart = new Date(today.getFullYear(), today.getMonth(), 1);

    if (currentStart <= todayStart) return;

    setCurrentMonth(
      new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1)
    );
    setError("");
    setCalendarResult(null);
  }

  function nextMonth() {
    setCurrentMonth(
      new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1)
    );
    setError("");
    setCalendarResult(null);
  }

  function handleDateClick(day: number) {
    const dateStr = formatDateString(
      day,
      currentMonth.getMonth(),
      currentMonth.getFullYear()
    );

    if (isPastDateString(dateStr)) return;

    const dateObj = new Date(`${dateStr}T00:00:00`);
    setSelectedDateForModal(dateObj);
    setShowDateModal(true);
  }

  function markDateStatus(status: CalendarStatus) {
    if (!selectedDateForModal) return;

    const dateStr = formatDateString(
      selectedDateForModal.getDate(),
      selectedDateForModal.getMonth(),
      selectedDateForModal.getFullYear()
    );

    const updated = new Map(selectedDates);
    updated.set(dateStr, status);

    setSelectedDates(updated);
    setCalendarResult(null);
    setError("");
    setShowDateModal(false);
    setSelectedDateForModal(null);
  }

  function clearDateSelection() {
    if (!selectedDateForModal) return;

    const dateStr = formatDateString(
      selectedDateForModal.getDate(),
      selectedDateForModal.getMonth(),
      selectedDateForModal.getFullYear()
    );

    const updated = new Map(selectedDates);
    updated.delete(dateStr);

    setSelectedDates(updated);
    setCalendarResult(null);
    setError("");
    setShowDateModal(false);
    setSelectedDateForModal(null);
  }

  function removeSelectedDate(dateStr: string) {
    const updated = new Map(selectedDates);
    updated.delete(dateStr);

    setSelectedDates(updated);
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

  const calendarDays = generateCalendarDays(currentMonth);
  const today = new Date();
  const canGoPrevious =
    new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1) >
    new Date(today.getFullYear(), today.getMonth(), 1);

  const monthName = currentMonth.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  return (
    <div className="app-shell">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-blue-500/20 to-purple-600/20 border border-blue-500/20 flex items-center justify-center">
          <Calendar className="w-5 h-5 text-blue-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Plan My Bunks</h1>
          <p className="text-xs text-gray-400">
            Select dates and predict your attendance.
          </p>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2.5 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center justify-between px-1">
        <button
          type="button"
          onClick={previousMonth}
          disabled={!canGoPrevious}
          className="h-9 w-9 rounded-xl border border-white/10 bg-white/5 text-gray-300 hover:bg-white/10 transition disabled:opacity-40 disabled:hover:bg-white/5 flex items-center justify-center"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <h2 className="text-base font-semibold">{monthName}</h2>

        <button
          type="button"
          onClick={nextMonth}
          className="h-9 w-9 rounded-xl border border-white/10 bg-white/5 text-gray-300 hover:bg-white/10 transition flex items-center justify-center"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      <div className="glass-card p-3">
        <div className="grid grid-cols-7 gap-0.5">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
            <div
              key={day}
              className="text-xs font-semibold text-gray-500 text-center py-1.5"
            >
              {day.charAt(0)}
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
            const isPast = isPastDateString(dateStr);

            const holidayName = holidays[dateStr];
            const isHoliday = !!holidayName;

            const isToday =
              today.getDate() === day &&
              today.getMonth() === currentMonth.getMonth() &&
              today.getFullYear() === currentMonth.getFullYear();

            const isSunday = new Date(`${dateStr}T00:00:00`).getDay() === 0;

            return (
              <button
                key={dateStr}
                type="button"
                onClick={() => handleDateClick(day)}
                disabled={isPast}
                title={holidayName || undefined}
                className={`aspect-square rounded-lg transition-all flex flex-col items-center justify-center text-sm relative ${
                  isHoliday && !isSelected
                    ? "bg-green-500/15 text-green-300 border border-green-500/20"
                    : isSelected
                    ? status === "present"
                      ? "bg-green-500/20 text-green-200 shadow-sm shadow-green-500/10"
                      : "bg-red-500/20 text-red-200 shadow-sm shadow-red-500/10"
                    : isPast
                    ? "text-gray-700 cursor-not-allowed"
                    : isSunday
                    ? "text-gray-600"
                    : "text-gray-300 hover:bg-white/5"
                } ${isToday ? "ring-2 ring-blue-500/40" : ""}`}
              >
                <span className="font-semibold text-xs">{day}</span>
                {isHoliday && !isSelected && (
                  <Sparkles className="w-2.5 h-2.5 mt-0.5 text-green-400" />
                )}
                {isSelected && (
                  <span className="text-[8px] mt-0.5 leading-none">
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
        className="primary-btn flex items-center justify-center gap-2 disabled:opacity-60"
      >
        {runningPrediction ? (
          <>
            <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
            Calculating...
          </>
        ) : (
          <>
            <BarChart3 className="w-4 h-4" />
            Run Prediction
          </>
        )}
      </button>

      {calendarResult && <ResultsDisplay result={calendarResult} />}

      {calendarResult && calendarResult.skipped_dates.length > 0 && (
        <SkippedDatesDisplay skipped={calendarResult.skipped_dates} />
      )}

      <BottomNav />

      {showDateModal && selectedDateForModal && (
        <DateSelectionModal
          date={selectedDateForModal}
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
          holidayName={
            holidays[
              formatDateString(
                selectedDateForModal.getDate(),
                selectedDateForModal.getMonth(),
                selectedDateForModal.getFullYear()
              )
            ] || undefined
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
  dates: Map<string, CalendarStatus>;
  onRemove: (dateStr: string) => void;
}) {
  const dateArray = Array.from(dates.entries()).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  if (dateArray.length === 0) {
    return (
      <div className="glass-card p-4">
        <div className="flex items-center justify-center gap-2 text-gray-500 text-sm">
          <Calendar className="w-4 h-4" />
          <span>No dates selected yet. Tap a date to begin.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="soft-card p-3">
      <div className="flex items-center justify-between mb-2.5 px-0.5">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          Selected Dates
        </p>
        <span className="text-xs text-gray-500 bg-white/5 px-2 py-0.5 rounded-full">
          {dateArray.length}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {dateArray.map(([dateStr, status]) => (
          <div
            key={dateStr}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium transition ${
              status === "present"
                ? "bg-green-500/15 text-green-300 border border-green-500/20"
                : "bg-red-500/15 text-red-300 border border-red-500/20"
            }`}
          >
            {status === "present" ? (
              <CheckCircle2 className="w-3 h-3" />
            ) : (
              <XCircle className="w-3 h-3" />
            )}
            <span>
              {new Date(`${dateStr}T00:00:00`).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "short",
              })}
            </span>
            <button
              type="button"
              onClick={() => onRemove(dateStr)}
              className="ml-0.5 hover:text-white transition"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResultsDisplay({ result }: { result: CalendarResult }) {
  function formatChange(change: number) {
    if (change > 0) return `Gain +${change.toFixed(2)}%`;
    if (change < 0) return `Drop ${Math.abs(change).toFixed(2)}%`;
    return "No change";
  }

  const overallIsPositive = result.change_overall >= 0;
  const avgIsPositive = result.change_avg >= 0;

  return (
    <div className="glass-card p-4 space-y-4">
      <div className="flex items-center gap-2.5">
        <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-600/20 border border-blue-500/20 flex items-center justify-center">
          <TrendingUp className="w-4 h-4 text-blue-400" />
        </div>
        <div>
          <p className="font-semibold text-sm text-gray-200">
            {result.scenario_label}
          </p>
          <p className="text-xs text-gray-500">Prediction Results</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Target className="w-3.5 h-3.5 text-blue-400" />
            <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider">
              Overall
            </p>
          </div>
          <p className="text-xl font-bold">{result.new_overall.toFixed(1)}%</p>
          <div className="flex items-center gap-1 mt-1">
            <span
              className={`text-[10px] font-medium ${
                overallIsPositive ? "text-green-400" : "text-red-400"
              }`}
            >
              {result.change_overall > 0 ? "↑" : "↓"}{" "}
              {Math.abs(result.change_overall).toFixed(1)}%
            </span>
            <span className="text-[10px] text-gray-500">from current</span>
          </div>
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <BarChart3 className="w-3.5 h-3.5 text-purple-400" />
            <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider">
              Average
            </p>
          </div>
          <p className="text-xl font-bold">{result.new_avg.toFixed(1)}%</p>
          <div className="flex items-center gap-1 mt-1">
            <span
              className={`text-[10px] font-medium ${
                avgIsPositive ? "text-green-400" : "text-red-400"
              }`}
            >
              {result.change_avg > 0 ? "↑" : "↓"}{" "}
              {Math.abs(result.change_avg).toFixed(1)}%
            </span>
            <span className="text-[10px] text-gray-500">from current</span>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3 flex items-center gap-3">
        <div className="h-9 w-9 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
          <Clock className="w-4 h-4 text-blue-400" />
        </div>
        <div>
          <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">
            Simulated Sessions
          </p>
          <p className="text-xl font-bold">{result.simulated_sessions}</p>
        </div>
      </div>
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
    <div className="soft-card p-3 space-y-2">
      <div className="flex items-center gap-2 px-0.5">
        <AlertTriangle className="w-4 h-4 text-amber-400" />
        <p className="text-xs font-semibold text-amber-300 uppercase tracking-wider">
          Skipped Dates
        </p>
      </div>

      {skipped.map(({ date, reason }) => (
        <div
          key={`${date}-${reason}`}
          className="flex items-center justify-between gap-3 text-xs px-3 py-2 rounded-lg border border-white/[0.06] bg-white/[0.03]"
        >
          <span className="text-gray-300">{formatDateDisplay(date)}</span>
          <span className="text-gray-500 text-right">{reason}</span>
        </div>
      ))}
    </div>
  );
}

function DateSelectionModal({
  date,
  onClose,
  onPresent,
  onAbsent,
  onClear,
  currentStatus,
  holidayName,
}: {
  date: Date;
  onClose: () => void;
  onPresent: () => void;
  onAbsent: () => void;
  onClear: () => void;
  currentStatus?: CalendarStatus;
  holidayName?: string;
}) {
  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} />

      <div className="fixed bottom-0 left-0 right-0 z-50 rounded-t-3xl border-t border-white/[0.06] bg-[#0a0e17] p-5 pb-8 space-y-3 animate-slide-up">
        <div className="flex justify-center mb-1">
          <div className="w-10 h-1 rounded-full bg-white/20" />
        </div>

        <div className="text-center mb-2">
          <p className="text-gray-500 text-xs font-medium uppercase tracking-wider">
            Selected Date
          </p>

          <p className="text-lg font-bold mt-1">
            {date.toLocaleDateString("en-GB", {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </p>

          <p className="text-gray-500 text-xs mt-1">
            {date.toLocaleDateString("en-GB", { weekday: "long" })}
          </p>

          {holidayName && (
            <div className="inline-flex items-center gap-1.5 mt-2 px-3 py-1 rounded-full bg-green-500/10 border border-green-500/20 text-xs text-green-300">
              <Sparkles className="w-3 h-3" />
              {holidayName}
            </div>
          )}

          {currentStatus && (
            <div className="inline-flex items-center gap-1.5 mt-2 px-3 py-1 rounded-full bg-white/5 text-xs text-gray-400">
              Currently:{" "}
              <span
                className={`font-semibold ${
                  currentStatus === "present"
                    ? "text-green-400"
                    : "text-red-400"
                }`}
              >
                {currentStatus === "present" ? "Present ✓" : "Absent ✗"}
              </span>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onPresent}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-green-500/20 bg-green-500/15 text-green-300 font-semibold hover:bg-green-500/25 transition"
        >
          <CheckCircle2 className="w-4 h-4" />
          Mark Present
        </button>

        <button
          type="button"
          onClick={onAbsent}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-red-500/20 bg-red-500/15 text-red-300 font-semibold hover:bg-red-500/25 transition"
        >
          <XCircle className="w-4 h-4" />
          Mark Absent
        </button>

        {currentStatus && (
          <button
            type="button"
            onClick={onClear}
            className="w-full text-gray-500 hover:text-gray-300 transition py-2 text-sm font-medium"
          >
            Clear Selection
          </button>
        )}
      </div>
    </>
  );
}