// lib/checkPro.ts

import { useRouter } from "next/navigation";

export function useProGuard(appUser: { is_pro?: boolean } | null | undefined) {
  const router = useRouter();

  function checkPro() {
    if (!appUser) {
      router.push("/login");
      return false;
    }

    if (!appUser.is_pro) {
      router.push("/");
      return false;
    }

    return true;
  }

  return checkPro;
}
