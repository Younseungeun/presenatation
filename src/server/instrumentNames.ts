import type { PrismaClient } from '@prisma/client';

// **문자 혼용 회피 탐지가 대조할 "아는 이름" 집합** (13차 P-1).
//
// `삼성SDI`는 정상이고 `카ka5톡`은 회피인데, 둘의 차이는 오직 **상장 종목 목록에 있느냐**다.
// 그 목록이 없으면 이 신호는 대조군 8건 중 5건을 오탐한다(실측) — 그래서 규칙은 집합을
// 못 받으면 아무 소견도 내지 않는다.
//
// ── 왜 캐시하는가 ──────────────────────────────────────────────────
// 종목 마스터는 16,553행이고 검수는 리서처가 글을 쓰는 동안 디바운스로 계속 돈다.
// 매번 읽으면 타자 한 번에 16,553행이다. 마스터는 하루 한 번(06:00) 동기화되므로
// 10분 캐시는 신선도를 잃지 않는다.

const TTL_MS = 10 * 60_000;

let cache: { at: number; names: ReadonlySet<string> } | null = null;
let warned = false;

/**
 * 상장 종목명·티커를 소문자로 모은 집합.
 *
 * **실패하면 빈 집합을 돌려준다** — 검수를 세우지 않는다. 다만 그 결과가
 * "회피 탐지가 조용히 꺼진 상태"이므로 **한 번은 반드시 로그를 남긴다.**
 * 조용한 무동작이 이 층에서 가장 위험한 실패다 (실제로 배선을 빠뜨린 채
 * 92%를 측정한 적이 있다 — 그 92%는 탐침에서만 나오는 숫자였다).
 */
export async function getKnownInstrumentNames(
  prisma: PrismaClient,
  now = Date.now(),
): Promise<ReadonlySet<string>> {
  if (cache && now - cache.at < TTL_MS) return cache.names;
  try {
    const rows = await prisma.instrument.findMany({ select: { name: true, ticker: true } });
    const names = new Set<string>();
    for (const r of rows) {
      if (r.name) names.add(r.name.toLowerCase());
      if (r.ticker) names.add(r.ticker.toLowerCase());
    }
    cache = { at: now, names };
    warned = false;
    return names;
  } catch (e) {
    if (!warned) {
      warned = true;
      console.error(
        '종목 마스터를 읽지 못해 **표기 회피 탐지가 꺼진 채로 검수합니다**:',
        e,
      );
    }
    // 낡았더라도 있던 집합이 빈 집합보다 낫다 — 신호가 통째로 죽는 것을 막는다
    return cache?.names ?? new Set();
  }
}

/** 시험용 — 캐시를 비운다 */
export function resetKnownInstrumentNames(): void {
  cache = null;
  warned = false;
}
