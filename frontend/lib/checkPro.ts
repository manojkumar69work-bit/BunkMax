// lib/checkPro.ts

import { useRouter } from "next/navigation";

export function useProGuard(appUser: any) {
  const router = useRouter();

  function checkPro() {
    if (!appUser?.is_pro) {
      router.push("/upgrade");
      return false;
    }
    return true;
  }

  return checkPro;
}