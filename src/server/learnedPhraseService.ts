import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { FINANCE_TERMS } from '@/domain/evasionNormalize';
import { phoneticCollisions, PHONETIC_SAFE_TERMS, type PhoneticCollision } from '@/domain/phoneticEvasion';
import { getKnownInstrumentNames } from './instrumentNames';
import { notifyOperators } from './opsAlert';
import { applyRules, PHONETIC_PHRASE_CAP, type RiskCategory } from '@/domain/compliance';
import {
  needsReview,
  normalizePhrase,
  phrasePrecision,
  validatePhrase,
  type LearnedPhrase,
  type PhraseStat,
} from '@/domain/learnedPhrases';

// 학습 표현 사전의 저장·조회.
// 등록은 운영자가 반려·철회를 내리는 순간에만 일어난다 — 근거 없는 금지어가 쌓이지 않게
// "실제로 반려한 건"에 붙여서만 만든다.

export class LearnedPhraseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LearnedPhraseError';
  }
}

type PhraseRow = {
  id: string;
  phrase: string;
  normalized: string;
  category: string;
  note: string | null;
  phoneticEligible: boolean;
};

const toDomain = (r: PhraseRow): LearnedPhrase => ({
  id: r.id,
  phrase: r.phrase,
  normalized: r.normalized,
  category: r.category as RiskCategory,
  note: r.note,
  phoneticEligible: r.phoneticEligible,
});

/**
 * 5층 상한 밀어내기 순서 (21차 Y-2 검토 확정) — **이 정렬이 계약이다.**
 * 음성 변형 층 상한(PHONETIC_PHRASE_CAP)이 앞에서부터 자르므로, 뒤에 서는 항목부터
 * 5층 자격을 잃는다.
 *
 * 최신순(20차 초안)은 버렸다 — 가장 위협적인 옛 패턴이 날아간다. 정확도순도 버렸다 —
 * 방금 등록해 실적 0인 유효한 항목(0/0)과 오래 안 쓰인 무효한 항목(0/0)이 같은 값이
 * 된다(21차 gap 17형 함정). 채택: **면제 항목이 맨 앞 → 걸린 적 있는 항목 → 무실적은
 * 최신이 앞** — 밀려나는 것은 "면제 아닌 것 중 한 번도 안 걸린 최고령 항목"이다.
 *
 * 면제(capExempt)는 22차 Y-2 — matchCount 0 은 "무효"와 "계절성(1년에 한 번 필요)"에서
 * 같은 값이라(gap 17형), 희소하지만 치명적인 방어선이 조용히 지워질 수 있다.
 */
export function phoneticCapOrder<
  T extends { matchCount: number; createdAt: Date; capExempt?: boolean },
>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      (b.capExempt ? 1 : 0) - (a.capExempt ? 1 : 0) ||
      (b.matchCount > 0 ? 1 : 0) - (a.matchCount > 0 ? 1 : 0) ||
      b.createdAt.getTime() - a.createdAt.getTime(),
  );
}

/**
 * @근거 설계 — 22차 Y-2 검토 확정값: 면제는 상한 200 의 10%(20개)까지.
 * 전부 면제면 상한이 없는 것과 같고, 상한이 없으면 검수 지연이 사전 크기에 비례한다.
 */
export const CAP_EXEMPT_LIMIT = 20;

/** 밀어내기 면제 지정 — 계절성·희소 패턴 보호. 상한 초과는 거절한다 */
export async function setPhraseCapExempt(
  prisma: PrismaClient,
  id: string,
  exempt: boolean,
): Promise<void> {
  if (exempt) {
    const current = await prisma.learnedPhrase.count({
      where: { active: true, capExempt: true, id: { not: id } },
    });
    if (current >= CAP_EXEMPT_LIMIT) {
      throw new LearnedPhraseError(
        `면제는 ${CAP_EXEMPT_LIMIT}개까지입니다 — 전부 면제면 상한이 없는 것과 같습니다. ` +
          '기존 면제 항목 중 하나를 풀고 다시 지정해 주세요.',
      );
    }
  }
  await prisma.learnedPhrase.update({ where: { id }, data: { capExempt: exempt } });
}

/** 검수·작성 화면이 함께 쓰는 활성 표현 목록 — phoneticCapOrder 정렬로 돌려준다 */
export async function getActiveLearnedPhrases(prisma: PrismaClient): Promise<LearnedPhrase[]> {
  const rows = await prisma.learnedPhrase.findMany({
    where: { active: true },
    select: {
      id: true,
      phrase: true,
      normalized: true,
      category: true,
      note: true,
      phoneticEligible: true,
      matchCount: true,
      createdAt: true,
      capExempt: true,
    },
  });
  return phoneticCapOrder(rows).map(toDomain);
}

