"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  MARKET_SORTS,
  MARKET_SORT_LABEL,
  type MarketFilter,
  type MarketSort,
} from "@/server/marketQueries";
import styles from "../market.module.css";

/**
 * 정렬 선택 — "마감 임박순 ▾" 버튼을 누르면 하단 시트가 올라온다.
 * 선택지는 Link라서 정렬 자체는 URL(?sort=)로 남고 서버에서 정렬된 결과가 온다.
 * 시트만 클라이언트 상태다.
 *
 * 걸려 있는 필터를 그대로 들고 간다 — 정렬을 바꿨다고 필터가 조용히 풀리면
 * 목록이 갑자기 늘어난 이유를 사용자가 알 수 없다.
 */
export function SortPicker({
  asset,
  sort,
  filter,
}: {
  asset: string;
  sort: MarketSort;
  filter: MarketFilter;
}) {
  const [open, setOpen] = useState(false);

  function hrefFor(key: MarketSort): string {
    const q = new URLSearchParams({ asset, sort: key });
    if (filter.refundOnly) q.set("refund", "1");
    if (filter.maxPriceKrw) q.set("budget", String(filter.maxPriceKrw));
    if (filter.withinDays) q.set("within", String(filter.withinDays));
    return `/leaderboard?${q}`;
  }

  // 시트가 열려 있는 동안 뒤 배경이 스크롤되지 않게 잠근다
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={styles.sortButton}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {MARKET_SORT_LABEL[sort]}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M6 9l6 6 6-6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <>
          <button
            type="button"
            className={styles.sheetScrim}
            aria-label="닫기"
            onClick={() => setOpen(false)}
          />
          <div className={styles.sheet} role="dialog" aria-modal="true" aria-label="정렬 기준">
            <div className={styles.sheetHandle} aria-hidden="true" />
            <div className={styles.sheetTitle}>정렬 기준</div>
            {MARKET_SORTS.map((key) => (
              <Link
                key={key}
                href={hrefFor(key)}
                className={`${styles.sheetOption} ${key === sort ? styles.sheetOptionActive : ""}`}
                aria-current={key === sort ? "true" : undefined}
                onClick={() => setOpen(false)}
              >
                {MARKET_SORT_LABEL[key]}
                {key === sort && (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M5 12.5l4.5 4.5L19 7.5"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </Link>
            ))}
          </div>
        </>
      )}
    </>
  );
}
