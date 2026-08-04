"use client";

import { useCallback, useEffect, useState } from "react";
import {
  importAttendance,
  erpSync,
  erpResync,
  getErpStatus,
  deleteErpCredentials,
  type ErpStatus,
  type ErpSyncResult,
} from "@/lib/api";
import { useAppUser } from "@/lib/user";
import BottomNav from "@/components/BottomNav";

function relativeTime(iso?: string | null) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

type PreviewRow = {
  subjectid: string;
  subject_name: string;
  attended: number;
  total: number;
  percentage: number;
};

type ImportAttendancePayload = {
  totalsessions: number;
  presentSessionsCount: number;
  percentage: string;
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

  // ── ERP portal sync ──
  const [erpId, setErpId] = useState("");
  const [erpPass, setErpPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [keepSynced, setKeepSynced] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [erpStatus, setErpStatus] = useState<ErpStatus | null>(null);
  const [erpMessage, setErpMessage] = useState("");
  const [erpError, setErpError] = useState("");
  const [erpConflicts, setErpConflicts] = useState<string[]>([]);
  const [reLogin, setReLogin] = useState(false);
  const [showManual, setShowManual] = useState(false);

  const refreshErpStatus = useCallback(async () => {
    if (!appUser) return;
    try {
      setErpStatus(await getErpStatus(appUser.id));
    } catch {
      /* status is best-effort; ignore */
    }
  }, [appUser]);

  useEffect(() => {
    refreshErpStatus();
  }, [refreshErpStatus]);

  function applySyncResult(result: ErpSyncResult) {
    setErpError("");
    setErpMessage(
      result.subjects_imported > 0
        ? `${result.message}${
            result.average ? ` Average attendance ${result.average}%.` : ""
          }`
        : result.message
    );
    setErpConflicts(result.timetable_conflicts ?? []);
    setReLogin(false);
    setErpPass("");
    refreshErpStatus();
  }

  async function handlePortalSync() {
    if (!appUser) return;
    if (!erpId.trim() || !erpPass) {
      setErpError("Enter your ERP ID and password.");
      return;
    }

    setSyncing(true);
    setErpError("");
    setErpMessage("");

    try {
      const result = await erpSync(
        {
          erp_username: erpId.trim(),
          erp_password: erpPass,
          save_credentials: keepSynced,
        },
        appUser.id
      );
      applySyncResult(result);
    } catch (e) {
      setErpError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function handleResync() {
    if (!appUser) return;

    setSyncing(true);
    setErpError("");
    setErpMessage("");

    try {
      const result = await erpResync(appUser.id);
      applySyncResult(result);
    } catch (e) {
      setErpError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function handleRemoveSaved() {
    if (!appUser) return;
    setSyncing(true);
    setErpError("");
    setErpMessage("");
    try {
      await deleteErpCredentials(appUser.id);
      setErpStatus({ saved: false });
      setReLogin(false);
      setErpMessage("Saved portal login removed.");
    } catch (e) {
      setErpError(e instanceof Error ? e.message : "Could not remove login");
    } finally {
      setSyncing(false);
    }
  }

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

      const attendance: Record<string, ImportAttendancePayload> = {};

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

      {/* ── Sync from Portal (server-side) ── */}
      <div className="glass-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="font-semibold">Sync from Portal</p>
          <span className="text-xs text-gray-400">vmedulife</span>
        </div>

        {erpStatus?.saved && !reLogin ? (
          <>
            <p className="text-sm text-gray-300">
              Signed in as{" "}
              <span className="font-medium">{erpStatus.erp_username}</span>
              {erpStatus.last_synced_at && (
                <> · last synced {relativeTime(erpStatus.last_synced_at)}</>
              )}
            </p>

            <button
              onClick={handleResync}
              disabled={syncing}
              className="primary-btn"
            >
              {syncing ? "Syncing..." : "Sync now"}
            </button>

            <div className="flex gap-3 text-xs">
              <button
                onClick={() => {
                  setReLogin(true);
                  setErpId(erpStatus.erp_username || "");
                  setErpMessage("");
                  setErpError("");
                }}
                className="underline"
              >
                Use a different login
              </button>
              <button
                onClick={handleRemoveSaved}
                disabled={syncing}
                className="underline text-red-300"
              >
                Remove saved login
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-400">
              Enter your college portal login and we&apos;ll pull your
              attendance automatically.
            </p>

            <input
              className="input-ui"
              value={erpId}
              onChange={(e) => setErpId(e.target.value)}
              placeholder="ERP ID (e.g. STMLRIT24728)"
              autoCapitalize="characters"
              autoComplete="username"
            />

            <div className="flex gap-2">
              <input
                className="input-ui flex-1"
                type={showPass ? "text" : "password"}
                value={erpPass}
                onChange={(e) => setErpPass(e.target.value)}
                placeholder="Portal password"
                autoComplete="current-password"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handlePortalSync();
                }}
              />
              <button
                type="button"
                onClick={() => setShowPass((v) => !v)}
                className="rounded-xl border border-white/10 bg-white/5 px-3 text-sm"
              >
                {showPass ? "Hide" : "Show"}
              </button>
            </div>

            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input
                type="checkbox"
                checked={keepSynced}
                onChange={(e) => setKeepSynced(e.target.checked)}
              />
              Keep me synced (save login securely for auto-sync)
            </label>

            <button
              onClick={handlePortalSync}
              disabled={syncing}
              className="primary-btn"
            >
              {syncing ? "Signing in..." : "Sync from Portal"}
            </button>

            {erpStatus?.saved && reLogin && (
              <button
                onClick={() => {
                  setReLogin(false);
                  setErpPass("");
                  setErpError("");
                }}
                className="text-xs underline"
              >
                Cancel
              </button>
            )}

            <p className="text-[11px] text-gray-500">
              Your password is encrypted and used only to fetch your
              attendance. We never share it.
            </p>
          </>
        )}

        {erpError && <p className="text-red-400 text-sm">{erpError}</p>}
        {erpMessage && <p className="text-green-400 text-sm">{erpMessage}</p>}

        {erpConflicts.length > 0 && (
          <div className="text-xs text-amber-400/90 space-y-1">
            <p>
              Two lab batches share these slots — we kept the first. Fix yours on
              the Schedule page:
            </p>
            <ul className="list-disc pl-4 space-y-0.5">
              {erpConflicts.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <button
        onClick={() => setShowManual((v) => !v)}
        className="text-sm underline text-gray-400"
      >
        {showManual ? "Hide manual paste" : "Paste manually instead"}
      </button>

      {showManual && (
      <>
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
      </>
      )}

      <BottomNav />
    </div>
  );
}
