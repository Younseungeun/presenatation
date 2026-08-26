import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { RISK_CATEGORIES, type RiskCategory } from '@/domain/compliance';
import { normalizePhrase, validatePhrase } from '@/domain/learnedPhrases';
import { measurePhoneticEligibility } from '@/server/learnedPhraseService';
import { getKnownInstrumentNames } from '@/server/instrumentNames';
import { previewPhraseRescan } from '@/server/phraseRescanService';
import { requireOperatorId, toErrorResponse } from '../../../_lib/http';

/**
 * 사전 등록 미리보기 — **누르기 전에 알려 준다** (사전 관리 개편 1).
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────
 * 지금 사전 등록은 반려·철회에 **얹혀서** 일어난다. 표현이 규칙에 어긋나면
 * `registerPhrase` 가 사유 문자열을 돌려주는데, **반려 자체는 그대로 성공한다.**
 * 운영자 입장에서는 처리가 끝난 것처럼 보이고, 실패는 결과 알림에 한 줄 섞여
 * 지나간다 — 그리고 되먹임의 **빠른 길이 조용히 끊긴다**(TwoPaths 참조).
 *
 * 특히 안 보이는 규칙이 하나 있다: **두 어절 하한.** "있습니다" 같은 종결어미가
 * 등록되면 사전이 전면 차단기가 되기 때문에 막는데, 운영자 눈에는 그냥 평범한
 * 네 글자다. 기본값(suggestPhrase)은 이미 검사를 통과한 것만 고르므로 안전하지만,
 * **운영자가 손대는 순간부터는 아무도 안 본다.**
 *
 * ── 왜 서버에서 도는가 ──────────────────────────────────────────
 * ① 정규화기를 브라우저 번들에 실으면 회피 탐지의 처리 순서가 공개된다
 *    (작성 중 사전 검사가 서버에서 도는 것과 같은 이유)
 * ② 중복 검사는 어차피 사전이 필요하다
 *
 * ── 자격은 **여부만** 말한다 (확인서 Q1 → 회신 5호 (가) 확정) ──
 * 충돌 목록을 여기서 실으면 운영자가 표현을 조금씩 고쳐 가며 "자격 있음"이 뜰 때까지
 * 맞출 수 있게 된다. 그건 대조군 54문장을 상대로 표현을 최적화하는 일이고,
 * `measurePhoneticEligibility` 의 주석이 정확히 그것을 경계한다 —
 * *"정상 문장과 충돌하지 않게만 사전을 꾸리면 내부 시험의 오탐률이 인위적으로
 * 0에 붙는다."* 무엇과 부딪혔는지 모르면 겨냥해서 다듬을 수 없다.
 *
 * **`collisions` 는 숨기는 것이 아니라 아예 없다** (회신 5호 명시) — 숨긴 필드는
 * 언젠가 켜진다. 충돌 목록은 **등록 직후 한 번**(registerPhrase 반환) 보여준다.
 * 그때는 표현이 이미 확정된 뒤라 반복 다듬기 고리가 성립하지 않는다.
 *
 * ⚠ 남는 구멍(서버·앱 합의 아래 수용): 자격 여부 자체가 느린 오라클이라 끈질기게
 * 고치면 경계를 더듬을 수는 있다. 등록이 반려에 붙어 일어나는 정상 동선에서는 그럴
 * 이유가 없어 수용하고, 사전 등록 빈도가 이상해지면(하루 수십 건) 다시 본다.
 */

const bodySchema = z.object({
  phrase: z.string().max(600),
  /** 등록될 유형 — 없으면 서버가 등록 자체를 거절한다(그 사실을 미리 말해야 한다) */
  category: z.enum(RISK_CATEGORIES).optional(),
});

