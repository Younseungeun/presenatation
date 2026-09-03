import type { PrismaClient } from '@prisma/client';
import type { RegisteredPhrase, RiskCategory, ScreeningInput } from '@/domain/compliance';
import { rescanForPhrase, type RescanHit, type RescanTarget } from '@/domain/phraseRescan';
import { getKnownInstrumentNames } from './instrumentNames';

// **새 표현으로 게시 중 리포트를 다시 훑는다** (2026-08-25 창업자 확정).
//
// 두 번 쓰인다:
//   ① 등록 **전** — 미리보기. "이 표현을 켜면 게시물 N건이 걸립니다"
//   ② 등록 **직후** — 그 목록을 사진으로 박아 둔다 (PhraseRescanHit)
//
// ①이 이 기능의 값어치 절반이다. 20건이 걸리면 그 표현은 너무 넓은 것이고, 지금은
// 그 사실을 등록하고 한참 뒤 집계로만 알 수 있다. 여기서는 누르기 전에 답한다.

/**
 * 재검수 대상 — **지금 손댈 수 있는 것만.**
 *
 * · 게시 중(PUBLISHED) 이어야 한다. 초안·보류는 아직 안 팔렸고 게시 관문이 다시 본다
 * · **판정이 끝난 건은 뺀다** (창업자 지시). 정산이 끝나 리서처에게 돈이 나갔고,
 *   되돌리려면 남의 계좌에서 회수해야 하는데 그럴 수단이 없다. 목록에 올려 봐야
 *   운영자가 할 수 있는 일이 없고, 할 수 없는 일이 목록에 있으면 목록이 무거워진다
 */
async function loadTargets(prisma: PrismaClient): Promise<RescanTarget[]> {
  const rows = await prisma.report.findMany({
    where: {
      status: 'PUBLISHED',
      // 판정이 끝나면 카드에 judgment 가 붙는다 — 그 건은 되돌릴 수 없다
      predictionCard: { judgment: null },
    },
    select: {
      id: true,
      title: true,
      summary: true,
      content: true,
      predictionCard: { select: { assetClass: true, assetName: true, direction: true } },
    },
  });
  return rows.map((r) => ({
    reportId: r.id,
    input: {
      title: r.title,
      summary: r.summary ?? '',
      content: r.content ?? '',
      assetClass: (r.predictionCard?.assetClass ?? 'KR_EQUITY') as ScreeningInput['assetClass'],
      assetName: r.predictionCard?.assetName ?? '',
      direction: (r.predictionCard?.direction ?? 'UP') as ScreeningInput['direction'],
    },
  }));
}

export interface RescanPreview {
  /** 훑은 게시물 수 — 분모가 없으면 "3건"이 많은지 적은지 알 수 없다 */
  scanned: number;
  hits: (RescanHit & { title: string })[];
}

/**
 * **등록을 누르기 전에 답한다.** 아무것도 저장하지 않는다.
 *
 * 규칙 재검수는 실측 건당 5ms 라(게시물 1,000건에 약 5초) 등록 버튼 앞에 두어도 된다.
 * ARGOS 는 사이드카 호출이라 건당 0.4~1초로 훨씬 비싸지만, 학습 표현은 **규칙 엔진의
 * 입력**이므로 여기서 ARGOS 를 부를 이유가 없다.
 */
export async function previewPhraseRescan(
  prisma: PrismaClient,
  phrase: RegisteredPhrase,
): Promise<RescanPreview> {
  const [targets, known] = await Promise.all([
    loadTargets(prisma),
    getKnownInstrumentNames(prisma).catch(() => new Set<string>()),
  ]);
  const hits = rescanForPhrase(targets, phrase, known);
  const titles = new Map(
    (
      await prisma.report.findMany({
        where: { id: { in: hits.map((h) => h.reportId) } },
        select: { id: true, title: true },
      })
    ).map((r) => [r.id, r.title]),
  );
  return {
    scanned: targets.length,
    hits: hits.map((h) => ({ ...h, title: titles.get(h.reportId) ?? '(제목 없음)' })),
  };
}

