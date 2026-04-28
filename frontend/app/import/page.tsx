"use client";

import { useState } from "react";
import { importAttendance } from "@/lib/api";
import { useAppUser } from "@/lib/user";
import BottomNav from "@/components/BottomNav";

type PreviewRow = {
  subjectid: string;
  subject_name: string;
  attended: number;
  total: number;
  percentage: number;
};

type PercentageRow = {
  subject_name: string;
  percentage: number;
};

type SessionRow = {
  subject_name: string;
  course_type: "Theory" | "Practical";
  total: number;
};

function normalizeSubjectName(name: string) {
  return name
    .toLowerCase()
    .replace(/\(batch.*?\)/gi, "")
    .replace(/\b(batch[-\s]*i+)\b/gi, "")
    .replace(/[|()[\].\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPracticalName(name: string, courseType?: string) {
  const n = name.toLowerCase();
  const t = (courseType || "").toLowerCase();
  return (
    t === "practical" ||
    /\blab\b/.test(n) ||
    /\bpractical\b/.test(n) ||
    /\btraining\b/.test(n)
  );
}

function titleCaseLikeOriginal(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

function parsePercentageSection(text: string): PercentageRow[] {
  const start = text.indexOf("Course Wise Attendance");
  if (start === -1) return [];

  const end = text.indexOf("Course Wise Sessions List");
  const section = text.slice(
    start + "Course Wise Attendance".length,
    end !== -1 ? end : undefined
  );

  const lines = section
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const rows: PercentageRow[] = [];

  let bufferSubjects: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const percentMatch = line.match(/^(\d+(\.\d+)?)\s*%$/);

    if (percentMatch) {
      const percentage = Number(percentMatch[1]);

      if (bufferSubjects.length > 0) {
        // assign same percentage to all buffered subjects
        bufferSubjects.forEach((subject) => {
          rows.push({
            subject_name: titleCaseLikeOriginal(subject),
            percentage,
          });
        });
        bufferSubjects = [];
      }

      continue;
    }

    // skip noise lines
    if (
      line.toLowerCase().includes("present sessions") ||
      line.toLowerCase().includes("total sessions")
    ) {
      continue;
    }

    bufferSubjects.push(line);
  }

  return rows;
}
function parseSessionSection(text: string): SessionRow[] {
  const start = text.indexOf("Course Wise Sessions List");
  if (start === -1) return [];

  const section = text.slice(start);
  const lines = section
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const rows: SessionRow[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const looksLikeCourse =
      line.includes("|") ||
      /lab/i.test(line) ||
      /training/i.test(line) ||
      /economics/i.test(line) ||
      /systems/i.test(line) ||
      /mathematics/i.test(line) ||
      /constitution/i.test(line) ||
      /project/i.test(line) ||
      /skill development/i.test(line);

    if (!looksLikeCourse) continue;

    const next = lines[i + 1];
    const next2 = lines[i + 2];

    const courseType =
      next === "Theory" || next === "Practical"
        ? (next as "Theory" | "Practical")
        : null;

    if (!courseType) continue;
    if (!next2 || !/^\d+$/.test(next2)) continue;

    let subjectName = line;
    if (subjectName.includes("|")) {
      subjectName = subjectName.split("|").slice(1).join("|").trim();
    }

    rows.push({
      subject_name: titleCaseLikeOriginal(subjectName),
      course_type: courseType,
      total: Number(next2),
    });

    i += 2;
  }

  return rows;
}

function buildPreviewRows(text: string): PreviewRow[] {
  const percentageRows = parsePercentageSection(text);
  const sessionRows = parseSessionSection(text);

  const percentageMap = new Map<string, PercentageRow>();
  for (const row of percentageRows) {
    const key = `${normalizeSubjectName(row.subject_name)}__${isPracticalName(
      row.subject_name
    ) ? "practical" : "theory"}`;
    percentageMap.set(key, row);
  }

  const preview: PreviewRow[] = [];

  for (const session of sessionRows) {
    const normalized = normalizeSubjectName(session.subject_name);
    const practicalFlag = isPracticalName(
      session.subject_name,
      session.course_type
    )
      ? "practical"
      : "theory";

    const exactKey = `${normalized}__${practicalFlag}`;
    let matched = percentageMap.get(exactKey);

    if (!matched) {
      matched = percentageRows.find((p) => {
        const pNorm = normalizeSubjectName(p.subject_name);
        const pPractical = isPracticalName(p.subject_name)
          ? "practical"
          : "theory";
        return pNorm === normalized && pPractical === practicalFlag;
      });
    }

    const percentage = matched ? matched.percentage : 0;
    const total = Number(session.total || 0);
    const attended = total > 0 ? Math.round((percentage / 100) * total) : 0;

    preview.push({
      subjectid: String(preview.length + 1),
      subject_name: session.subject_name,
      attended,
      total,
      percentage,
    });
  }

  return preview;
}

export default function ImportPage() {
  const { appUser } = useAppUser();

  const [pastedText, setPastedText] = useState("");
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function handleParse() {
    try {
      setError("");
      setMessage("");

      const rows = buildPreviewRows(pastedText);

      if (!rows.length) {
        setError("Could not parse ERP data. Paste the full attendance text.");
        setPreviewRows([]);
        return;
      }

      setPreviewRows(rows);
      setMessage(" ");
    } catch {
      setError("Failed to parse data");
      setPreviewRows([]);
    }
  }

  function updateRow(
    index: number,
    field: keyof PreviewRow,
    value: string | number
  ) {
    const updated = [...previewRows];
    const row = { ...updated[index] };

    if (field === "subject_name") {
      row.subject_name = String(value);
    } else if (field === "attended") {
      row.attended = Number(value);
      row.percentage =
        row.total > 0 ? Number(((row.attended / row.total) * 100).toFixed(2)) : 0;
    } else if (field === "total") {
      row.total = Number(value);
      row.percentage =
        row.total > 0 ? Number(((row.attended / row.total) * 100).toFixed(2)) : 0;
    } else if (field === "percentage") {
      row.percentage = Number(value);
      row.attended =
        row.total > 0 ? Math.round((row.percentage / 100) * row.total) : 0;
    }

    updated[index] = row;
    setPreviewRows(updated);
  }

  function removeRow(index: number) {
    setPreviewRows((prev) =>
      prev
        .filter((_, i) => i !== index)
        .map((row, i) => ({
          ...row,
          subjectid: String(i + 1),
        }))
    );

    if (editingIndex === index) {
      setEditingIndex(null);
    } else if (editingIndex !== null && editingIndex > index) {
      setEditingIndex(editingIndex - 1);
    }
  }

  async function handleImport() {
    if (!appUser) return;

    setLoading(true);
    setError("");
    setMessage("");

    try {
      const subjects = previewRows.map((row) => ({
        subjectid: row.subjectid,
        subject_name: row.subject_name,
      }));

      const attendance: Record<string, any> = {};

      previewRows.forEach((row) => {
        attendance[row.subjectid] = {
          totalsessions: row.total,
          presentSessionsCount: row.attended,
          percentage: row.percentage.toFixed(2),
        };
      });

      await importAttendance({ subjects, attendance }, appUser.id);

      setMessage("Subjects Saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app-shell space-y-4">
      <h1 className="text-2xl font-bold">Import from ERP</h1>

      <div className="soft-card p-4 space-y-3">
        <p className="font-semibold">Paste ERP Data</p>

        <textarea
          className="input-ui min-h-44"
          value={pastedText}
          onChange={(e) => setPastedText(e.target.value)}
          placeholder="ERP Login/Academic Planning/Paste Here"
        />

        <button onClick={handleParse} className="primary-btn">
          Generate Preview
        </button>
      </div>

      {previewRows.length > 0 && (
        <div className="glass-card p-4 space-y-3">
          <p className="font-semibold">Preview (Editable)</p>

          {previewRows.map((row, index) => (
            <div
              key={`${row.subjectid}-${row.subject_name}-${index}`}
              className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/5 p-3"
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

                  <div className="flex gap-2">
                    <button
                      onClick={() => setEditingIndex(null)}
                      className="w-1/2 rounded-xl bg-white py-3 font-semibold text-black hover:bg-gray-100"
                    >
                      Save
                    </button>

                    <button
                      onClick={() => removeRow(index)}
                      className="w-1/2 rounded-xl border border-red-500/30 bg-red-500/10 py-3 font-semibold text-red-200 hover:bg-red-500/15"
                    >
                      Remove
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-medium">{row.subject_name}</div>
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

      {previewRows.length > 0 && (
        <button
          onClick={handleImport}
          disabled={loading}
          className="primary-btn"
        >
          {loading ? "Importing..." : "Import Attendance"}
        </button>
      )}

      {error && <p className="text-red-400">{error}</p>}
      {message && <p className="text-green-400">{message}</p>}

      <BottomNav />
    </div>
  );
}
