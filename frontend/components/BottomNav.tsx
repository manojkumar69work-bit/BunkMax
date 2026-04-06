"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  BookOpen,
  Calendar,
  Zap,
  User,
} from "lucide-react";

const tabs = [
  { href: "/subjects", label: "Subjects", icon: BookOpen },
  { href: "/schedule", label: "Schedule", icon: Calendar },
  { href: "/", label: "Home", icon: Home },
  { href: "/plan", label: "Plan", icon: Zap },
  { href: "/profile", label: "Profile", icon: User },
];

export default function BottomNav() {
  const pathname = usePathname();

  return (
    <div className="fixed bottom-3 left-1/2 z-50 w-[95%] max-w-md -translate-x-1/2">
      
      {/* 🔥 Glass container */}
      <div className="relative flex items-center justify-between px-3 py-2 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl shadow-[0_10px_40px_rgba(0,0,0,0.4)]">
        
        {/* Glow overlay */}
        <div className="absolute inset-0 rounded-2xl bg-gradient-to-tr from-white/10 via-transparent to-transparent pointer-events-none" />

        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = pathname === tab.href;

          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`relative flex flex-col items-center justify-center px-3 py-2 rounded-xl transition-all ${
                active
                  ? "text-white"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {/* 🔥 Active background bubble */}
              {active && (
                <div className="absolute inset-0 rounded-xl bg-white/10 backdrop-blur-md border border-white/10 shadow-[0_0_20px_rgba(255,255,255,0.15)]" />
              )}

              <Icon className="relative z-10 h-5 w-5" />

              {/* 🔥 Label only when active */}
              {active && (
                <span className="relative z-10 text-[10px] mt-1">
                  {tab.label}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}