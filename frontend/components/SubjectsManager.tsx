"use client";

// The subject CRUD that used to be the whole /subjects page. It now renders
// inside /schedule's "Subjects" tab, where it sits next to the timetable that
// consumes these subject names.

import { useEffect, useState } from "react";
import {
  deleteSubject,
  getSubjects,
  getCachedSubjects,
  saveSubject,
} from "@/lib/api";
import Skeleton from "@/components/Skeleton";
import { Trash2 } from "lucide-react";

type Subject = {
  id: number;
  subject_name: string;
  attended_classes: number;
  total_classes: number;
  required_percentage?: number;
};

function calculateAttendance(attended: number, total: number) {
  return total > 0 ? Number(((attended / total) * 100).toFixed(1)) : 0;
}

export default function SubjectsManager({
  userId,
  onSubjectsChange,
}: {
  userId: number;
  // Lets the timetable tab refresh its subject dropdown after an edit here.
  onSubjectsChange?: (subjects: Subject[]) => void;
}) {
  // Seed synchronously from the shared read cache so switching tabs paints
  // instantly instead of flashing a loader while the network revalidates.
  const [subjects, setSubjects] = useState<Subject[]>(
    () => getCachedSubjects(userId) ?? []
  );
  const [loading, setLoading] = useState(() => !getCachedSubjects(userId));
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);

  const [form, setForm] = useState({
    subject_name: "",
    attended_classes: "",
    total_classes: "",
    required_percentage: 75,
  });

  useEffect(() => {
    loadSubjects(userId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  function publish(next: Subject[]) {
    setSubjects(next);
    onSubjectsChange?.(next);
  }

  async function loadSubjects(id: number) {
    try {
      setError("");
      const data = await getSubjects(id);
      publish(data as Subject[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load subjects");
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();

    if (!form.subject_name.trim()) {
      setError("Enter subject name.");
      return;
    }

    const attended = Number(form.attended_classes || 0);
    const total = Number(form.total_classes || 0);

    if (attended > total) {
      setError("Present classes cannot be greater than total classes.");
      return;
    }

    setError("");

    try {
      await saveSubject(
        {
          subject_name: form.subject_name.trim(),
          attended_classes: attended,
          total_classes: total,
          required_percentage: Number(form.required_percentage || 75),
        },
        userId
      );

      setForm({
        subject_name: "",
        attended_classes: "",
        total_classes: "",
        required_percentage: 75,
      });

      await loadSubjects(userId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save subject");
    }
  }

  async function handleDelete(subjectId: number) {
    setError("");

    try {
      await deleteSubject(subjectId, userId);
      publish(subjects.filter((s) => s.id !== subjectId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete subject");
    }
  }

  async function updateCounts(
    subject: Subject,
    changes: { attended?: number; total?: number }
  ) {
    setError("");
    setBusyId(subject.id);

    try {
      const newAttended = changes.attended ?? subject.attended_classes;
      const newTotal = changes.total ?? subject.total_classes;

      if (newAttended < 0 || newTotal < 0) {
        setError("Counts cannot be negative.");
        return;
      }

      if (newAttended > newTotal) {
        setError("Present classes cannot be greater than total classes.");
        return;
      }

      await saveSubject(
        {
          subject_name: subject.subject_name,
          attended_classes: newAttended,
          total_classes: newTotal,
          required_percentage: subject.required_percentage ?? 75,
        },
        userId
      );

      publish(
        subjects.map((s) =>
          s.id === subject.id
            ? { ...s, attended_classes: newAttended, total_classes: newTotal }
            : s
        )
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update subject");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="section-title">Add or Update Subject</div>

      <form onSubmit={handleSave} className="soft-card p-4 space-y-3">
        <input
          className="input-ui"
          placeholder="Subject name"
          value={form.subject_name}
          onChange={(e) => setForm({ ...form, subject_name: e.target.value })}
        />

        <div className="grid grid-cols-2 gap-3">
          <input
            type="number"
            className="input-ui"
            placeholder="Present"
            value={form.attended_classes}
            onChange={(e) =>
              setForm({ ...form, attended_classes: e.target.value })
            }
          />

          <input
            type="number"
            className="input-ui"
            placeholder="Total"
            value={form.total_classes}
            onChange={(e) => setForm({ ...form, total_classes: e.target.value })}
          />
        </div>

        <input
          type="number"
          className="input-ui"
          placeholder="Required % (default 75)"
          value={form.required_percentage}
          onChange={(e) =>
            setForm({
              ...form,
              required_percentage: Number(e.target.value) || 75,
            })
          }
        />

        <button className="primary-btn">Add / Update Subject</button>
      </form>

      <div className="section-title">Saved Subjects</div>

      {loading && subjects.length === 0 ? (
        <div className="space-y-3">
          <Skeleton className="h-[150px]" />
          <Skeleton className="h-[150px]" />
          <Skeleton className="h-[150px]" />
        </div>
      ) : subjects.length === 0 ? (
        <div className="glass-card p-4 text-sm text-gray-400">
          No subjects added yet.
        </div>
      ) : (
        <div className="space-y-3">
          {subjects.map((subject, index) => {
            const attendance = calculateAttendance(
              subject.attended_classes,
              subject.total_classes
            );

            return (
              <div
                key={`${subject.id ?? "noid"}-${subject.subject_name}-${index}`}
                className="glass-card p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-base">
                      {subject.subject_name}
                    </p>
                    <p className="text-sm text-gray-400 mt-2">
                      Attendance: {attendance}%
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleDelete(subject.id)}
                    className="flex h-10 w-10 items-center justify-center rounded-xl border border-red-500/30 bg-red-500/10 text-red-200 hover:bg-red-500/15 transition"
                    aria-label={`Delete ${subject.subject_name}`}
                    title="Delete subject"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3 mt-4">
                  <CounterCard
                    title="Present"
                    value={subject.attended_classes}
                    disabled={busyId === subject.id}
                    onMinus={() =>
                      updateCounts(subject, {
                        attended: subject.attended_classes - 1,
                      })
                    }
                    onPlus={() =>
                      updateCounts(subject, {
                        attended: subject.attended_classes + 1,
                        total:
                          subject.attended_classes + 1 > subject.total_classes
                            ? subject.attended_classes + 1
                            : subject.total_classes,
                      })
                    }
                  />

                  <CounterCard
                    title="Total"
                    value={subject.total_classes}
                    disabled={busyId === subject.id}
                    onMinus={() =>
                      updateCounts(subject, {
                        total: Math.max(
                          subject.attended_classes,
                          subject.total_classes - 1
                        ),
                      })
                    }
                    onPlus={() =>
                      updateCounts(subject, {
                        total: subject.total_classes + 1,
                      })
                    }
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function CounterCard({
  title,
  value,
  onMinus,
  onPlus,
  disabled,
}: {
  title: string;
  value: number;
  onMinus: () => void;
  onPlus: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs text-gray-400">{title}</p>
          <p className="text-sm font-bold mt-1">{value}</p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onMinus}
            disabled={disabled}
            className="h-8 w-8 rounded-lg border border-white/10 bg-white/10 text-sm font-bold text-white disabled:opacity-50"
          >
            -
          </button>
          <button
            type="button"
            onClick={onPlus}
            disabled={disabled}
            className="h-8 w-8 rounded-lg border border-white/10 bg-white/10 text-sm font-bold text-white disabled:opacity-50"
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
}
