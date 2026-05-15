"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  Calendar,
  MessageCircle,
  Zap,
  User,
} from "lucide-react";

const tabs = [
  { href: "/schedule", label: "Schedule", icon: Calendar },
  { href: "/chat", label: "Chat", icon: MessageCircle },
  { href: "/", label: "Home", icon: Home, center: true },
  { href: "/plan", label: "Plan", icon: Zap },
  { href: "/profile", label: "Profile", icon: User },
];

export default function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="fixed bottom-3 left-1/2 z-50 w-[94%] max-w-md -translate-x-1/2"
    >
      <div className="grid grid-cols-5 gap-1 rounded-2xl border border-[#2f3336] bg-black/92 p-1.5 shadow-[0_16px_44px_rgba(0,0,0,0.56)] backdrop-blur-xl">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active =
            tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);

          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-12 flex-col items-center justify-center rounded-xl px-1 py-1 transition ${
                tab.center ? "-mt-5" : ""
              } ${
                active
                  ? "text-white"
                  : "text-[#71767b] hover:bg-white/7 hover:text-white"
              }`}
            >
              <span
                className={`flex items-center justify-center ${
                  tab.center
                    ? "h-12 w-12 rounded-full bg-[#1d9bf0] text-white shadow-[0_10px_28px_rgba(29,155,240,0.36)]"
                    : active
                    ? "h-7 w-7 rounded-full bg-[#1d9bf0]/15 text-[#1d9bf0]"
                    : "h-7 w-7"
                }`}
              >
                <Icon className={tab.center ? "h-6 w-6" : "h-5 w-5"} aria-hidden="true" />
              </span>
              <span className={`max-w-full truncate text-[10px] font-bold ${tab.center ? "mt-0.5" : "mt-1"}`}>
                {tab.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
