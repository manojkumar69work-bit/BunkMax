export { auth as middleware } from "@/auth";

export const config = {
  matcher: [
    "/",
    "/subjects/:path*",
    "/schedule/:path*",
    "/plan/:path*",
    "/profile/:path*",
    "/login",
  ],
};