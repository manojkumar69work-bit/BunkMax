export { auth as proxy } from "@/auth";

export const config = {
  matcher: [
    "/",
    "/chat/:path*",
    "/subjects/:path*",
    "/schedule/:path*",
    "/plan/:path*",
    "/profile/:path*",
    "/login",
  ],
};
