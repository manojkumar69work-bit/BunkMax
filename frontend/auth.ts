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

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      authorization: {
        params: {
          hd: "mlrit.ac.in",
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

      return email.length > 0 &&
        emailVerified === true &&
        email.endsWith("@mlrit.ac.in") &&
        (!hostedDomain || hostedDomain === "mlrit.ac.in");
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
