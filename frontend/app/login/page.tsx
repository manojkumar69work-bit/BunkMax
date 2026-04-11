import { signIn, auth } from "@/auth";
import { redirect } from "next/navigation";

export default async function LoginPage() {
  const session = await auth();

  if (session?.user) {
    redirect("/");
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#070a10] px-4">
      <div className="w-full max-w-[380px] rounded-3xl border border-white/10 bg-white/5 p-8 backdrop-blur-xl shadow-[0_20px_60px_rgba(0,0,0,0.45)] space-y-6 text-center">
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
            className="w-full flex items-center justify-center gap-3 rounded-2xl bg-white text-black py-3 font-semibold hover:bg-gray-200 active:scale-[0.98] transition"
          >
            <img
              src="https://www.svgrepo.com/show/475656/google-color.svg"
              alt="Google"
              className="h-5 w-5"
            />
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