"use client";

import { useState } from "react";
import { importAttendance } from "@/lib/api";
import { useAppUser } from "@/lib/user";
import BottomNav from "@/components/BottomNav";

type PreviewRow = {
  subjectid: string;
  subject_name: string;
  course_type: "Theory" | "Practical";
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
  const end = text.indexOf("Average Attendance");

  if (start === -1 || end === -1 || end <= start) return [];

  const section = text.slice(start + "Course Wise Attendance".length, end);
  const lines = section
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const rows: PercentageRow[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const isPercent = /^\d+(\.\d+)?%$/.test(line);
    if (isPercent) {
      i++;
      continue;
    }

    const next = lines[i + 1];
    if (next && /^\d+(\.\d+)?%$/.test(next)) {
      rows.push({
        subject_name: titleCaseLikeOriginal(line),
        percentage: Number(next.replace("%", "")),
      });
      i += 2;
      continue;
    }

    i++;
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
    const attended =
      total > 0 ? Math.round((percentage / 100) * total) : 0;

    preview.push({
      subjectid: String(preview.length + 1),
      subject_name: session.subject_name,
      course_type: session.course_type,
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
      setMessage("Preview ready ✅");
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

    if (field === "subject_name" || field === "course_type") {
      updated[index][field] = value as never;
    } else {
      updated[index][field] = Number(value) as never;
    }

    if (field === "attended" || field === "total" || field === "percentage") {
      const attended = Number(updated[index].attended || 0);
      const total = Number(updated[index].total || 0);
      const percentage = total > 0 ? Number(((attended / total) * 100).toFixed(2)) : 0;
      updated[index].percentage = percentage;
    }

    setPreviewRows(updated);
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
        subject_type: row.course_type,
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

                  <select
                    className="input-ui"
                    value={row.course_type}
                    onChange={(e) =>
                      updateRow(index, "course_type", e.target.value)
                    }
                  >
                    <option value="Theory">Theory</option>
                    <option value="Practical">Practical</option>
                  </select>

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
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{row.subject_name}</div>
                    <div className="text-sm text-gray-400">
                      {row.course_type} • {row.attended}/{row.total} • {row.percentage}%
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