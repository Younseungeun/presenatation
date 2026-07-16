"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

// 알림함 열람 = 전체 읽음. 마운트 시 한 번만 호출하고 앱바 뱃지를 갱신한다.
export function MarkAllRead() {
  const router = useRouter();
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    fetch("/api/notifications/read", { method: "POST" }).then((res) => {
      if (res.ok) router.refresh();
    });
  }, [router]);

  return null;
}
