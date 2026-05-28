// lib/checkPro.ts

import { useRouter } from "next/navigation";

export function useProGuard(appUser: { is_pro?: boolean } | null | undefined) {
  const router = useRouter();

  function checkPro() {
    if (!appUser?.is_pro) {
      router.refresh();
      return false;
    }
    return true;
  }

  return checkPro;
}
