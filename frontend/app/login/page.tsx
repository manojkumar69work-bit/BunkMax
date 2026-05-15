import { signIn, auth } from "@/auth";
import { redirect } from "next/navigation";
import { GraduationCap } from "lucide-react";

export default async function LoginPage() {
  const session = await auth();

  if (session?.user) {
    redirect("/");
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[#1d9bf0]/30 bg-[#1d9bf0]/12 text-[#8ecdf8]">
          <GraduationCap size={28} aria-hidden="true" />
        </div>

        <div>
          <h1 className="text-3xl font-bold tracking-tight">BunkMax</h1>
          <p className="text-sm text-gray-400 mt-2">
            Sign in with your MLRIT student account
          </p>
        </div>

        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            className="primary-btn flex items-center justify-center gap-3"
          >
            <span
              aria-hidden="true"
              className="flex h-5 w-5 items-center justify-center rounded-full border border-black/10 bg-white text-sm font-bold text-[#4285f4]"
            >
              G
            </span>
            Continue with Google
          </button>
        </form>

        <p className="text-xs text-gray-500">
          Only <span className="font-semibold">@mlrit.ac.in</span> accounts allowed
        </p>
      </div>
    </div>
  );
}
