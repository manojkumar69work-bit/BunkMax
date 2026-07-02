"use client";

// Page-shaped skeleton helpers. Each helper mirrors the real page layout so
// the skeleton settles without a content shift once data arrives. Composes
// the base Skeleton box with the same spacing used by the actual screens.

import Skeleton from "./Skeleton";

function CardSkeleton({ className = "", children }: { className?: string; children?: React.ReactNode }) {
  return (
    <div
      className={`rounded-xl border border-white/10 bg-white/[0.04] ${className}`}
      aria-hidden="true"
    >
      {children}
    </div>
  );
}

export function HomePageSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-9 w-40" />
      <Skeleton className="h-4 w-56" />

      <div className="grid grid-cols-2 gap-3 items-stretch">
        <Skeleton className="row-span-2 min-h-[220px]" />
        <Skeleton className="min-h-[104px]" />
        <Skeleton className="min-h-[104px]" />
      </div>

      <Skeleton className="h-[76px]" />

      <div className="section-title">Quick Actions</div>
      <Skeleton className="h-[120px]" />
      <Skeleton className="h-[120px]" />
      <Skeleton className="h-[120px]" />

      <div className="section-title">Today&apos;s Classes</div>
      <Skeleton className="h-[84px]" />
      <Skeleton className="h-[84px]" />
    </div>
  );
}

export function SubjectsPageSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-9 w-44" />
      <Skeleton className="h-4 w-56" />

      <div className="section-title">Add or Update Subject</div>
      <CardSkeleton className="h-[212px]" />

      <div className="section-title">Saved Subjects</div>
      <Skeleton className="h-[150px]" />
      <Skeleton className="h-[150px]" />
      <Skeleton className="h-[150px]" />
    </div>
  );
}

export function SchedulePageSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-9 w-44" />
      <Skeleton className="h-4 w-64" />

      <div className="grid grid-cols-3 gap-3">
        <Skeleton className="h-[88px]" />
        <Skeleton className="h-[88px]" />
        <Skeleton className="h-[88px]" />
      </div>

      <div className="section-title">Subjects</div>
      <CardSkeleton className="h-[120px]" />

      <div className="section-title">Timetable</div>
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-[72px]" />
        <Skeleton className="h-[72px]" />
        <Skeleton className="h-[72px]" />
        <Skeleton className="h-[72px]" />
        <Skeleton className="h-[72px]" />
        <Skeleton className="h-[72px]" />
      </div>

      <div className="section-title">Edit Day</div>
      <CardSkeleton className="h-[420px]" />
    </div>
  );
}

export function ChatPageSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-9 w-44" />
      <Skeleton className="h-4 w-56" />

      <CardSkeleton className="min-h-[420px] p-3">
        <div className="space-y-3">
          <div className="flex gap-2 justify-start">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-10 w-3/4 rounded-2xl" />
          </div>
          <div className="flex gap-2 justify-end">
            <Skeleton className="h-10 w-2/3 rounded-2xl" />
          </div>
          <div className="flex gap-2 justify-start">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-10 w-1/2 rounded-2xl" />
          </div>
        </div>
      </CardSkeleton>

      <div className="flex gap-2 overflow-hidden">
        <Skeleton className="h-8 w-32 rounded-full" />
        <Skeleton className="h-8 w-40 rounded-full" />
        <Skeleton className="h-8 w-36 rounded-full" />
        <Skeleton className="h-8 w-28 rounded-full" />
      </div>

      <Skeleton className="h-12 w-full rounded-2xl" />
    </div>
  );
}

export function PlanPageSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-9 w-44" />
      <Skeleton className="h-4 w-72" />

      <div className="flex items-center justify-between px-2">
        <Skeleton className="h-10 w-10 rounded-xl" />
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-10 w-10 rounded-xl" />
      </div>

      <CardSkeleton className="h-[300px]" />

      <Skeleton className="h-12 w-full rounded-xl" />
    </div>
  );
}

export function ProfilePageSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-9 w-44" />
      <Skeleton className="h-4 w-64" />

      <CardSkeleton className="h-[96px]" />
      <CardSkeleton className="h-[120px]" />

      <Skeleton className="h-[64px] rounded-xl" />
      <Skeleton className="h-[64px] rounded-xl" />
      <Skeleton className="h-[64px] rounded-xl" />

      <Skeleton className="h-12 w-full rounded-xl" />
    </div>
  );
}

export function AppShellSkeleton({
  variant,
}: {
  variant:
    | "home"
    | "subjects"
    | "schedule"
    | "chat"
    | "plan"
    | "profile";
}) {
  // Each variant mirrors the loading shape the corresponding page already
  // uses internally, so the swap is invisible once data lands.
  switch (variant) {
    case "home":
      return <HomePageSkeleton />;
    case "subjects":
      return <SubjectsPageSkeleton />;
    case "schedule":
      return <SchedulePageSkeleton />;
    case "chat":
      return <ChatPageSkeleton />;
    case "plan":
      return <PlanPageSkeleton />;
    case "profile":
      return <ProfilePageSkeleton />;
  }
}
