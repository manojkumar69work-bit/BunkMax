"use client";

import { Home, Book, Calendar, Zap, User } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

export default function BottomNav() {
  const router = useRouter();
  const path = usePathname();

  const items = [
    { icon: Book, path: "/subjects", label: "Subjects" },
    { icon: Calendar, path: "/schedule", label: "Schedule" },
    { icon: Home, path: "/", label: "Home" },
    { icon: Zap, path: "/plan", label: "Plan" },
    { icon: User, path: "/profile", label: "Profile" },
  ];

  return (
    <div className="fixed bottom-3 left-1/2 z-50 w-[95%] max-w-md -translate-x-1/2 rounded-3xl border border-white/10 bg-[#0c0f16]/95 px-3 py-2 shadow-[0_12px_40px_rgba(0,0,0,0.35)] backdrop-blur-xl">
      <div className="grid grid-cols-5 gap-1">
        {items.map((item) => {
          const Icon = item.icon;
          const active = path === item.path;

          return (
            <button
              key={item.path}
              onClick={() => router.push(item.path)}
              className={`flex flex-col items-center justify-center rounded-2xl py-2 transition ${
                active ? "bg-white/10 text-white" : "text-gray-400 hover:text-white"
              }`}
            >
              <Icon size={20} />
              <span className="mt-1 text-[10px] font-medium">
                {active ? item.label : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}