export interface CreatePhraseInput {
  phrase: string;
  category: RiskCategory;
  note?: string | null;
  createdBy: string;
  sourceReportId?: string | null;
}

/**
 * 등록 시 5층(음성 변형) 참여 자격을 잰다 (20차 X-1).
 *
 * 대조 상대 셋 — 검토가 지목한 대로 종목·용어만으로는 부족하다:
 *   ① 종목 마스터 (DB — 호출부가 넘긴다)
 *   ② 금융 용어 사전 (FINANCE_TERMS)
 *   ③ 정상 문장 대조군 (training/holdout/control-hand.jsonl 54문장) — 낱말 목록에 없는
 *     표기(합성어·활용형)가 여기서 걸린다.
 *
 * ⚠ **채점지(손코퍼스 86)의 정상 문항은 쓰지 않는다** (21차 Y-4 판정: 버려라).
 * 처음에는 "방어적 사용이라 17차 금기에 안 걸린다"고 봤는데 반박됐다 — 채점지의
 * 정상 34문장과 충돌하지 않게만 사전을 꾸리면 **내부 시험의 오탐률이 인위적으로
 * 0에 붙는다.** 시험 결과와 실운영 결과가 다른 곳을 가리키게 되는 과적합이다.
 * 대조군 54는 채점지가 아니라 이 자리에 써도 오탐률 측정을 오염시키지 않는다.
 * DART 3,000문장이 확보되면 그쪽으로 교체한다.
 */
export async function measurePhoneticEligibility(
  word: string,
  knownNames: Iterable<string>,
): Promise<{ eligible: boolean; collisions: PhoneticCollision[] }> {
  const collisions = phoneticCollisions(
    word,
    [...knownNames, ...FINANCE_TERMS, ...PHONETIC_SAFE_TERMS],
    controlSentences(),
  );
  return { eligible: collisions.length === 0, collisions };
}

let controlCache: string[] | null = null;

/** 대조군 54 — 파일이 없으면 던진다. 호출부의 catch 가 "자격 없음"으로 접는다 (λ=4:
 *  대조 표본 없이 근사 감시를 켜는 쪽이 더 비싸다) */
function controlSentences(): string[] {
  if (controlCache) return controlCache;
  const raw = readFileSync(join(process.cwd(), 'training', 'holdout', 'control-hand.jsonl'), 'utf-8');
  controlCache = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { text: string }).text);
  return controlCache;
}

export async function createLearnedPhrase(prisma: PrismaClient, input: CreatePhraseInput) {
  const phrase = input.phrase.trim();
  const issues = validatePhrase(phrase);
  if (issues.length > 0) throw new LearnedPhraseError(issues.join(' / '));

  const normalized = normalizePhrase(phrase);

  // 21차에 여기 있던 "대조군 54 기반 간섭 관문"은 22차 Y-6 판정(버려라)으로 걷어냈다 —
  // 54건 통과가 안전을 보증하는 게 아니라 "표본이 작아 우연히 안 걸린 것"과 같은 값을
  // 낸다(gap 17형). 그 자리는 형태 제약(2어절 하한, validatePhrase)이 대신한다:
  // 종결어미("있습니다")가 뚫던 구멍을 표본 없이 닫고, 비용도 0이다.

  // 같은 표현을 두 번 등록하면 리서처에게 같은 경고가 두 번 뜬다
  const existing = await prisma.learnedPhrase.findFirst({
    where: { normalized, category: input.category },
  });
  if (existing) {
    // 비활성 상태였다면 되살린다 (같은 위반이 다시 확인된 것이므로)
    if (!existing.active) {
      return prisma.learnedPhrase.update({ where: { id: existing.id }, data: { active: true } });
    }
    return existing;
  }

  // 5층 자격 — 충돌하면 그 항목은 1~3층만 탄다. **등록 자체는 막지 않는다**:
  // 정확 매칭은 여전히 안전하고, 막으면 운영자가 경고를 우회할 다른 표기를 찾는다.
  // 조회 실패는 자격 없음으로 — 근거 없이 근사 매칭을 켜는 쪽이 더 비싸다 (λ=4)
  const eligibility = await measurePhoneticEligibility(
    normalized,
    await getKnownInstrumentNames(prisma).catch(() => new Set<string>()),
  ).catch(() => ({ eligible: false, collisions: [] as PhoneticCollision[] }));

  const created = await prisma.learnedPhrase.create({
    data: {
      phrase,
      normalized,
      category: input.category,
      note: input.note?.trim() || null,
      createdBy: input.createdBy,
      sourceReportId: input.sourceReportId ?? null,
      phoneticEligible: eligibility.eligible,
    },
  });
  // 상한 초과 경보 (21차 Y-2) — 밀어내기는 절대 조용히 일어나면 안 된다.
  // 201번째 등록이 어느 항목의 5층 자격을 뺏는지, 그 순간에 이름을 불러 알린다.
  // 알림 실패가 등록을 막으면 안 된다 (경보가 기능을 죽일 자격은 없다)
  await notifyPhoneticCapOverflow(prisma).catch((e) =>
    console.error('5층 상한 경보 실패:', e),
  );

  // 충돌 목록은 저장하지 않고 돌려준다 — 화면이 "왜 근사 감시에서 빠졌는지"를
  // 등록 직후 한 번 보여주면 되는 정보라, 표에 쌓으면 낡은 채 남는다
  return Object.assign(created, { collisions: eligibility.collisions });
}

