"use client";

import { useEffect, useState } from "react";
import type { AppUser } from "@/lib/user";
import {
  createSubscriptionOrder,
  getSubscription,
  type SubscriptionPlan,
  verifySubscriptionPayment,
} from "@/lib/api";
import { Check, Loader2, Lock, RefreshCw } from "lucide-react";
import { signOut } from "next-auth/react";

type PaywallModalProps = {
  appUser: AppUser | null;
  loadingUser: boolean;
};

type RazorpayPaymentResponse = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

type RazorpayFailureResponse = {
  error?: {
    description?: string;
    reason?: string;
  };
};

type RazorpayOptions = {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  prefill: {
    name: string;
    email: string;
  };
  theme: {
    color: string;
  };
  modal: {
    ondismiss: () => void;
  };
  handler: (response: RazorpayPaymentResponse) => void;
};

type RazorpayInstance = {
  open: () => void;
  on: (
    event: "payment.failed",
    handler: (response: RazorpayFailureResponse) => void
  ) => void;
};

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

const RAZORPAY_CHECKOUT_SCRIPT =
  "https://checkout.razorpay.com/v1/checkout.js";

function loadRazorpayCheckout() {
  if (window.Razorpay) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[src="${RAZORPAY_CHECKOUT_SCRIPT}"]`
    );

    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener("error", () => reject(), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = RAZORPAY_CHECKOUT_SCRIPT;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject();
    document.body.appendChild(script);
  });
}

export default function PaywallModal({
  appUser,
  loadingUser,
}: PaywallModalProps) {
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [loadingPlans, setLoadingPlans] = useState(true);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [error, setError] = useState("");
  const userId = appUser?.id;
  const isPro = appUser?.is_pro === true;

  useEffect(() => {
    if (!userId || isPro) {
      return;
    }

    getSubscription(userId)
      .then((data) => {
        setPlans(data.plans.filter((plan) => plan.id !== "free"));
      })
      .catch((err) => {
        console.error("Failed to load plans:", err);
        setError(
          err instanceof Error
            ? err.message
            : "Could not load plans. Please try again."
        );
      })
      .finally(() => {
        setLoadingPlans(false);
      });
  }, [userId, isPro]);

  if (loadingUser || !appUser || appUser.is_pro) {
    return null; // Don't show anything if loading, not logged in, or already paid
  }

  async function handleSubscribe(plan: SubscriptionPlan) {
    if (!appUser?.id || busyPlan || plan.id === "free") return;

    try {
      setBusyPlan(plan.id);
      setError("");

      const razorpayKeyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;

      if (!razorpayKeyId) {
        setError("Razorpay key is not configured on the frontend.");
        setBusyPlan(null);
        return;
      }

      await loadRazorpayCheckout();

      if (!window.Razorpay) {
        setError("Razorpay checkout could not be loaded.");
        setBusyPlan(null);
        return;
      }

      const order = await createSubscriptionOrder(
        { plan_id: plan.id },
        appUser.id
      );

      const razorpay = new window.Razorpay({
        key: razorpayKeyId,
        amount: order.amount,
        currency: order.currency,
        name: "BunkMax",
        description: plan.name,
        order_id: order.order_id,
        prefill: {
          name: appUser.name || "Student",
          email: appUser.email || "",
        },
        theme: {
          color: "#1d9bf0",
        },
        modal: {
          ondismiss: () => {
            setBusyPlan(null);
            setError("Payment was cancelled.");
          },
        },
        handler: async (response) => {
          try {
            await verifySubscriptionPayment(
              {
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_order_id: response.razorpay_order_id,
                razorpay_signature: response.razorpay_signature,
              },
              appUser.id
            );

            localStorage.removeItem("bunkmax_user");
            window.location.reload();
          } catch (e) {
            setError(
              e instanceof Error ? e.message : "Payment verification failed."
            );
            setBusyPlan(null);
          }
        },
      });

      razorpay.on("payment.failed", (response) => {
        const message =
          response.error?.description ||
          response.error?.reason ||
          "Payment failed. Please try again.";
        setError(message);
        setBusyPlan(null);
      });

      razorpay.open();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start checkout.");
      setBusyPlan(null);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-black p-4 overflow-y-auto">
      <div className="w-full max-w-md bg-[#101312] border border-white/10 rounded-3xl p-6 shadow-2xl my-8">
        <div className="flex justify-center mb-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#ffd400]/10 text-[#ffd400]">
            <Lock size={32} />
          </div>
        </div>
        
        <h2 className="text-2xl font-bold text-center text-white mb-2">Unlock BunkMax</h2>
        <p className="text-gray-400 text-center mb-8 text-sm leading-relaxed">
          Choose a plan to continue. BunkMax unlocks automatically after
          Razorpay confirms your payment.
        </p>

        {error && (
          <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200 text-center">
            {error}
          </div>
        )}

        {loadingPlans ? (
          <div className="flex justify-center items-center py-8">
            <Loader2 className="w-8 h-8 animate-spin text-[#ffd400]" />
          </div>
        ) : (
          <div className="space-y-4">
            {plans.map((plan) => (
              <div 
                key={plan.id}
                className={`relative rounded-2xl border p-5 ${
                  plan.highlighted 
                    ? "border-[#ffd400]/40 bg-[#ffd400]/5" 
                    : "border-white/10 bg-white/5"
                }`}
              >
                {plan.highlighted && (
                  <div className="absolute -top-3 right-4 rounded-full bg-[#ffd400] px-3 py-1 text-[10px] font-bold uppercase text-black">
                    Popular
                  </div>
                )}
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <h3 className="text-lg font-bold text-white">{plan.name}</h3>
                    <p className="text-xs text-gray-400 mt-1">{plan.description}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xl font-bold text-white">
                      Rs {plan.price_rupees}
                    </p>
                    <p className="text-[10px] text-gray-400 uppercase tracking-wider">per {plan.billing_interval}</p>
                  </div>
                </div>

                <ul className="mt-4 space-y-2 mb-6">
                  {plan.features.slice(0, 3).map((feature, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-gray-300">
                      <Check size={14} className="text-[#ffd400] shrink-0 mt-0.5" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                <button
                  onClick={() => handleSubscribe(plan)}
                  disabled={busyPlan !== null}
                  className={`w-full rounded-full py-3 font-bold text-sm transition-all flex items-center justify-center gap-2
                    ${plan.highlighted 
                      ? "bg-[#ffd400] text-black hover:bg-[#ffdf33]" 
                      : "bg-white/10 text-white hover:bg-white/20"}
                    disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {busyPlan === plan.id ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  {busyPlan === plan.id ? "Processing..." : "Subscribe Now"}
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-6 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="flex items-center justify-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-3 text-xs font-semibold text-gray-300 hover:bg-white/10 hover:text-white transition"
          >
            <RefreshCw size={14} aria-hidden="true" />
            Check status
          </button>

          <button 
            type="button"
            onClick={() => {
              localStorage.removeItem("bunkmax_user");
              signOut({ callbackUrl: "/login" });
            }}
            className="rounded-full border border-white/10 bg-white/5 px-4 py-3 text-xs font-semibold text-gray-300 hover:bg-white/10 hover:text-white transition"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
