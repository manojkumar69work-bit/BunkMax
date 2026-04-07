"use client";

export default function FullScreenLoader({
  label = "Loading...",
}: {
  label?: string;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="flex flex-col items-center gap-4">
        <div className="h-12 w-12 rounded-full border-4 border-white/15 border-t-white animate-spin" />
        <p className="text-sm text-gray-400">{label}</p>
      </div>
    </div>
  );
}