import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

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
    async signIn({ profile }) {
      const email = profile?.email;
      const emailVerified = profile?.email_verified;
      const hostedDomain = (profile as { hd?: string } | undefined)?.hd;

      return !!email &&
        emailVerified === true &&
        email.endsWith("@mlrit.ac.in") &&
        hostedDomain === "mlrit.ac.in";
    },
    async jwt({ token, profile }) {
      if (profile?.email) token.email = profile.email;
      if (profile?.name) token.name = profile.name;
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).email = token.email;
        session.user.name = (token.name as string) || session.user.name;
      }
      return session;
    },
  },
  trustHost: true,
});