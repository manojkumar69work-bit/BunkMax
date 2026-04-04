"use client";

import { useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import BottomNav from "@/components/BottomNav";
import { clearAllUserData, getUser, updateUser } from "@/lib/api";
import { useAppUser } from "@/lib/user";

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
  const [message, setMessage] = useState("");
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    async function load() {
      if (!appUser) return;
      const user = await getUser(appUser.id);
      setForm({
        name: user.name,
        college: user.college,
        branch: user.branch,
        semester: user.semester,
        section: user.section,
        default_target: user.default_target,
      });
    }

    load();
  }, [appUser]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!appUser) return;
    await updateUser(form, appUser.id);
    setMessage("Profile updated successfully.");
  }

  async function handleClearAllData() {
    if (!appUser) return;

    const confirmed = window.confirm(
      "This will delete all your My Subjects and My Schedule data. Continue?"
    );

    if (!confirmed) return;

    try {
      setClearing(true);
      await clearAllUserData(appUser.id);
      setMessage("All subjects and schedule data cleared successfully.");
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Failed to clear all data."
      );
    } finally {
      setClearing(false);
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
          <h1 className="text-2xl font-bold tracking-tight">👤 Profile</h1>
          <p className="text-sm text-gray-400 mt-1">
            Manage your academic profile and defaults
          </p>
        </div>
        <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-300">
          Profile
        </div>
      </div>

      {message && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-200">
          {message}
        </div>
      )}

      <form onSubmit={handleSave} className="soft-card p-4 space-y-3">
        <input
          className="input-ui"
          placeholder="Name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />

        <input
          className="input-ui"
          placeholder="College"
          value={form.college}
          onChange={(e) => setForm({ ...form, college: e.target.value })}
        />

        <input
          className="input-ui"
          placeholder="Branch"
          value={form.branch}
          onChange={(e) => setForm({ ...form, branch: e.target.value })}
        />

        <input
          className="input-ui"
          placeholder="Semester"
          value={form.semester}
          onChange={(e) => setForm({ ...form, semester: e.target.value })}
        />

        <input
          className="input-ui"
          placeholder="Section"
          value={form.section}
          onChange={(e) => setForm({ ...form, section: e.target.value })}
        />

        <input
          type="number"
          className="input-ui"
          placeholder="Default Target"
          value={form.default_target}
          onChange={(e) =>
            setForm({ ...form, default_target: Number(e.target.value) })
          }
        />

        <button className="primary-btn">Update Profile</button>

        <button
          type="button"
          onClick={handleClearAllData}
          disabled={clearing}
          className="w-full rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-200 disabled:opacity-50"
        >
          {clearing ? "Clearing..." : "Clear All Data"}
        </button>

        <button
          type="button"
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="secondary-btn"
        >
          Sign Out
        </button>
      </form>

      <BottomNav />
    </div>
  );
}