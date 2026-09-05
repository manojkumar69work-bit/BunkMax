"use client";

import { useCallback, useEffect, useState } from "react";
import BottomNav from "@/components/BottomNav";
import FullScreenLoader from "@/components/FullScreenLoader";
import Skeleton from "@/components/Skeleton";
import {
  createBuddyInvite,
  getBuddies,
  getBuddyBestDay,
  redeemBuddyCode,
  removeBuddy,
  type Buddy,
  type BuddyInvite,
  type BuddyPlanResponse,
} from "@/lib/api";
import { useAppUser } from "@/lib/user";
import {
  Check,
  Copy,
  KeyRound,
  Share2,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";

const CODE_LENGTH = 6;

function hoursUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (60 * 60 * 1000)));
}

export default function BuddyPage() {
  const { appUser, loadingUser } = useAppUser();

  const [buddies, setBuddies] = useState<Buddy[]>([]);
  const [invite, setInvite] = useState<BuddyInvite | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [codeInput, setCodeInput] = useState("");
  const [joining, setJoining] = useState(false);
  const [minting, setMinting] = useState(false);
  const [copied, setCopied] = useState(false);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [plan, setPlan] = useState<BuddyPlanResponse | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState("");

  const userId = appUser?.id;

  const load = useCallback(async (id: number) => {
    try {
      setError("");
      const data = await getBuddies(id);
      setBuddies(data.buddies);
      setInvite(data.invite);

      // With a single buddy there's nothing to choose — show their plan.
      setSelectedId((prev) => {
        if (prev && data.buddies.some((b) => b.id === prev)) return prev;
        return data.buddies.length === 1 ? data.buddies[0].id : null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load buddies");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!userId) return;
    load(userId);
  }, [userId, load]);

  useEffect(() => {
    if (!userId || !selectedId) {
      setPlan(null);
      setPlanError("");
      return;
    }

    let active = true;
    setPlanLoading(true);
    setPlanError("");

    getBuddyBestDay(userId, selectedId)
      .then((data) => {
        if (active) setPlan(data);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setPlan(null);
        setPlanError(
          e instanceof Error ? e.message : "Failed to load the joint plan"
        );
      })
      .finally(() => {
        if (active) setPlanLoading(false);
      });

    return () => {
      active = false;
    };
  }, [userId, selectedId]);

  async function handleMint() {
    if (!userId) return;

    setMinting(true);
    setError("");
    setNotice("");

    try {
      const data = await createBuddyInvite(userId);
      setInvite({ code: data.code, expires_at: data.expires_at });
      setNotice("New code ready. Any older code you shared has stopped working.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create a code");
    } finally {
      setMinting(false);
    }
  }

  async function handleCopy() {
    if (!invite) return;

    try {
      await navigator.clipboard.writeText(invite.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy — long-press the code to select it.");
    }
  }

  async function handleShare() {
    if (!invite) return;

    const text = `Add me on BunkMax with code ${invite.code} — then we can find the best day to bunk together.`;

    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ text });
        return;
      } catch {
        // Share sheet dismissed — fall through to copy.
      }
    }

    handleCopy();
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!userId) return;

    const code = codeInput.trim().toUpperCase();

    if (code.length !== CODE_LENGTH) {
      setError(`Enter the full ${CODE_LENGTH}-character code.`);
      return;
    }

    setJoining(true);
    setError("");
    setNotice("");

    try {
      const res = await redeemBuddyCode(userId, code);
      setCodeInput("");
      setNotice(`${res.buddy.name} is now your buddy.`);
      setSelectedId(res.buddy.id);
      await load(userId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add buddy");
    } finally {
      setJoining(false);
    }
  }

  async function handleRemove(buddy: Buddy) {
    if (!userId) return;
    if (!confirm(`Remove ${buddy.name} as a buddy?`)) return;

    setError("");
    setNotice("");

    try {
      await removeBuddy(userId, buddy.id);
      if (selectedId === buddy.id) setSelectedId(null);
      await load(userId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove buddy");
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

  return (
    <div className="app-shell">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Buddy</h1>
        <p className="text-sm text-gray-400 mt-1">
          Find the day you can both afford to skip
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {notice && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-200">
          {notice}
        </div>
      )}

      <div className="section-title">Your Invite Code</div>

      <div className="glass-card p-4 space-y-3">
        {invite ? (
          <>
            <button
              type="button"
              onClick={handleCopy}
              className="w-full rounded-xl border border-[#1d9bf0]/30 bg-[#1d9bf0]/10 py-4 text-center transition hover:bg-[#1d9bf0]/15"
              aria-label={`Copy invite code ${invite.code}`}
            >
              <span className="font-mono text-3xl font-bold tracking-[0.35em] text-white">
                {invite.code}
              </span>
            </button>

            <p className="text-xs text-gray-500 text-center">
              Single use · expires in {hoursUntil(invite.expires_at)}h
            </p>

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={handleShare}
                className="secondary-btn flex items-center justify-center gap-2"
              >
                <Share2 className="h-4 w-4" />
                Share
              </button>

              <button
                type="button"
                onClick={handleCopy}
                className="secondary-btn flex items-center justify-center gap-2"
              >
                {copied ? (
                  <>
                    <Check className="h-4 w-4 text-green-400" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" />
                    Copy
                  </>
                )}
              </button>
            </div>

            <button
              type="button"
              onClick={handleMint}
              disabled={minting}
              className="w-full py-2 text-sm font-medium text-gray-500 transition hover:text-gray-300 disabled:opacity-50"
            >
              {minting ? "Generating..." : "Generate a new code"}
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-400">
              Generate a code and send it to a friend. Nobody can find you by
              searching — a code is the only way in.
            </p>
            <button
              type="button"
              onClick={handleMint}
              disabled={minting}
              className="primary-btn flex items-center justify-center gap-2 disabled:opacity-60"
            >
              <KeyRound className="h-4 w-4" />
              {minting ? "Generating..." : "Generate Code"}
            </button>
          </>
        )}
      </div>

      <div className="section-title">Add a Buddy</div>

      <form onSubmit={handleJoin} className="soft-card p-4 space-y-3">
        <input
          className="input-ui text-center font-mono text-xl tracking-[0.3em] uppercase"
          placeholder="ABC123"
          value={codeInput}
          maxLength={CODE_LENGTH}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) =>
            setCodeInput(e.target.value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase())
          }
        />

        <button
          type="submit"
          disabled={joining || codeInput.length !== CODE_LENGTH}
          className="primary-btn flex items-center justify-center gap-2 disabled:opacity-60"
        >
          <UserPlus className="h-4 w-4" />
          {joining ? "Adding..." : "Add Buddy"}
        </button>
      </form>

      <div className="section-title">Your Buddies</div>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-[76px]" />
          <Skeleton className="h-[76px]" />
        </div>
      ) : buddies.length === 0 ? (
        <div className="glass-card p-6 text-center space-y-2">
          <Users className="mx-auto h-8 w-8 text-gray-600" aria-hidden="true" />
          <p className="text-sm text-gray-400">No buddies yet.</p>
          <p className="text-xs text-gray-500">
            Share your code above, or paste one a friend sent you.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {buddies.map((buddy) => {
            const active = selectedId === buddy.id;

            return (
              <div
                key={buddy.id}
                className={`glass-card p-4 transition ${
                  active ? "border-[#1d9bf0]/45" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setSelectedId(active ? null : buddy.id)}
                    className="min-w-0 flex-1 text-left"
                    aria-expanded={active}
                  >
                    <p className="truncate font-semibold">{buddy.name}</p>
                    <p className="truncate text-xs text-gray-500 mt-0.5">
                      {buddy.email}
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleRemove(buddy)}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-red-500/30 bg-red-500/10 text-red-200 transition hover:bg-red-500/15"
                    aria-label={`Remove ${buddy.name}`}
                    title="Remove buddy"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>

                {active && (
                  <div className="mt-4 border-t border-white/[0.06] pt-4">
                    {planLoading ? (
                      <div className="space-y-3">
                        <Skeleton className="h-[92px]" />
                        <Skeleton className="h-[140px]" />
                      </div>
                    ) : planError ? (
                      <p className="text-sm text-amber-300">{planError}</p>
                    ) : plan ? (
                      <BuddyPlan plan={plan} />
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <BottomNav />
    </div>
  );
}

function BuddyPlan({ plan }: { plan: BuddyPlanResponse }) {
  const best = plan.days.find((d) => d.is_best);

  // Bars are scaled against the worst day of the week, so the shape of the
  // week is visible even when every drop is a fraction of a percent.
  const maxDrop = Math.max(
    ...plan.days.map((d) => Math.max(d.you.drop_overall, d.buddy.drop_overall)),
    0.01
  );

  return (
    <div className="space-y-4">
      {best && (
        <div className="rounded-xl border border-green-500/25 bg-green-500/10 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-green-400">
            Best day to bunk together
          </p>
          <p className="mt-1 text-2xl font-bold text-white">{best.day}</p>
          <p className="mt-1 text-xs text-gray-400">
            You drop {best.you.drop_overall}% · {plan.buddy.name} drops{" "}
            {best.buddy.drop_overall}%
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
          <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500">
            You now
          </p>
          <p className="mt-1 text-xl font-bold">{plan.current.you}%</p>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
          <p className="truncate text-[10px] font-medium uppercase tracking-wider text-gray-500">
            {plan.buddy.name} now
          </p>
          <p className="mt-1 text-xl font-bold">{plan.current.buddy}%</p>
        </div>
      </div>

      <div className="space-y-2">
        {plan.days.map((day) => (
          <div
            key={day.day}
            className={`rounded-xl border p-3 ${
              day.is_best
                ? "border-green-500/25 bg-green-500/[0.07]"
                : "border-white/[0.06] bg-white/[0.03]"
            }`}
          >
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">{day.day}</p>
              <p className="text-[10px] text-gray-500">
                {day.you.classes_missed + day.buddy.classes_missed} classes
                missed
              </p>
            </div>

            <div className="mt-2 space-y-1.5">
              <DropBar
                label="You"
                drop={day.you.drop_overall}
                maxDrop={maxDrop}
                tone="blue"
              />
              <DropBar
                label={plan.buddy.name}
                drop={day.buddy.drop_overall}
                maxDrop={maxDrop}
                tone="purple"
              />
            </div>
          </div>
        ))}
      </div>

      <p className="text-[11px] leading-relaxed text-gray-500">
        Ranked by whoever loses more that day — a day that costs one of you
        nothing and the other 3% isn&apos;t a day you&apos;d actually bunk
        together.
      </p>
    </div>
  );
}

function DropBar({
  label,
  drop,
  maxDrop,
  tone,
}: {
  label: string;
  drop: number;
  maxDrop: number;
  tone: "blue" | "purple";
}) {
  const width = Math.min(100, Math.max(2, (drop / maxDrop) * 100));
  const bar = tone === "blue" ? "bg-[#1d9bf0]" : "bg-purple-400";

  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 truncate text-[10px] text-gray-500">
        {label}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={`h-full rounded-full ${bar}`}
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="w-12 shrink-0 text-right text-[10px] font-medium text-gray-400">
        −{drop}%
      </span>
    </div>
  );
}
