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
  },
  trustHost: true,
});