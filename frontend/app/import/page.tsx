"use client";

import { useState } from "react";
import { convertERPText } from "@/utils/convertERP";
import { importAttendance } from "@/lib/api";
import { useAppUser } from "@/lib/user";
import BottomNav from "@/components/BottomNav";

export default function ImportPage() {
  const { appUser } = useAppUser();

  const [pastedText, setPastedText] = useState("");
  const [previewRows, setPreviewRows] = useState<any[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  // 🔥 Parse text → preview
  function handleParse() {
    try {
      const converted = convertERPText(pastedText);

      const rows = converted.subjects.map((s: any) => {
        const a = converted.attendance[s.subjectid];

        return {
          subjectid: s.subjectid,
          subject_name: s.subject_name,
          attended: a.presentSessionsCount,
          total: a.totalsessions,
          percentage: a.percentage,
        };
      });

      setPreviewRows(rows);
      setMessage("Preview ready ✅");
    } catch {
      setError("Failed to parse data");
    }
  }

  // 🔥 Edit field
  function updateRow(index: number, field: string, value: any) {
    const updated = [...previewRows];
    updated[index][field] =
      field === "subject_name" ? value : Number(value);
    setPreviewRows(updated);
  }

  // 🔥 Import to backend
  async function handleImport() {
    if (!appUser) return;

    setLoading(true);
    setError("");
    setMessage("");

    try {
      const subjects = previewRows.map((row, i) => ({
        subjectid: String(i + 1),
        subject_name: row.subject_name,
        subject_type: "Theory",
      }));

      const attendance: any = {};

      previewRows.forEach((row, i) => {
        const id = String(i + 1);

        attendance[id] = {
          totalsessions: row.total,
          presentSessionsCount: row.attended,
          percentage: row.percentage,
        };
      });

      const res = await importAttendance(
        { subjects, attendance },
        appUser.id
      );

      console.log(res);

      setMessage("✅ Attendance imported successfully!");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app-shell space-y-4">
      <h1 className="text-2xl font-bold">Import from ERP</h1>

      {/* 🔥 Paste */}
      <div className="soft-card p-4 space-y-3">
        <p className="font-semibold">Paste ERP Data</p>

        <textarea
          className="input-ui min-h-44"
          value={pastedText}
          onChange={(e) => setPastedText(e.target.value)}
          placeholder="Copy attendance from ERP and paste here..."
        />

        <button onClick={handleParse} className="primary-btn">
          Generate Preview
        </button>
      </div>

      {/* 🔥 Preview */}
      {previewRows.length > 0 && (
        <div className="glass-card p-4 space-y-3">
          <p className="font-semibold">Preview (Editable)</p>

          {previewRows.map((row, index) => (
            <div
              key={index}
              className="flex flex-col gap-2 border border-white/10 p-3 rounded-xl bg-white/5"
            >
              {editingIndex === index ? (
                <>
                  <input
                    className="input-ui"
                    value={row.subject_name}
                    onChange={(e) =>
                      updateRow(index, "subject_name", e.target.value)
                    }
                  />

                  <div className="flex gap-2">
                    <input
                      className="input-ui"
                      type="number"
                      value={row.attended}
                      onChange={(e) =>
                        updateRow(index, "attended", e.target.value)
                      }
                      placeholder="Attended"
                    />

                    <input
                      className="input-ui"
                      type="number"
                      value={row.total}
                      onChange={(e) =>
                        updateRow(index, "total", e.target.value)
                      }
                      placeholder="Total"
                    />

                    <input
                      className="input-ui"
                      type="number"
                      value={row.percentage}
                      onChange={(e) =>
                        updateRow(index, "percentage", e.target.value)
                      }
                      placeholder="%"
                    />
                  </div>

                  <button
                    onClick={() => setEditingIndex(null)}
                    className="primary-btn"
                  >
                    Save
                  </button>
                </>
              ) : (
                <div className="flex justify-between items-center">
                  <div>
                    <div className="font-medium">
                      {row.subject_name}
                    </div>
                    <div className="text-sm text-gray-400">
                      {row.attended}/{row.total} • {row.percentage}%
                    </div>
                  </div>

                  <button
                    onClick={() => setEditingIndex(index)}
                    className="text-xs underline"
                  >
                    Edit
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 🔥 Import */}
      {previewRows.length > 0 && (
        <button
          onClick={handleImport}
          disabled={loading}
          className="primary-btn"
        >
          {loading ? "Importing..." : "Import Attendance"}
        </button>
      )}

      {/* 🔥 Messages */}
      {error && <p className="text-red-400">{error}</p>}
      {message && <p className="text-green-400">{message}</p>}

      <BottomNav />
    </div>
  );
}