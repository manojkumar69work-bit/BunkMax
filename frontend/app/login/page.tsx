import { signIn, auth } from "@/auth";
import { redirect } from "next/navigation";

export default async function LoginPage() {
  const session = await auth();

  if (session?.user) {
    redirect("/");
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-white/5 p-6 shadow-[0_12px_40px_rgba(0,0,0,0.35)]">
        <h1 className="text-2xl font-bold tracking-tight">BunkMax</h1>
        <p className="text-sm text-gray-400 mt-2">
          Sign in with your MLRIT student account only
        </p>

        <form
          className="mt-6"
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            className="w-full rounded-2xl bg-white text-black py-3 font-semibold"
          >
            Continue with Google
          </button>
        </form>

        <p className="text-xs text-gray-500 mt-4">
          Only <span className="font-semibold">@mlrit.ac.in</span> accounts are allowed.
        </p>
      </div>
    </div>
  );
}