"use client";

import { useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import BottomNav from "@/components/BottomNav";
import { clearAllUserData, getUser, updateUser } from "@/lib/api";
import FullScreenLoader from "@/components/FullScreenLoader";
import { useAppUser } from "@/lib/user";
import { ChevronRight } from "lucide-react";

type EditField = "name" | "college" | "branch" | "semester" | "section" | null;

export default function ProfilePage() {
  const { appUser, loadingUser } = useAppUser();

  const [form, setForm] = useState({
    name: "",
    college: "",
    branch: "",
    semester: "",
    section: "",
    default_target: 75,
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [showClearModal, setShowClearModal] = useState(false);

  const [editingField, setEditingField] = useState<EditField>(null);
  const [editValue, setEditValue] = useState("");

  useEffect(() => {
    async function load() {
      if (!appUser?.id) return;

      try {
        setLoading(true);
        setError("");

        const user = await getUser(appUser.id);

        setForm({
          name: user.name || "",
          college: user.college || "",
          branch: user.branch || "",
          semester: user.semester || "",
          section: user.section || "",
          default_target: user.default_target || 75,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load profile.");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [appUser]);

  function openEdit(field: EditField, value: string) {
    setEditingField(field);
    setEditValue(value);
  }

  function saveField() {
    if (!editingField) return;

    setForm((prev) => ({
      ...prev,
      [editingField]: editValue,
    }));

    setEditingField(null);
    setEditValue("");
  }

  async function handleSaveProfile() {
    if (!appUser?.id) return;

    try {
      setSaving(true);
      setError("");
      setMessage("");

      await updateUser(form, appUser.id);
      setMessage("Profile updated successfully.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update profile.");
    } finally {
      setSaving(false);
    }
  }

  async function handleClearAllData() {
    if (!appUser?.id) return;

    try {
      setClearing(true);
      setError("");
      setMessage("");

      await clearAllUserData(appUser.id);
      setMessage("All subjects and schedule data cleared successfully.");
      setShowClearModal(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to clear all data.");
    } finally {
      setClearing(false);
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

  if (loading) {
    return <FullScreenLoader label="Loading profile..." />;
  }

  return (
    <>
      <div className="app-shell space-y-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">My Profile</h1>
          <p className="text-sm text-gray-400 mt-1">
            Manage your academic profile and defaults
          </p>
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

        <div className="glass-card p-4">
          <div className="flex items-center gap-4">
            <div className="h-16 w-16 shrink-0 rounded-2xl border border-white/10 bg-white/10 flex items-center justify-center text-2xl">
              👤
            </div>

            <div className="min-w-0">
              <h2 className="text-xl font-semibold truncate">
                {form.name || "Your Name"}
              </h2>
              <p className="text-sm text-gray-400 mt-1 truncate">
                {form.college || "Your College"}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <ProfileRow
            label="Name"
            value={form.name}
            onClick={() => openEdit("name", form.name)}
          />

          <ProfileRow
            label="College"
            value={form.college}
            onClick={() => openEdit("college", form.college)}
          />

          <div className="grid grid-cols-2 gap-3">
            <ProfileRow
              label="Branch"
              value={form.branch}
              onClick={() => openEdit("branch", form.branch)}
            />
            <ProfileRow
              label="Semester"
              value={form.semester}
              onClick={() => openEdit("semester", form.semester)}
            />
          </div>

          <ProfileRow
            label="Section"
            value={form.section}
            onClick={() => openEdit("section", form.section)}
          />
        </div>

        <button
          type="button"
          onClick={handleSaveProfile}
          disabled={saving}
          className="w-full rounded-2xl bg-gradient-to-r from-[#f59e0b] to-[#fde68a] px-4 py-3 font-semibold text-black shadow-[0_10px_30px_rgba(245,158,11,0.25)] hover:opacity-95 active:scale-[0.99] transition disabled:opacity-60"
        >
          {saving ? "Updating..." : "Update Profile"}
        </button>

        <button
          type="button"
          onClick={() => setShowClearModal(true)}
          disabled={clearing}
          className="w-full rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 font-medium text-red-200 hover:bg-red-500/15 active:scale-[0.99] transition disabled:opacity-60"
        >
          {clearing ? "Clearing..." : "Clear All Data"}
        </button>

        <button
          type="button"
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 font-medium text-white hover:bg-white/10 active:scale-[0.99] transition"
        >
          Sign Out
        </button>

        <BottomNav />
      </div>

      {editingField && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
          <div className="w-full max-w-[360px] rounded-3xl border border-white/10 bg-[#141824]/95 p-6 shadow-[0_20px_60px_rgba(0,0,0,0.55)]">
            <h3 className="text-xl font-bold text-white">Edit {capitalize(editingField)}</h3>

            <input
              autoFocus
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              className="mt-4 w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none placeholder:text-gray-500"
              placeholder={`Enter ${editingField}`}
            />

            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => {
                  setEditingField(null);
                  setEditValue("");
                }}
                className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 font-medium text-white hover:bg-white/10 transition"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={saveField}
                className="rounded-2xl bg-gradient-to-r from-[#f59e0b] to-[#fde68a] px-4 py-3 font-semibold text-black hover:opacity-95 transition"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {showClearModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
          <div className="w-full max-w-[360px] rounded-3xl border border-white/10 bg-[#141824]/95 p-6 shadow-[0_20px_60px_rgba(0,0,0,0.55)]">
            <h3 className="text-xl font-bold text-white">Clear All Data?</h3>
            <p className="mt-3 text-sm leading-relaxed text-gray-300">
              This will delete all your saved subjects and schedule data. This action cannot be undone.
            </p>

            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setShowClearModal(false)}
                className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 font-medium text-white hover:bg-white/10 transition"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={handleClearAllData}
                disabled={clearing}
                className="rounded-2xl bg-gradient-to-r from-red-600 to-orange-500 px-4 py-3 font-semibold text-white hover:opacity-95 transition disabled:opacity-60"
              >
                {clearing ? "Deleting..." : "Yes, Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ProfileRow({
  label,
  value,
  onClick,
}: {
  label: string;
  value: string;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className="glass-card px-4 py-4 flex items-center justify-between cursor-pointer hover:bg-white/10 transition"
    >
      <div>
        <p className="text-xs text-gray-400">{label}</p>
        <p className="text-base font-semibold mt-1">{value || "-"}</p>
      </div>

      <ChevronRight size={18} className="text-gray-400" />
    </div>
  );
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}