"use client";

import { useEffect, useState } from "react";
import BottomNav from "@/components/BottomNav";
import { deleteSubject, getSubjects, saveSubject } from "@/lib/api";
import { useAppUser } from "@/lib/user";

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

export default function SubjectsPage() {
  const { appUser, loadingUser } = useAppUser();

  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);

  const [form, setForm] = useState({
    subject_name: "",
    attended_classes: "",
    total_classes: "",
    required_percentage: 75,
  });

  useEffect(() => {
    if (!appUser) return;
    loadSubjects(appUser.id);
  }, [appUser]);

  async function loadSubjects(userId: number) {
    try {
      setLoading(true);
      setError("");
      const data = await getSubjects(userId);
      setSubjects(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load subjects");
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!appUser) return;

    if (!form.subject_name.trim()) {
      setError("Enter subject name.");
      return;
    }

    setError("");
    setMessage("");

    try {
      await saveSubject(
        {
          subject_name: form.subject_name.trim(),
          attended_classes: Number(form.attended_classes || 0),
          total_classes: Number(form.total_classes || 0),
          required_percentage: form.required_percentage,
        },
        appUser.id
      );

      setForm({
        subject_name: "",
        attended_classes: "",
        total_classes: "",
        required_percentage: 75,
      });

      setMessage("Subject saved successfully.");
      loadSubjects(appUser.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save subject");
    }
  }

  async function handleDelete(name: string) {
    if (!appUser) return;

    setError("");
    setMessage("");

    try {
      await deleteSubject(name, appUser.id);
      setSubjects((prev) => prev.filter((s) => s.subject_name !== name));
      setMessage("Subject deleted.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete subject");
    }
  }

  function recalculateSubject(subject: Subject, attended: number, total: number): Subject {
    const attendance_percentage =
      total > 0 ? Number(((attended / total) * 100).toFixed(1)) : 0;

    let status = "Danger";
    if (attendance_percentage >= subject.required_percentage + 5) {
      status = "Safe";
    } else if (attendance_percentage >= subject.required_percentage) {
      status = "Warning";
    }

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

    return {
      ...subject,
      attended_classes: attended,
      total_classes: total,
      attendance_percentage,
      safe_bunks,
      need_to_recover,
      status,
    };
  }

  async function updateCounts(
    subject: Subject,
    changes: {
      attended?: number;
      total?: number;
    }
  ) {
    if (!appUser) return;

    setError("");
    setMessage("");
    setBusyId(subject.id);

    try {
      const newAttended = changes.attended ?? subject.attended_classes;
      const newTotal = changes.total ?? subject.total_classes;

      if (newAttended < 0 || newTotal < 0) {
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
          required_percentage: subject.required_percentage,
        },
        appUser.id
      );

      setSubjects((prev) =>
        prev.map((s) =>
          s.id === subject.id ? recalculateSubject(s, newAttended, newTotal) : s
        )
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update subject");
    } finally {
      setBusyId(null);
    }
  }

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
          <h1 className="text-2xl font-bold tracking-tight">📚 My Subjects</h1>
          <p className="text-sm text-gray-400 mt-1">
            Manage attendance for each subject
          </p>
        </div>
        <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-300">
          Subjects
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {message && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-200">
          {message}
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
            onChange={(e) =>
              setForm({ ...form, total_classes: e.target.value })
            }
          />
        </div>

        <input
          type="number"
          className="input-ui"
          placeholder="Required % (default 75)"
          value={form.required_percentage}
          onChange={(e) =>
            setForm({ ...form, required_percentage: Number(e.target.value) })
          }
        />

        <button className="primary-btn">Add / Update Subject</button>
      </form>

      <div className="section-title">Saved Subjects</div>

      {loading ? (
        <div className="text-sm text-gray-400">Loading subjects...</div>
      ) : subjects.length === 0 ? (
        <div className="glass-card p-4 text-sm text-gray-400">
          No subjects added yet.
        </div>
      ) : (
        <div className="space-y-3">
          {subjects.map((subject) => (
            <div key={subject.id} className="glass-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-base">{subject.subject_name}</p>
                  <p className="text-sm text-gray-400 mt-1">
                    Attendance: {subject.attendance_percentage.toFixed(1)}%
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => handleDelete(subject.subject_name)}
                  className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-200"
                >
                  Delete
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
                      total: Math.max(subject.attended_classes, subject.total_classes - 1),
                    })
                  }
                  onPlus={() =>
                    updateCounts(subject, {
                      total: subject.total_classes + 1,
                    })
                  }
                />

                <MiniInfo title="Safe Bunks" value={`${subject.safe_bunks}`} />
                <MiniInfo title="Recover Needed" value={`${subject.need_to_recover}`} />
              </div>

              <div className="mt-4">
                {subject.status === "Safe" ? (
                  <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-2 text-sm text-green-200">
                    Safe
                  </div>
                ) : subject.status === "Warning" ? (
                  <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-2 text-sm text-yellow-200">
                    Warning
                  </div>
                ) : (
                  <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-200">
                    Danger
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <BottomNav />
    </div>
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

function MiniInfo({
  title,
  value,
}: {
  title: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      <p className="text-xs text-gray-400">{title}</p>
      <p className="text-sm font-bold mt-1">{value}</p>
    </div>
  );
}