/** 상한을 넘어 5층 자격을 잃은 항목을 찾아 운영자에게 알린다 (21차 Y-2) */
export async function notifyPhoneticCapOverflow(prisma: PrismaClient): Promise<void> {
  const eligible = await prisma.learnedPhrase.findMany({
    where: { active: true, phoneticEligible: true },
    select: { id: true, phrase: true, matchCount: true, createdAt: true, capExempt: true },
  });
  if (eligible.length <= PHONETIC_PHRASE_CAP) return;
  const evicted = phoneticCapOrder(eligible).slice(PHONETIC_PHRASE_CAP);
  await notifyOperators(prisma, {
    title: `[검수] 사전 5층 상한 초과 — ${evicted.length}개 항목이 정확 표기 감시로 강등`,
    body:
      `음성 변형 감시 상한(${PHONETIC_PHRASE_CAP}개)을 넘어 다음 항목이 근사 감시에서 빠집니다: ` +
      `${evicted.map((e) => `"${e.phrase}"`).join(', ')}. ` +
      '전부 등록 후 한 번도 걸리지 않은 항목 중 가장 오래된 것들입니다 — 안 쓰는 항목을 ' +
      '비활성화하거나 졸업시켜 자리를 비우십시오.',
    link: '/admin/compliance?tab=phrases',
    type: 'COMPLIANCE_REVIEW',
    dedupeKey: 'phrase.phonetic_cap',
  });
}

export async function setLearnedPhraseActive(
  prisma: PrismaClient,
  id: string,
  active: boolean,
) {
  await prisma.learnedPhrase.update({ where: { id }, data: { active } });
}

/** 운영자 관리 화면용 — 정확도가 낮은 표현이 위로 오게 정렬한다 */
export async function getLearnedPhraseStats(prisma: PrismaClient) {
  const rows = await prisma.learnedPhrase.findMany({
    orderBy: { createdAt: 'desc' },
  });
  const stats = rows.map((r) => {
    const stat: PhraseStat = {
      id: r.id,
      phrase: r.phrase,
      category: r.category as RiskCategory,
      matchCount: r.matchCount,
      confirmedCount: r.confirmedCount,
      active: r.active,
    };
    return {
      ...stat,
      note: r.note,
      createdAt: r.createdAt,
      lastMatchedAt: r.lastMatchedAt,
      precision: phrasePrecision(stat),
      needsReview: needsReview(stat),
      // **어느 층까지 지나는가** (3회차 C-2 → 회신 3호 (가) 채택). 화면이 자격 있는
      // 항목에도 감시 범위를 적어야 한다 — 자격 없을 때만 적으면 나머지는 "전부 감시"로
      // 읽히는데, 4·6층은 글 전체의 성질을 보는 층이라 사전이 관여할 자리가 없다
      phoneticEligible: r.phoneticEligible,
      capExempt: r.capExempt,
      // 격리 진입점의 근거 (4회차 §4-b) — 격리는 7일짜리 관찰 큐가 아니라 사전 탭의
      // "졸업한 항목" 자리에 사는 게 맞고(회귀 문항은 영구라 수명이 맞아야 한다),
      // 그 자리를 그리려면 화면이 졸업 여부·시각을 알아야 한다
      graduatedAt: r.graduatedAt,
    };
  });
  // 재검토 대상 → 활성 → 최신 순
  return stats.sort(
    (a, b) => Number(b.needsReview) - Number(a.needsReview) || Number(b.active) - Number(a.active),
  );
}