/**
 * 등록 직후 목록을 **사진으로 박는다.**
 *
 * 실패해도 던지지 않는다 — 표현 등록은 이미 끝난 일이고, 재검수 목록이 없다고
 * 그것을 되돌리면 운영자가 한 판단이 사라진다. 곁가지가 본업을 죽이지 않는다.
 */
export async function recordPhraseRescan(
  prisma: PrismaClient,
  phraseId: string,
  hits: readonly RescanHit[],
): Promise<number> {
  if (hits.length === 0) return 0;
  try {
    /* **이미 있는 줄은 건너뛴다** — 표현을 비활성화했다 되살리면 같은 (표현, 리포트)
       짝이 다시 올라온다. SQLite 는 `createMany` 의 `skipDuplicates` 를 지원하지
       않으므로(Prisma 가 타입으로 막는다) 있는 것을 먼저 읽어 뺀다.
       경합은 신경 쓰지 않는다 — 표현 등록은 운영자 한 사람이 누르는 일이고,
       설령 겹쳐도 `@@unique` 가 마지막 방어선이다. */
    const existing = new Set(
      (
        await prisma.phraseRescanHit.findMany({
          where: { phraseId, reportId: { in: hits.map((h) => h.reportId) } },
          select: { reportId: true },
        })
      ).map((r) => r.reportId),
    );
    const fresh = hits.filter((h) => !existing.has(h.reportId));
    if (fresh.length === 0) return 0;
    const res = await prisma.phraseRescanHit.createMany({
      data: fresh.map((h) => ({
        phraseId,
        reportId: h.reportId,
        quote: h.quote,
        category: h.category,
      })),
    });
    return res.count;
  } catch (e) {
    console.error('재검수 목록 기록 실패:', e);
    return 0;
  }
}

export interface RescanQueueRow {
  id: string;
  reportId: string;
  reportTitle: string;
  researcherName: string;
  quote: string;
  category: RiskCategory;
  phrase: string;
  createdAt: Date;
  /** 이 리포트에 걸린 에스크로 건수 — 처분의 무게가 여기서 갈린다 */
  heldPurchases: number;
}

/** 아직 사람이 안 본 재검수 건. **처리하면 사라진다** — 그것이 사진의 뜻이다 */
export async function getRescanQueue(prisma: PrismaClient): Promise<RescanQueueRow[]> {
  const rows = await prisma.phraseRescanHit.findMany({
    where: { resolvedAt: null },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      reportId: true,
      quote: true,
      category: true,
      createdAt: true,
      phrase: { select: { phrase: true } },
      report: {
        select: {
          title: true,
          // 필명은 `User` 에 있다 — 프로필이 아니라(complianceService 와 같은 경로)
          researcher: { select: { user: { select: { penName: true, email: true } } } },
          purchases: { where: { escrowStatus: 'HELD' }, select: { id: true } },
        },
      },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    reportId: r.reportId,
    reportTitle: r.report?.title ?? '(삭제됨)',
    researcherName: r.report?.researcher?.user?.penName ?? r.report?.researcher?.user?.email ?? '—',
    quote: r.quote,
    category: r.category as RiskCategory,
    phrase: r.phrase?.phrase ?? '(삭제된 표현)',
    createdAt: r.createdAt,
    heldPurchases: r.report?.purchases.length ?? 0,
  }));
}

/**
 * 사람이 처리했다 — 목록에서 뺀다.
 *
 * `DISMISSED` 는 "봤고 그냥 둔다"이고 `WITHDRAWN` 은 강제 철회로 닫은 것이다.
 * **철회 자체는 여기서 하지 않는다** — 그건 기존 강제 철회 경로가 하고, 이 함수는
 * 목록에 줄을 그을 뿐이다. 처분과 기록을 한 함수에 합치면 목록을 지우려다 게시가
 * 내려가는 실수가 가능해진다.
 */
export async function resolveRescanHit(
  prisma: PrismaClient,
  id: string,
  resolution: 'DISMISSED' | 'WITHDRAWN',
  operatorId: string,
  now = new Date(),
): Promise<void> {
  await prisma.phraseRescanHit.update({
    where: { id },
    data: { resolvedAt: now, resolution, resolvedBy: operatorId },
  });
}
