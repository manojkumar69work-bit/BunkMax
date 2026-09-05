import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

declare module "next-auth" {
  interface Session {
    backendUserId?: number;
  }
}

const BACKEND_API_BASE =
  process.env.BACKEND_API_BASE ||
  "http://127.0.0.1:8000";
const BACKEND_API_SECRET = process.env.BACKEND_API_SECRET || "";

// Dev-only test accounts. Read ONLY outside a production build, so a stray
// DEV_ALLOWED_EMAILS in the Vercel dashboard cannot open the real app up —
// `next build` sets NODE_ENV=production and this collapses to an empty set.
const DEV_ALLOWED_EMAILS = new Set(
  process.env.NODE_ENV !== "production"
    ? (process.env.DEV_ALLOWED_EMAILS || "")
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    : []
);

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      authorization: {
        params: {
          // `hd` restricts Google's own account chooser to the college domain,
          // so a test account never even reaches our signIn callback. Drop it
          // only when a dev allowlist is configured; the callback below still
          // does the real check either way.
          ...(DEV_ALLOWED_EMAILS.size > 0 ? {} : { hd: "mlrit.ac.in" }),
          prompt: "select_account",
        },
      },
    }),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    authorized({ auth }) {
      return !!auth?.user;
    },

    async signIn({ profile }) {
      const email =
        typeof profile?.email === "string"
          ? profile.email.trim().toLowerCase()
          : "";
      const emailVerified = profile?.email_verified;
      const hostedDomain = (profile as { hd?: string } | undefined)?.hd;

      if (email.length === 0 || emailVerified !== true) return false;

      // A verified test account listed in DEV_ALLOWED_EMAILS skips the domain
      // rule but nothing else. In a production build the set is always empty.
      if (DEV_ALLOWED_EMAILS.has(email)) return true;

      return (
        email.endsWith("@mlrit.ac.in") &&
        (!hostedDomain || hostedDomain === "mlrit.ac.in")
      );
    },

    async jwt({ token, profile }) {
      if (profile?.email) token.email = profile.email;
      if (profile?.name) token.name = profile.name;
      if (profile?.email) {
        try {
          const res = await fetch(`${BACKEND_API_BASE}/auth/google-user`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-bunkmax-service-secret": BACKEND_API_SECRET,
            },
            body: JSON.stringify({
              email: profile.email.trim().toLowerCase(),
              name: profile.name || "Student",
            }),
          });
          if (res.ok) {
            const data = await res.json();
            if (typeof data.id === "number") (token as any).backendUserId = data.id;
          }
        } catch {}
      }
      return token;
    },

    async session({ session, token }) {
      if (session.user) {
        session.user.email =
          typeof token.email === "string" ? token.email : session.user.email;
        session.user.name = (token.name as string) || session.user.name;
        const raw = token as any;
        if (typeof raw.backendUserId === "number") session.backendUserId = raw.backendUserId;
      }
      return session;
    },
  },
  trustHost: true,
});
