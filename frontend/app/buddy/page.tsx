"use client";

import { useCallback, useEffect, useState } from "react";
import BottomNav from "@/components/BottomNav";
import FullScreenLoader from "@/components/FullScreenLoader";
import Skeleton from "@/components/Skeleton";
import {
  createBuddyInvite,
  getBuddies,
  getBuddyBestDay,
  getCachedBuddies,
  getCachedBuddyPlan,
  redeemBuddyCode,
  removeBuddy,
  type Buddy,
  type BuddyInvite,
  type BuddyPlanResponse,
} from "@/lib/api";
import { useAppUser } from "@/lib/user";
import {
  Check,
  ChevronDown,
  Copy,
  KeyRound,
  Share2,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";

const CODE_LENGTH = 6;

// One utility type role for every label on this page: small, tracked, muted.
const EYEBROW =
  "text-[10px] font-semibold uppercase tracking-[0.14em] text-[#71767b]";

const YOU_COLOR = "#1d9bf0";
const BUDDY_COLOR = "#ffd400";

const DAY_ABBR: Record<string, string> = {
  Monday: "Mon",
  Tuesday: "Tue",
  Wednesday: "Wed",
  Thursday: "Thu",
  Friday: "Fri",
  Saturday: "Sat",
  Sunday: "Sun",
};

function hoursUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (60 * 60 * 1000)));
}

function shortDay(day: string): string {
  return DAY_ABBR[day] ?? day.slice(0, 3);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";

  // Index by code point — parts[0][0] would split an astral character.
  const first = Array.from(parts[0])[0] ?? "";
  const last =
    parts.length > 1 ? Array.from(parts[parts.length - 1])[0] ?? "" : "";

  return (first + last).toUpperCase();
}

// Fixed to two places so figures stack in a column instead of jittering.
function pct(value: number): string {
  return `${value.toFixed(2)}%`;
}

