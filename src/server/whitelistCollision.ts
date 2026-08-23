import type { PrismaClient } from '@prisma/client';
import { applyRules, type RiskCategory } from '@/domain/compliance';
import { notifyOperators } from './opsAlert';

// **화이트리스트가 규칙을 끄는 것을 감시한다** (14차 R-4).
//
// ── 왜 필요한가 ────────────────────────────────────────────────────
// 표기 회피 탐지는 종목 마스터를 화이트리스트로 쓴다 — `삼성SDI`는 정상이고 `카ka5톡`은
// 회피인데, 둘의 차이가 **상장 종목 목록에 있느냐**뿐이기 때문이다. 즉 마스터의
// 16,553건은 그대로 **규칙을 끄는 열쇠**다(한글·라틴 혼용 표기만 2,727건).
//
// 마스터는 매일 06:00에 동기화된다. 금지어와 충돌하는 이름이 상장되는 날 규칙 하나가
// 조용히 꺼지는데, **그것을 보는 장치가 없었다.** 이 저장소가 다섯 번 만난 모양
// (조용한 무동작)이 여기 여섯 번째로 준비돼 있었다.
//
// ── 왜 제외하지 않고 알리기만 하는가 ────────────────────────────
// 충돌한 종목을 화이트리스트에서 자동으로 빼면 **그 종목을 분석하는 모든 성실한
// 리서처가 즉시 회피로 지적당한다.** λ=4 아래에서 그 오탐 비용이 미탐보다 4배 비싸다.
// 자동화는 **감시까지만** 하고 결단(예외 규칙 수동 추가·규칙 문구 수정)은 사람이 한다.

/**
 * @근거 설계 — **어절 완전 일치**만 본다. 부분 일치를 쓰면 `다원금속`이 `원금`을 품어
 *   매일 아침 거짓 경고가 쏟아지고, 그러면 운영자가 알림을 무시하게 된다(검토 답변이
 *   지목한 반증 조건). 규칙이 끄는 대상도 어절 단위라 검사 단위와 처분 단위가 맞는다.
 */
export interface WhitelistCollision {
  name: string;
  ticker: string;
  categories: RiskCategory[];
}

/**
 * 종목명 자체가 금지 규칙에 걸리는가.
 *
 * 검사 대상은 **이름 하나짜리 문장**이다 — 화이트리스트가 끄는 것이 그 토큰이므로,
 * 그 토큰만 놓고 규칙에 물어야 "이 이름이 규칙을 끄는가"에 답이 된다.
 * 문맥을 붙이면 문맥이 만든 소견이 섞인다.
 */
export function collidesWithRules(name: string): RiskCategory[] {
  const findings = applyRules(
    {
      title: '',
      summary: '',
      content: name,
      assetClass: 'KR_EQUITY',
      assetName: name,
      direction: 'UP',
      targetType: 'RETURN_PCT',
      magnitudePct: 12,
      horizonDays: 90,
      confidence: 5,
    },
    // **화이트리스트를 주지 않는다** — 이 이름이 화이트리스트에 들어가기 **전에**
    // 규칙에 걸리는지 묻는 것이다. 주면 자기 자신이 자기를 사면한다
    {},
  );
  return [
    ...new Set(
      findings
        // 표기 훼손 신호는 뺀다 — 이름 한 토막만 던지면 문맥이 없어 이 층이 흔들린다.
        // 여기서 묻는 것은 "이 이름이 **금지 표현**인가"이지 "훼손됐는가"가 아니다
        .filter((f) => f.category !== 'SCREENING_EVASION')
        .map((f) => f.category),
    ),
  ];
}

/**
 * 마스터 전체를 훑어 충돌을 찾고, 있으면 운영자에게 알린다.
 *
 * **아무것도 바꾸지 않는다.** 반환값과 알림뿐이다.
 */
export async function checkWhitelistCollisions(
  prisma: PrismaClient,
): Promise<WhitelistCollision[]> {
  const rows = await prisma.instrument.findMany({ select: { name: true, ticker: true } });
  const collisions: WhitelistCollision[] = [];
  for (const r of rows) {
    if (!r.name) continue;
    const categories = collidesWithRules(r.name);
    if (categories.length > 0) collisions.push({ name: r.name, ticker: r.ticker, categories });
  }

  if (collisions.length > 0) {
    await notifyOperators(prisma, {
      title: `[검수] 종목명이 금지 규칙과 충돌합니다 (${collisions.length}건) — 그 규칙이 이 종목에서 꺼집니다`,
      body:
        collisions
          .slice(0, 20)
          .map((c) => `· ${c.name} (${c.ticker}) → ${c.categories.join(', ')}`)
          .join('\n') +
        (collisions.length > 20 ? `\n… 외 ${collisions.length - 20}건` : '') +
        '\n\n이 종목은 화이트리스트에 그대로 둡니다(빼면 이 종목을 분석하는 성실한 ' +
        '리서처가 전부 막힙니다). 규칙 문구를 좁히거나 예외를 손으로 넣을지 판단해 주십시오.',
      link: '/admin/compliance',
      type: 'COMPLIANCE_REVIEW',
      // 목록이 바뀔 때만 다시 울린다 — 같은 충돌로 매일 울리면 배경음이 된다
      dedupeKey: `whitelist.collision.${collisions.map((c) => c.ticker).sort().join(',')}`,
    }).catch((e) => console.error('화이트리스트 충돌 알림 실패:', e));
  }
  return collisions;
}