export interface PhrasePreview {
  /** 형태 검사 위반 — 하나라도 있으면 등록되지 않는다 */
  issues: string[];
  /** 유형을 안 골라 등록이 거절될 상태인가 */
  needsCategory: boolean;
  /** 정규화가 같은 기존 항목 (유형이 달라도 알린다 — 운영자가 알아야 할 사실이다) */
  matches: { id: string; phrase: string; category: RiskCategory; active: boolean }[];
  /**
   * 근사 표기(음성 변형)까지 감시받는가 — **여부만.** 무엇과 부딪혔는지는 싣지 않는다.
   * 형태가 이미 틀렸으면 재지 않으므로 null 이다 (등록될 리가 없다).
   */
  phoneticEligible: boolean | null;
  /**
   * **이 표현을 켜면 지금 팔리는 글 몇 건이 걸리는가** (창업자 지시 — 미리보기).
   *
   * ── 왜 건수가 여기 있어야 하나 ────────────────────────────────────
   * *"20건이 걸리면 그 표현은 너무 넓은 것이고, 누르기 전에 알아야 한다."*
   * 등록 후에도 같은 숫자가 나오지만 그때는 이미 사전에 올라간 뒤다. 되돌리려면
   * 끄는 절차를 따로 밟아야 하고, 그 사이 작성 화면은 그 표현으로 경고를 띄운다.
   *
   * ── `collisions` 와 다르다 — 숨길 이유가 없다 ──────────────────────
   * 충돌 목록을 입력 중에 안 보여주는 것은 그것이 **내부 대조 코퍼스**이기 때문이다
   * (피해서 다듬으면 오탐률 측정이 오염된다). 이 숫자가 세는 것은 **실제 게시물**이라
   * 그런 고리가 없다 — 오히려 보고 다듬는 것이 이 기능의 목적 그 자체다.
   * 나중에 "일관성" 을 이유로 이것까지 가리지 않도록 여기 적어 둔다.
   *
   * ── 건수만이다 ───────────────────────────────────────────────────
   * 제목·인용문은 **등록 직후 사진**(PhraseRescanHit)이 그린다. 타이핑 중에 목록까지
   * 그리면 화면이 흔들려 정작 고쳐야 할 표현에서 눈이 떠난다. 여기서 답할 질문은
   * "이 표현이 너무 넓은가" 하나다.
   *
   * 분모(`scanned`)를 함께 싣는다 — 3건이 많은지 적은지는 전체를 알아야 정해진다.
   * 재지 않은 경우(형태 위반·이미 켜져 있는 항목)는 null 이다.
   */
  rescan: { scanned: number; hits: number } | null;
}

export async function POST(req: NextRequest) {
  try {
    await requireOperatorId(prisma);
    const body = bodySchema.parse(await req.json());
    const phrase = body.phrase.trim();
    if (!phrase) {
      return NextResponse.json({
        issues: [],
        needsCategory: false,
        matches: [],
        phoneticEligible: null,
        rescan: null,
      } satisfies PhrasePreview);
    }

    const issues = validatePhrase(phrase);
    // 형태가 틀렸으면 나머지를 재지 않는다 — 어차피 등록이 안 되고,
    // 여러 줄을 함께 띄우면 운영자가 무엇부터 고쳐야 할지 흐려진다
    if (issues.length > 0) {
      return NextResponse.json({
        issues,
        needsCategory: !body.category,
        matches: [],
        phoneticEligible: null,
        rescan: null,
      } satisfies PhrasePreview);
    }

    const normalized = normalizePhrase(phrase);
    const [matches, eligibility] = await Promise.all([
      prisma.learnedPhrase.findMany({
        where: { normalized },
        select: { id: true, phrase: true, category: true, active: true },
      }),
      // 등록 경로와 **같은 함수·같은 폴백**을 쓴다 (조회 실패 → 자격 없음).
      // 미리보기가 다른 답을 내면 "화면은 된다는데 등록하면 안 되는" 자리가 생긴다
      measurePhoneticEligibility(
        normalized,
        await getKnownInstrumentNames(prisma).catch(() => new Set<string>()),
      ).catch(() => ({ eligible: false })),
    ]);

    /* **이 표현을 켜면 지금 팔리는 글 몇 건이 걸리나.**
       이미 켜져 있는 항목이면 재지 않는다 — 등록해도 사전이 그대로라 걸리는 글도
       그대로고, "N건이 새로 걸립니다" 가 거짓이 된다. 꺼 둔 항목은 등록이 곧
       **다시 켜는 것**이라 그 N건은 진짜로 새로 걸리므로 잰다.
       실패는 삼킨다(null) — 미리보기가 없다고 반려를 막을 이유가 없고, 등록 직후
       사진이 같은 계산을 다시 한다. */
    const active = matches.some((m) => m.active);
    const rescan = active
      ? null
      : await previewPhraseRescan(prisma, {
          // 아직 사전에 없으므로 id 가 없다. `rescanForPhrase` 는 자기가 넘긴 표현의
          // 소견만 골라내려고 `learned:<id>` 를 대조할 뿐이라, 이 호출 안에서만
          // 일관되면 된다 — 저장되지 않는 값이다
          id: 'preview',
          phrase,
          normalized,
          category: body.category ?? 'PROFIT_GUARANTEE',
          note: null,
          phoneticEligible: eligibility.eligible,
        })
          .then((r) => ({ scanned: r.scanned, hits: r.hits.length }))
          .catch(() => null);

    return NextResponse.json({
      issues,
      needsCategory: !body.category,
      matches: matches.map((m) => ({ ...m, category: m.category as RiskCategory })),
      // **`collisions` 는 여기서 꺼내지 않는다** — 위 주석 참조
      phoneticEligible: eligibility.eligible,
      rescan,
    } satisfies PhrasePreview);
  } catch (e) {
    return toErrorResponse(e);
  }
}