export default function BuddyPage() {
  const { appUser, loadingUser } = useAppUser();

  const userId = appUser?.id;

  // Seed synchronously from the shared read cache so coming back to the tab
  // paints the buddies that were already on screen instead of a skeleton.
  const [buddies, setBuddies] = useState<Buddy[]>(
    () => (userId ? getCachedBuddies(userId)?.buddies ?? [] : [])
  );
  const [invite, setInvite] = useState<BuddyInvite | null>(
    () => (userId ? getCachedBuddies(userId)?.invite ?? null : null)
  );
  const [loading, setLoading] = useState(() => !(userId && getCachedBuddies(userId)));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [codeInput, setCodeInput] = useState("");
  const [joining, setJoining] = useState(false);
  const [minting, setMinting] = useState(false);
  const [copied, setCopied] = useState(false);

  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const cached = userId ? getCachedBuddies(userId) : null;
    return cached?.buddies.length === 1 ? cached.buddies[0].id : null;
  });
  const [plan, setPlan] = useState<BuddyPlanResponse | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState("");

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
    const cached = getCachedBuddyPlan(userId, selectedId);

    setPlan(cached);
    setPlanLoading(!cached);
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

  const pairUpSection = (
    <section className="space-y-3">
      <SectionHeading>Pair up</SectionHeading>

      <PairUpCard
        invite={invite}
        minting={minting}
        copied={copied}
        onMint={handleMint}
        onCopy={handleCopy}
        onShare={handleShare}
      />

      <form onSubmit={handleJoin} className="space-y-3">
        <label className={`${EYEBROW} block`} htmlFor="buddy-code">
          Got a code?
        </label>

        <input
          id="buddy-code"
          className="input-ui text-center font-mono text-xl uppercase tracking-[0.3em] indent-[0.3em]"
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
    </section>
  );

  const buddiesSection = (
    <section className="space-y-3">
      <SectionHeading>
        {buddies.length === 1 ? "Your buddy" : "Your buddies"}
      </SectionHeading>

      <div className="space-y-3">
        {buddies.map((buddy) => {
          const active = selectedId === buddy.id;

          return (
            <div
              key={buddy.id}
              className={`glass-card transition ${
                active ? "border-[#1d9bf0]/45" : ""
              }`}
            >
              <div className="flex items-center gap-2 p-3">
                <button
                  type="button"
                  onClick={() => setSelectedId(active ? null : buddy.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  aria-expanded={active}
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-[13px] font-bold tracking-wide transition ${
                      active
                        ? "border-[#1d9bf0]/45 bg-[#1d9bf0]/20 text-white"
                        : "border-[#2f3336] bg-[#1d9bf0]/10 text-[#1d9bf0]"
                    }`}
                  >
                    {initials(buddy.name)}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">
                      {buddy.name}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-[#71767b]">
                      {buddy.email}
                    </span>
                  </span>

                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-[#71767b] transition-transform ${
                      active ? "rotate-180" : ""
                    }`}
                    aria-hidden="true"
                  />
                </button>

                <button
                  type="button"
                  onClick={() => handleRemove(buddy)}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-transparent text-[#71767b] transition hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-300"
                  aria-label={`Remove ${buddy.name}`}
                  title="Remove buddy"
                >
                  <Trash2 size={17} />
                </button>
              </div>

              {active && (
                <div className="border-t border-[#2f3336] p-3 pt-4">
                  {planLoading ? (
                    <div className="space-y-3">
                      <Skeleton className="h-[104px]" />
                      <Skeleton className="h-[148px]" />
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
    </section>
  );

  const emptyBuddiesCard = (
    <section className="space-y-3">
      <SectionHeading>Your buddies</SectionHeading>

      <div className="soft-card flex items-center gap-3 p-4">
        <Users className="h-5 w-5 shrink-0 text-[#71767b]" aria-hidden="true" />
        <p className="text-xs leading-relaxed text-[#71767b]">
          Once someone joins with your code, their week lands here next to
          yours.
        </p>
      </div>
    </section>
  );

  const hasBuddies = buddies.length > 0;

  return (
    <div className="app-shell">
      <header>
        <p className={EYEBROW}>Bunk together</p>
        <h1 className="mt-1.5 text-[1.75rem] font-extrabold leading-none tracking-[-0.02em]">
          Buddy
        </h1>
        <p className="mt-2 text-sm text-[#71767b]">
          Find the day you can both afford to skip.
        </p>
      </header>

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

      {loading ? (
        <>
          <section className="space-y-3">
            <SectionHeading>Your buddies</SectionHeading>
            <Skeleton className="h-[76px]" />
            <Skeleton className="h-[76px]" />
          </section>

          {/* Stays mounted while the list loads. getBuddies retries for up to
              ~30s on a cold backend, and pasting a code a friend just sent
              shouldn't have to wait for that. */}
          {pairUpSection}
        </>
      ) : hasBuddies ? (
        <>
          {buddiesSection}
          {pairUpSection}
        </>
      ) : (
        <>
          {pairUpSection}
          {emptyBuddiesCard}
        </>
      )}

      <BottomNav />
    </div>
  );
}

// A label with a rule running to the edge — marks where one job on the page
// ends and the next begins.
function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <h2 className={EYEBROW}>{children}</h2>
      <span className="h-px flex-1 bg-[#2f3336]" aria-hidden="true" />
    </div>
  );
}

// A single-use code that expires is a ticket, so it's drawn as one — stub
// perforation included.
function PairUpCard({
  invite,
  minting,
  copied,
  onMint,
  onCopy,
  onShare,
}: {
  invite: BuddyInvite | null;
  minting: boolean;
  copied: boolean;
  onMint: () => void;
  onCopy: () => void;
  onShare: () => void;
}) {
  if (!invite) {
    return (
      <div className="soft-card space-y-3 p-4">
        <p className="text-sm leading-relaxed text-gray-300">
          Generate a code and send it to a friend. Nobody can find you by
          searching — a code is the only way in.
        </p>

        <button
          type="button"
          onClick={onMint}
          disabled={minting}
          className="primary-btn flex items-center justify-center gap-2 disabled:opacity-60"
        >
          <KeyRound className="h-4 w-4" />
          {minting ? "Generating..." : "Generate Code"}
        </button>
      </div>
    );
  }

  return (
    <div className="soft-card">
      <button
        type="button"
        onClick={onCopy}
        // .soft-card clips overflow, so the global outline (offset +2px) would
        // be cut off on this edge-to-edge button. Draw it inside instead.
        className="block w-full px-4 pb-4 pt-5 text-center focus-visible:[outline-offset:-3px]"
        aria-label={`Copy invite code ${invite.code}`}
      >
        <span className={`${EYEBROW} block`}>Your code</span>

        <span className="mt-2.5 block font-mono text-[2rem] font-bold leading-none tracking-[0.32em] indent-[0.32em] text-white">
          {invite.code}
        </span>

        <span className="mt-3 block text-[11px] text-[#71767b]">
          Single use · expires in {hoursUntil(invite.expires_at)}h
        </span>
      </button>

      <div className="border-t border-dashed border-[#2f3336]" />

      <div className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onShare}
            className="secondary-btn flex items-center justify-center gap-2"
          >
            <Share2 className="h-4 w-4" />
            Share
          </button>

          <button
            type="button"
            onClick={onCopy}
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
          onClick={onMint}
          disabled={minting}
          className="w-full py-1 text-xs font-medium text-[#71767b] transition hover:text-gray-300 disabled:opacity-50"
        >
          {minting ? "Generating..." : "Generate a new code"}
        </button>
      </div>
    </div>
  );
}

function BuddyPlan({ plan }: { plan: BuddyPlanResponse }) {
  const best = plan.days.find((d) => d.is_best);

  // Where you both stand is true regardless of the timetable, so it survives
  // the no-week case below instead of being replaced by the explanation.
  const standings = (
    <div className="border-t border-[#2f3336] pt-3">
      <p className={`${EYEBROW} mb-2`}>Where you stand now</p>

      <div className="flex items-stretch">
        <Standing label="You" value={plan.current.you} />
        <span className="w-px bg-[#2f3336]" aria-hidden="true" />
        <Standing label={plan.buddy.name} value={plan.current.buddy} indent />
      </div>
    </div>
  );

  if (plan.days.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-[#71767b]">
          Neither of you has classes on the timetable yet, so there&apos;s no
          week to compare.
        </p>

        {standings}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {best && (
        <div className="rounded-xl border border-[#1d9bf0]/25 bg-gradient-to-b from-[#1d9bf0]/[0.12] to-transparent p-4">
          <p className={EYEBROW}>Best day together</p>

          <p className="mt-1.5 text-[2.5rem] font-extrabold leading-none tracking-[-0.03em] text-white">
            {best.day}
          </p>

          <dl className="mt-3.5 space-y-1">
            <CostLine
              label="You"
              drop={best.you.drop_overall}
              color={YOU_COLOR}
            />
            <CostLine
              label={plan.buddy.name}
              drop={best.buddy.drop_overall}
              color={BUDDY_COLOR}
            />
          </dl>
        </div>
      )}

      <WeekChart plan={plan} />

      {standings}

      <div>
        <p className={`${EYEBROW} mb-2`}>Day by day</p>

        <div className="overflow-hidden rounded-xl border border-[#2f3336] bg-white/[0.03]">
          {plan.days.map((day, i) => (
            <div
              key={day.day}
              className={`grid grid-cols-[2.25rem_1fr_auto] items-center gap-2 border-l-2 py-2.5 pr-3 ${
                day.is_best ? "border-l-white/70 bg-white/[0.04]" : "border-l-transparent"
              } ${i > 0 ? "border-t border-t-[#2f3336]" : ""}`}
            >
              <p
                className={`pl-2.5 text-[11px] font-bold uppercase tracking-wider ${
                  day.is_best ? "text-white" : "text-[#71767b]"
                }`}
              >
                {shortDay(day.day)}
              </p>

              <div className="flex items-center gap-3">
                <Figure drop={day.you.drop_overall} color={YOU_COLOR} />
                <Figure drop={day.buddy.drop_overall} color={BUDDY_COLOR} />
              </div>

              <p className="tnum text-[10px] text-[#71767b]">
                {day.you.classes_missed + day.buddy.classes_missed} classes
              </p>
            </div>
          ))}
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-[#71767b]">
        Ranked by whoever loses more that day — a day that costs one of you
        nothing and the other 3% isn&apos;t a day you&apos;d actually bunk
        together.
      </p>
    </div>
  );
}

// The signature: the whole week on one baseline, both of you side by side.
// The answer is wherever the pair of bars is shortest.
function WeekChart({ plan }: { plan: BuddyPlanResponse }) {
  // The 0 seed keeps an empty week from producing -Infinity, so the chart is
  // safe on its own rather than only behind its caller's length guard.
  const worstDrop = Math.max(
    ...plan.days.map((d) => Math.max(d.you.drop_overall, d.buddy.drop_overall)),
    0
  );

  // Bars are scaled against the worst day of the week, so the shape of the
  // week is visible even when every drop is a fraction of a percent. The floor
  // only guards against dividing by zero on a week that costs nothing.
  const maxDrop = Math.max(worstDrop, 0.01);

  // Drops arrive rounded to 2dp, so a non-zero worst day is always >= 0.01 and
  // its bar reaches the top of the plot. A zero week has no scale to label —
  // captioning it "-0.00%" would imply the floor-height bars cost something.
  const scaleIsMeaningful = worstDrop > 0;

  return (
    <figure>
      {/* The top of the scale, labelled — otherwise the bars are shapes with
          no magnitude. The tallest bar touches this line. */}
      <div className="flex items-center gap-2">
        <span className="h-px flex-1 bg-[#2f3336]" aria-hidden="true" />
        {scaleIsMeaningful && (
          <span className="tnum text-[9px] font-medium text-[#71767b]">
            worst day −{pct(worstDrop)}
          </span>
        )}
      </div>

      {/* One unbroken axis under every column, so the bars share a baseline. */}
      <div className="flex items-end border-b border-[#536471]">
        {plan.days.map((day, i) => (
          <div
            key={day.day}
            className="flex h-24 min-w-0 flex-1 items-end justify-center gap-[3px] px-1"
            role="img"
            aria-label={`${day.day}: you drop ${pct(
              day.you.drop_overall
            )}, ${plan.buddy.name} drops ${pct(day.buddy.drop_overall)}${
              day.is_best ? " — best day together" : ""
            }`}
          >
            <Bar
              height={(day.you.drop_overall / maxDrop) * 100}
              color={YOU_COLOR}
              delay={i * 45}
            />
            <Bar
              height={(day.buddy.drop_overall / maxDrop) * 100}
              color={BUDDY_COLOR}
              delay={i * 45 + 20}
            />
          </div>
        ))}
      </div>

      {/* The best day is called out on the axis itself, not in a floating box. */}
      <div className="flex items-start">
        {plan.days.map((day) => (
          <div key={day.day} className="min-w-0 flex-1 text-center">
            {/* A tick on the axis, sized to the bars rather than the column,
                so it reads the same whether the week has three days or six. */}
            <span
              className={`mx-auto block h-0.5 w-[19px] rounded-full ${
                day.is_best ? "bg-white" : "bg-transparent"
              }`}
              aria-hidden="true"
            />

            <span
              className={`mt-1.5 block text-[10px] font-bold uppercase tracking-wider ${
                day.is_best ? "text-white" : "text-[#71767b]"
              }`}
            >
              {shortDay(day.day)}
            </span>
          </div>
        ))}
      </div>

      <figcaption className="mt-3 flex items-center justify-center gap-4">
        <Key label="You" color={YOU_COLOR} />
        <Key label={plan.buddy.name} color={BUDDY_COLOR} />
      </figcaption>
    </figure>
  );
}

function Bar({
  height,
  color,
  delay,
}: {
  height: number;
  color: string;
  delay: number;
}) {
  return (
    <span
      className="bar-rise w-2 rounded-t-sm"
      style={{
        height: `${Math.min(100, height)}%`,
        minHeight: 3,
        background: color,
        animationDelay: `${delay}ms`,
      }}
      aria-hidden="true"
    />
  );
}

function Key({ label, color }: { label: string; color: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: color }}
        aria-hidden="true"
      />
      <span className="truncate text-[10px] font-medium text-[#71767b]">
        {label}
      </span>
    </span>
  );
}

function CostLine({
  label,
  drop,
  color,
}: {
  label: string;
  drop: number;
  color: string;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="flex min-w-0 items-baseline gap-2 text-xs text-[#71767b]">
        <span
          className="h-2 w-2 shrink-0 translate-y-[-1px] rounded-full"
          style={{ background: color }}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate">{label}</span>
      </dt>
      <dd className="tnum ml-auto text-xs font-semibold text-gray-200">
        −{pct(drop)}
      </dd>
    </div>
  );
}

function Standing({
  label,
  value,
  indent,
}: {
  label: string;
  value: number;
  indent?: boolean;
}) {
  return (
    <div className={`min-w-0 flex-1 ${indent ? "pl-3" : "pr-3"}`}>
      <p className="truncate text-xs text-[#71767b]">{label}</p>
      <p className="tnum mt-0.5 text-xl font-bold">{pct(value)}</p>
    </div>
  );
}

function Figure({ drop, color }: { drop: number; color: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: color }}
        aria-hidden="true"
      />
      <span className="tnum text-xs text-gray-300">−{pct(drop)}</span>
    </span>
  );
}
