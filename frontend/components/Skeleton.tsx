"use client";

// Base shimmer block. Compose these to build page-shaped skeletons that match
// the real layout so cold loads settle without a jarring content shift.
export default function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-xl bg-white/10 ${className}`}
      aria-hidden="true"
    />
  );
}
