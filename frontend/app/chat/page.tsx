"use client";

import { FormEvent, useEffect, useState } from "react";
import BottomNav from "@/components/BottomNav";
import FullScreenLoader from "@/components/FullScreenLoader";
import { getBestDay, getHomeData, getTomorrow, getWorstDay } from "@/lib/api";
import { useAppUser } from "@/lib/user";
import { Bot, Send, Sparkles, UserRound } from "lucide-react";
import type { QuickResultResponse } from "@/lib/api";

type ChatMessage = {
  role: "assistant" | "user";
  content: string;
};

type AssistantContext = {
  overall: number;
  average: number;
  present: number;
  absent: number;
  todayClasses: string[];
  riskySubjects: string[];
  tomorrow?: string;
  bestDay?: string;
  worstDay?: string;
};

const suggestions = [
  "Can I skip tomorrow?",
  "Which subjects are risky?",
  "What classes do I have today?",
  "Best day to bunk?",
];

function formatPercent(value: number) {
  return `${Number(value.toFixed(2))}%`;
}

function buildSubjectRisk(subjects: { subject_name: string; attended_classes: number; total_classes: number }[]) {
  return subjects
    .map((subject) => {
      const percentage =
        subject.total_classes > 0
          ? (subject.attended_classes / subject.total_classes) * 100
          : 0;

      return {
        name: subject.subject_name,
        percentage,
      };
    })
    .filter((subject) => subject.percentage < 75)
    .sort((a, b) => a.percentage - b.percentage)
    .slice(0, 3)
    .map((subject) => `${subject.name} (${formatPercent(subject.percentage)})`);
}

function formatQuickResult(
  result: PromiseSettledResult<QuickResultResponse>,
  buildMessage: (value: QuickResultResponse) => string,
  fallback: string
) {
  if (result.status === "fulfilled") {
    return buildMessage(result.value);
  }

  return fallback;
}

function answerFromContext(question: string, context: AssistantContext | null) {
  if (!context) {
    return "I am still loading your attendance data. Try again in a moment.";
  }

  const text = question.toLowerCase();

  if (text.includes("tomorrow") || text.includes("skip")) {
    return context.tomorrow || "I could not calculate tomorrow yet.";
  }

  if (text.includes("risk") || text.includes("danger") || text.includes("subject")) {
    if (context.riskySubjects.length === 0) {
      return `No subject is below 75% right now. Your overall attendance is ${formatPercent(context.overall)}.`;
    }

    return `Your most sensitive subjects are ${context.riskySubjects.join(", ")}. Focus on these first.`;
  }

  if (text.includes("today") || text.includes("class")) {
    if (context.todayClasses.length === 0) {
      return "You do not have classes scheduled for today in BunkMax.";
    }

    return `Today you have ${context.todayClasses.length} classes: ${context.todayClasses.join(", ")}.`;
  }

  if (text.includes("best")) {
    return context.bestDay || "I could not calculate the best day yet.";
  }

  if (text.includes("worst") || text.includes("avoid")) {
    return context.worstDay || "I could not calculate the worst day yet.";
  }

  if (text.includes("overall") || text.includes("attendance") || text.includes("status")) {
    return `Your overall attendance is ${formatPercent(context.overall)} and subject average is ${formatPercent(context.average)}. Present: ${context.present}, absent: ${context.absent}.`;
  }

  return `You are at ${formatPercent(context.overall)} overall. Ask me about tomorrow, risky subjects, today's classes, or the best day to bunk.`;
}

export default function ChatPage() {
  const { appUser, loadingUser } = useAppUser();
  const [loading, setLoading] = useState(true);
  const [context, setContext] = useState<AssistantContext | null>(null);
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content: "Ask me about your attendance, today's classes, risky subjects, or bunk planning.",
    },
  ]);

  useEffect(() => {
    if (!appUser?.id) return;

    async function loadContext(userId: number) {
      try {
        setLoading(true);
        setError("");

        const homeData = await getHomeData(userId);
        const [tomorrow, best, worst] = await Promise.allSettled([
          getTomorrow(userId),
          getBestDay(userId),
          getWorstDay(userId),
        ]);

        setContext({
          overall: homeData.dashboard.overall_percentage,
          average: homeData.dashboard.current_avg,
          present: homeData.dashboard.total_present,
          absent: homeData.dashboard.total_absent,
          todayClasses: homeData.dashboard.today_classes.map((item) => item.subject_name),
          riskySubjects: buildSubjectRisk(homeData.subjects),
          tomorrow: formatQuickResult(
            tomorrow,
            (value) =>
              `${value.title}: overall may become ${formatPercent(value.new_overall)} with a drop of ${formatPercent(value.drop_overall)}.`,
            "Tomorrow prediction is unavailable right now."
          ),
          bestDay: formatQuickResult(
            best,
            (value) =>
              `${value.title}: expected drop is ${formatPercent(value.drop_overall)} overall.`,
            "Best day prediction is unavailable right now."
          ),
          worstDay: formatQuickResult(
            worst,
            (value) =>
              `${value.title}: expected drop is ${formatPercent(value.drop_overall)} overall.`,
            "Worst day prediction is unavailable right now."
          ),
        });
      } catch (e) {
        const message =
          e instanceof Error ? e.message : "Failed to load chat data.";

        setError(message);
        setContext(null);
        setMessages((current) => [
          ...current,
          {
            role: "assistant",
            content: `I could not load your attendance data right now. ${message}`,
          },
        ]);
      } finally {
        setLoading(false);
      }
    }

    loadContext(appUser.id);
  }, [appUser?.id]);

  function sendMessage(value?: string) {
    const question = (value || input).trim();
    if (!question) return;

    const reply = answerFromContext(question, context);

    setMessages((current) => [
      ...current,
      { role: "user", content: question },
      { role: "assistant", content: reply },
    ]);
    setInput("");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    sendMessage();
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
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">BunkMax Chat</h1>
          <p className="text-sm text-[#71767b] mt-1">
            Attendance answers from your live data
          </p>
        </div>

        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#1d9bf0]/15 text-[#1d9bf0]">
          <Sparkles size={20} aria-hidden="true" />
        </div>
      </div>

      <div className="glass-card min-h-[420px] p-3">
        <div className="space-y-3">
          {messages.map((message, index) => {
            const isUser = message.role === "user";
            const Icon = isUser ? UserRound : Bot;

            return (
              <div
                key={`${message.role}-${index}`}
                className={`flex gap-2 ${isUser ? "justify-end" : "justify-start"}`}
              >
                {!isUser && (
                  <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1d9bf0]/15 text-[#1d9bf0]">
                    <Icon size={16} aria-hidden="true" />
                  </div>
                )}

                <div
                  className={`max-w-[82%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    isUser
                      ? "bg-[#1d9bf0] text-white"
                      : "border border-[#2f3336] bg-black text-gray-100"
                  }`}
                >
                  {message.content}
                </div>
              </div>
            );
          })}
        </div>

        {loading && (
          <div className="mt-4 text-center text-xs text-[#71767b]">
            Loading your attendance context...
          </div>
        )}

        {error && !loading && (
          <div className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-200">
            {error}
          </div>
        )}
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => sendMessage(suggestion)}
            className="shrink-0 rounded-full border border-[#2f3336] bg-[#16181c] px-4 py-2 text-xs font-bold text-gray-200"
          >
            {suggestion}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          className="input-ui"
          placeholder="Ask about attendance"
        />
        <button
          type="submit"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#1d9bf0] text-white"
          aria-label="Send message"
        >
          <Send size={18} aria-hidden="true" />
        </button>
      </form>

      <BottomNav />
    </div>
  );
}
