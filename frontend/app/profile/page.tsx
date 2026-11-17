"use client";

import { useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import BottomNav from "@/components/BottomNav";
import { clearAllUserData, clearReadCache, updateUser } from "@/lib/api";
import FullScreenLoader from "@/components/FullScreenLoader";
import PushNotificationSettings from "@/components/PushNotificationSettings";
import { clearUserCache, mutateUser, useAppUser } from "@/lib/user";
import { ChevronDown, ChevronRight, UserRound, Pencil, LogOut, Trash2 } from "lucide-react";

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

  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [showClearModal, setShowClearModal] = useState(false);

  const [editingField, setEditingField] = useState<EditField>(null);
  const [editValue, setEditValue] = useState("");

  const [expandedSection, setExpandedSection] = useState<string | null>(null);

  useEffect(() => {
    if (!appUser) return;

    setForm({
      name: appUser.name || "",
      college: appUser.college || "",
      branch: appUser.branch || "",
      semester: appUser.semester || "",
      section: appUser.section || "",
      default_target: appUser.default_target || 75,
    });
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
      mutateUser(form);
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

  function toggleSection(name: string) {
    setExpandedSection((prev) => (prev === name ? null : name));
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
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-[#1d9bf0]/30 bg-[#1d9bf0]/12 text-[#8ecdf8]">
              <UserRound size={30} aria-hidden="true" />
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

        <PushNotificationSettings userId={appUser.id} />

        <AccordionSection
          title="Edit Profile"
          icon={<Pencil className="w-4 h-4" />}
          isOpen={expandedSection === "edit"}
          onToggle={() => toggleSection("edit")}
        >
          <div className="space-y-3 mt-3">
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

            <button
              type="button"
              onClick={handleSaveProfile}
              disabled={saving}
              className="primary-btn disabled:opacity-60 mt-2"
            >
              {saving ? "Updating..." : "Update Profile"}
            </button>
          </div>
        </AccordionSection>

        <AccordionSection
          title="Account"
          icon={<LogOut className="w-4 h-4" />}
          isOpen={expandedSection === "account"}
          onToggle={() => toggleSection("account")}
        >
          <div className="space-y-3 mt-3">
            <button
              type="button"
              onClick={() => setShowClearModal(true)}
              disabled={clearing}
              className="w-full flex items-center justify-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 font-medium text-red-200 hover:bg-red-500/15 active:scale-[0.99] transition disabled:opacity-60"
            >
              <Trash2 className="w-4 h-4" />
              {clearing ? "Clearing..." : "Clear All Data"}
            </button>

            <button
              type="button"
              onClick={() => {
                // Cached reads outlive the session cookie, so drop them here
                // or the next account on this device inherits them.
                clearReadCache();
                clearUserCache();
                signOut({ callbackUrl: "/login" });
              }}
              className="secondary-btn flex items-center justify-center gap-2"
            >
              <LogOut className="w-4 h-4" />
              Sign Out
            </button>
          </div>
        </AccordionSection>

        <BottomNav />
      </div>

      {editingField && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
          <div className="w-full max-w-[360px] rounded-xl border border-white/10 bg-[#101312]/95 p-6 shadow-[0_20px_60px_rgba(0,0,0,0.55)]">
            <h3 className="text-xl font-bold text-white">Edit {capitalize(editingField)}</h3>

            <input
              autoFocus
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              className="input-ui mt-4"
              placeholder={`Enter ${editingField}`}
            />

            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => {
                  setEditingField(null);
                  setEditValue("");
                }}
                className="secondary-btn"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={saveField}
                className="primary-btn"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {showClearModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
          <div className="w-full max-w-[360px] rounded-xl border border-white/10 bg-[#101312]/95 p-6 shadow-[0_20px_60px_rgba(0,0,0,0.55)]">
            <h3 className="text-xl font-bold text-white">Clear All Data?</h3>
            <p className="mt-3 text-sm leading-relaxed text-gray-300">
              This will delete all your saved subjects and schedule data. This action cannot be undone.
            </p>

            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setShowClearModal(false)}
                className="secondary-btn"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={handleClearAllData}
                disabled={clearing}
                className="rounded-lg bg-red-500 px-4 py-3 font-semibold text-white hover:bg-red-400 transition disabled:opacity-60"
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

function AccordionSection({
  title,
  icon,
  isOpen,
  onToggle,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="glass-card overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3.5 text-left transition hover:bg-white/5"
      >
        <div className="flex items-center gap-2.5">
          <span className="text-[#8ecdf8]">{icon}</span>
          <span className="font-semibold text-sm">{title}</span>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-gray-400 transition-transform ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>
      {isOpen && <div className="px-4 pb-4">{children}</div>}
    </div>
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
      className="flex items-center justify-between px-3 py-3 rounded-lg border border-white/[0.06] bg-white/[0.03] cursor-pointer hover:bg-white/5 transition"
    >
      <div>
        <p className="text-xs text-gray-400">{label}</p>
        <p className="text-base font-semibold mt-0.5">{value || "-"}</p>
      </div>

      <ChevronRight size={16} className="text-gray-500" />
    </div>
  );
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}