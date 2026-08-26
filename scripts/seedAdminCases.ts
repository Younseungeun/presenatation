import 'dotenv/config';
import { PrismaClient, type Prisma } from '@prisma/client';
import type { Finding } from '../src/domain/compliance';
import type { ApprovalAction } from '../src/domain/operatorApproval';
import { encryptField } from '../src/server/fieldCrypto';

// 관리자 화면의 **모든 상태를 한 번에 띄우는 시드** — npm run seed:admin
//
// 왜 필요한가: 디자인은 "무엇이 있을 때"가 아니라 **"무엇이 있을 수 있을 때"**를 정해야
// 하는데, 개발 DB에는 우연히 생긴 상태만 들어 있다. 실제로 관리자 화면 15개 중 절반이
// 빈 상자였고(본문 검수 보류 0 · 학습 표현 0 · 승인 요청 0 · 정산 계좌 0 · 보상 0),
// 그 화면들은 **한 번도 그려진 적이 없는 채로** 디자인이 끝날 뻔했다.
//
// ── 규칙 셋 ────────────────────────────────────────────────────
// ① **덧붙이기만 한다.** 지우지 않는다 — 옆에서 만들어 둔 시나리오를 밟으면 안 된다.
// ② **표식을 남긴다.** 여기서 만든 것은 전부 `[案]`으로 시작하거나 `seed:admin` 흔적을
//    남긴다. 나중에 "이건 진짜 데이터인가"를 되물을 일이 없어야 한다.
// ③ **여러 번 돌려도 안전하다.** 이미 있으면 건너뛴다(표식으로 센다).
//
// 대상 화면: /admin · /admin/compliance(본문·종목시세·판매중·학습표현) · /admin/settlements ·
//           /admin/frozen(보안) · /admin/approvals · /admin/inbox · /admin/health

const prisma = new PrismaClient();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MARK = '[案]';

const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms);
const ahead = (ms: number) => new Date(now.getTime() + ms);

let made = 0;
let skipped = 0;
function log(what: string, created: boolean) {
  if (created) made += 1;
  else skipped += 1;
  console.log(`  ${created ? '+' : '·'} ${what}`);
}

/** 시드 전용 리서처·이용자 — 진짜 계정에 상태를 얹지 않는다 */
async function ensureUser(tag: string, penName: string, researcher: boolean) {
  const email = `seed-admin-${tag}@case.local`;
  const found = await prisma.user.findUnique({
    where: { email },
    include: { researcherProfile: true },
  });
  if (found) return found;
  return prisma.user.create({
    data: {
      email,
      penName,
      identityVerified: true,
      ...(researcher ? { researcherProfile: { create: {} } } : {}),
    },
    include: { researcherProfile: true },
  });
}

/**
 * 리포트 한 장 + 예측 카드 — 서비스 함수를 타지 않고 직접 만든다.
 *
 * `publishReport`는 시세·σ·컷오프를 전부 검증하므로 "시한이 20일 지난 카드" 같은
 * **화면에서만 의미 있는 상태**를 만들 수 없다. 여기서 만드는 것은 판정에 쓰이는
 * 데이터가 아니라 **화면이 그려야 할 모양**이다.
 */
async function makeReport(opts: {
  key: string;
  researcherId: string;
  title: string;
  status: string;
  priceKrw?: number;
  deadline: Date;
  publishedAt?: Date | null;
  ticker?: string;
  assetName?: string;
  assetClass?: string;
  direction?: string;
  targetValue?: number;
  basePrice?: number | null;
  manualReason?: string | null;
  manualOnly?: boolean;
  rejectionCount?: number;
}) {
  const existing = await prisma.report.findFirst({
    where: { title: opts.title },
    include: { predictionCard: true },
  });
  if (existing) return existing;
  return prisma.report.create({
    data: {
      researcherId: opts.researcherId,
      title: opts.title,
      summary: `${MARK} 화면 확인용 요약입니다. 실제 분석이 아닙니다.`,
      content: `${MARK} 화면 확인용 본문입니다. 이 리포트는 관리자 화면의 상태를 그려 보기 위해 만들어졌습니다.`,
      priceKrw: opts.priceKrw ?? 12_000,
      prepaymentRatio: 0,
      feeRateBp: 2000,
      status: opts.status,
      publishedAt: opts.publishedAt ?? null,
      rejectionCount: opts.rejectionCount ?? 0,
      predictionCard: {
        create: {
          assetClass: opts.assetClass ?? 'KR_EQUITY',
          ticker: opts.ticker ?? '005930',
          assetName: opts.assetName ?? '삼성전자',
          direction: opts.direction ?? 'UP',
          targetType: 'RETURN_PCT',
          targetValue: opts.targetValue ?? 12,
          confidence: 6,
          selfStability: 1,
          deadline: opts.deadline,
          basePrice: opts.basePrice ?? 71_000,
          baseMode: 'FIXED_AT_PUBLISH',
          manualReason: opts.manualReason ?? null,
          manualJudgmentOnly: opts.manualOnly ?? false,
        },
      },
    },
    include: { predictionCard: true },
  });
}

function findings(list: Finding[]): string {
  return JSON.stringify(list);
}

async function main() {
  const operator = await prisma.user.findFirst({ where: { role: 'OPERATOR' } });
  if (!operator) throw new Error('운영자 계정이 없습니다 — npm run op:grant 를 먼저 실행하세요');

  const r1 = await ensureUser('res1', `${MARK}정량리서치랩`, true);
  const r2 = await ensureUser('res2', `${MARK}매크로노트`, true);
  const r3 = await ensureUser('res3', `${MARK}칩워처`, true);
  const buyer1 = await ensureUser('buy1', `${MARK}구매자하나`, false);
  const buyer2 = await ensureUser('buy2', `${MARK}구매자둘`, false);
  const buyer3 = await ensureUser('buy3', `${MARK}구매자셋`, false);

  // ── ① 본문 검수 보류 — 색이 갈리는 세 단계를 전부 만든다 ─────────────
  // 6시간 미만(조용) / 6시간 초과(주의) / 24시간 초과(지연). 하나만 있으면
  // "언제 붉어지는가"를 화면에서 확인할 수 없다.
  console.log('본문 검수 보류');
  for (const c of [
    {
      key: 'hold-fresh',
      title: `${MARK} 반도체 사이클 저점 통과 점검`,
      waited: 2 * HOUR,
      decision: 'WARN',
      f: [
        {
          category: 'UNSUPPORTED_CLAIM',
          severity: 'WARN',
          quote: '이번 분기 실적은 확실히 개선됩니다',
          reason: '근거 없는 단정입니다. 추정 범위와 가정을 함께 적어 주세요.',
          source: 'ai',
        },
      ] as Finding[],
    },
    {
      key: 'hold-warn',
      title: `${MARK} 2차전지 소재주 반등 시나리오`,
      waited: 9 * HOUR,
      decision: 'BLOCK',
      f: [
        {
          category: 'SOLICIT_CONTACT',
          severity: 'BLOCK',
          quote: '자세한 매매 타이밍은 따로 안내드립니다',
          reason: '개별 상담 유도로 읽힙니다 — 투자자문업 경계입니다.',
          source: 'ai',
        },
        {
          category: 'RISK_INDUCEMENT',
          severity: 'WARN',
          quote: '비중을 크게 실을 구간',
          reason: '위험 투자 조장으로 읽힐 수 있습니다.',
          source: 'rule',
        },
      ] as Finding[],
    },
    {
      key: 'hold-overdue',
      title: `${MARK} 방산 수출 모멘텀 재점검`,
      waited: 31 * HOUR,
      decision: 'UNAVAILABLE',
      f: [] as Finding[],
    },
    {
      // **지금 실제로 올라오는 모양** (2026-08-21) — `ANTHROPIC_API_KEY`가 없어
      // 2차가 통째로 건너뛰어진 건. `reviewer: 'rule'`이 그 사실을 말한다.
      // 검수 실패(UNAVAILABLE)와 다르다: 저쪽은 시도했다 실패했고 이쪽은 시도조차
      // 안 했다 — 운영자가 Claude에게 직접 물어봐야 하는 자리다
      key: 'hold-nokey',
      title: `${MARK} 원전 수주 모멘텀 점검 (2차 없음)`,
      waited: 5 * HOUR,
      decision: 'WARN',
      reviewer: 'rule',
      f: [
        {
          category: 'SOLICIT_CONTACT',
          severity: 'WARN',
          quote: '자세한 건 따로 연락 주세요',
          reason: '개별 연락 유도로 읽힐 수 있습니다 — 문맥 확인이 필요합니다.',
          source: 'rule',
        },
      ] as Finding[],
    },
  ]) {
    const before = await prisma.complianceReview.findFirst({
      where: { report: { title: c.title } },
    });
    const rep = await makeReport({
      key: c.key,
      researcherId: r1.researcherProfile!.id,
      title: c.title,
      status: 'PENDING_REVIEW',
      deadline: ahead(60 * DAY),
      publishedAt: null,
    });
    if (!before) {
      await prisma.complianceReview.create({
        data: {
          reportId: rep.id,
          decision: c.decision,
          // 시드가 지정한 검수 주체가 있으면 그것을 쓴다 — '2차가 돌았나'를
          // 화면이 그 값으로 판단하므로, 여기서 뭉뚱그리면 그 표시를 시험할 수 없다
          reviewer:
            ('reviewer' in c && c.reviewer) ||
            (c.decision === 'UNAVAILABLE' ? 'rule' : 'rule+claude:claude-opus-5'),
          findingsJson: findings(c.f),
          needsOperatorReview: true,
          createdAt: ago(c.waited),
          inputTokens: 900,
          outputTokens: 220,
          deliberationRatio: 220 / 900,
        },
      });
    }
    log(`${c.title} (${Math.round(c.waited / HOUR)}시간 대기, ${c.decision})`, !before);
  }

  // 반복 반려 3회 — 자동 통과 경로가 닫힌 건
  {
    const title = `${MARK} 조선 수주 사이클 재평가 (3회 반려)`;
    const before = await prisma.complianceReview.findFirst({ where: { report: { title } } });
    const rep = await makeReport({
      key: 'hold-repeat',
      researcherId: r2.researcherProfile!.id,
      title,
      status: 'PENDING_REVIEW',
      deadline: ahead(45 * DAY),
      rejectionCount: 3,
    });
    if (!before) {
      await prisma.complianceReview.create({
        data: {
          reportId: rep.id,
          decision: 'PASS',
          reviewer: 'rule+claude:claude-opus-5',
          findingsJson: findings([]),
          needsOperatorReview: true,
          createdAt: ago(4 * HOUR),
        },
      });
    }
    log(`${title}`, !before);
  }

  // ── ② 위험 종목 보류 — 소견이 RISKY_INSTRUMENT 뿐이어야 종목 탭으로 간다 ──
  console.log('위험 종목 보류');
  {
    const title = `${MARK} 관리종목 편입 이후 회생 가능성`;
    const before = await prisma.complianceReview.findFirst({ where: { report: { title } } });
    const rep = await makeReport({
      key: 'hold-inst',
      researcherId: r3.researcherProfile!.id,
      title,
      status: 'PENDING_REVIEW',
      deadline: ahead(90 * DAY),
      ticker: '900140',
      assetName: '엘브이엠씨홀딩스',
    });
    if (!before) {
      await prisma.complianceReview.create({
        data: {
          reportId: rep.id,
          decision: 'WARN',
          reviewer: 'rule',
          findingsJson: findings([
            {
              category: 'RISKY_INSTRUMENT',
              severity: 'WARN',
              quote: '엘브이엠씨홀딩스',
              reason: '거래소가 투자경고로 지정한 종목입니다.',
              source: 'rule',
            },
          ]),
          needsOperatorReview: true,
          createdAt: ago(14 * HOUR),
        },
      });
    }
    log(title, !before);
  }

  // ── ③ 검수 정확도 — 네 라벨이 모두 있어야 패널이 그려진다 ──────────────
  // 정탐·오탐·경미·미탐. 하나라도 비면 그 칸이 `-`로 남아 색과 배치를 못 정한다.
  console.log('검수 정확도 라벨');
  for (const c of [
    { key: 'lab-fp', verdict: 'APPROVED', valid: null, cat: null, label: '오탐(승인)' },
    { key: 'lab-minor', verdict: 'APPROVED', valid: true, cat: null, label: '경미(승인+지적 타당)' },
    {
      key: 'lab-tp',
      verdict: 'REJECTED',
      valid: true,
      cat: 'PROFIT_GUARANTEE',
      label: '정탐(반려)',
    },
    { key: 'lab-kept', verdict: 'KEPT', valid: null, cat: null, label: '유지' },
  ]) {
    const title = `${MARK} 라벨 표본 — ${c.label}`;
    const before = await prisma.complianceReview.findFirst({ where: { report: { title } } });
    const rep = await makeReport({
      key: c.key,
      researcherId: r1.researcherProfile!.id,
      title,
      status: 'DRAFT',
      deadline: ahead(30 * DAY),
    });
    if (!before) {
      await prisma.complianceReview.create({
        data: {
          reportId: rep.id,
          decision: 'WARN',
          reviewer: 'rule+claude:claude-opus-5',
          findingsJson: findings([
            {
              category: 'PROFIT_GUARANTEE',
              severity: 'WARN',
              quote: '수익이 날 수밖에 없는 구조',
              reason: '수익 보장으로 읽힙니다.',
              source: 'ai',
            },
          ]),
          needsOperatorReview: false,
          operatorReviewedAt: ago(2 * DAY),
          operatorReviewedBy: operator.id,
          operatorVerdict: c.verdict,
          operatorReason: `${MARK} 화면 확인용 라벨`,
          operatorCategories: c.cat ? JSON.stringify([c.cat]) : null,
          aiFindingsValid: c.valid,
          createdAt: ago(3 * DAY),
        },
      });
    }
    log(c.label, !before);
  }

  // ── ④ 운영자 사전 — 정상 / 재검토 권장 / 비활성 ──────────────────────
  //
  // **5층 자격과 면제도 한 항목씩 켜 둔다** (3회차 C-2). 셋 다 자격이 없으면 화면의
  // `· 음성 변형` 가지가 어느 데이터로도 안 그려져, 있는지 없는지를 눈으로 못 잰다 —
  // 카나리아 층 하드코딩과 같은 종류의 사각이다(코드에는 있는데 아무도 못 본다).
  console.log('운영자 사전');
  for (const p of [
    {
      phrase: '오픈채팅방에서 안내',
      normalized: '오픈채팅방에서안내',
      category: 'SOLICIT_CONTACT',
      matchCount: 12,
      confirmedCount: 11,
      active: true,
      note: '외부 채널 유도',
      phoneticEligible: true, // 정확도 92% — 근사 표기까지 감시하는 표본
    },
    {
      phrase: '수익이 날 수밖에',
      normalized: '수익이날수밖에',
      category: 'PROFIT_GUARANTEE',
      matchCount: 9,
      confirmedCount: 3, // 33% — 재검토 권장선(5회·50%) 아래
      active: true,
      note: '정확도가 낮아 재검토가 필요한 표현',
      capExempt: true, // 밀어내기 면제 표본
    },
    {
      phrase: '지금이 마지막 기회',
      normalized: '지금이마지막기회',
      category: 'RISK_INDUCEMENT',
      matchCount: 6,
      confirmedCount: 1,
      active: false,
      note: '오탐이 잦아 운영자가 꺼 둔 표현',
    },
  ]) {
    const before = await prisma.learnedPhrase.findFirst({ where: { phrase: p.phrase } });
    if (!before) {
      await prisma.learnedPhrase.create({
        data: { ...p, createdBy: operator.id, lastMatchedAt: ago(2 * DAY) },
      });
    }
    log(`${p.phrase} (${p.active ? '활성' : '비활성'} ${p.confirmedCount}/${p.matchCount})`, !before);
  }

  // ── ④-b 출처 3종이 한 카드에 모인 보류 (인계 2호 §4) ──────────────────
  // 화면이 `[규칙·코드]` / `[규칙·사전]` / `[학생]` 을 갈라 그리는지 **눈으로**
  // 확인할 표본이 없었다. 셋을 따로 흩어 두면 나란히 놓았을 때의 구별을 못 재므로
  // **한 카드에 모은다.** 사전 소견에는 실제 phraseId 를 물려 링크가 죽지 않게 한다
  // (앞의 사전 시딩이 끝난 뒤라야 id 를 알 수 있어 이 자리에 있다).
  {
    const linked = await prisma.learnedPhrase.findFirst({ where: { phrase: '수익이 날 수밖에' } });
    const title = `${MARK} 소부장 밸류체인 재평가 (출처 3종)`;
    const before = await prisma.complianceReview.findFirst({ where: { report: { title } } });
    const rep = await makeReport({
      key: 'hold-sources',
      researcherId: r2.researcherProfile!.id,
      title,
      status: 'PENDING_REVIEW',
      deadline: ahead(45 * DAY),
      publishedAt: null,
    });
    if (!before) {
      await prisma.complianceReview.create({
        data: {
          reportId: rep.id,
          decision: 'WARN',
          reviewer: 'rule+student:v3',
          findingsJson: findings([
            {
              category: 'RISK_INDUCEMENT',
              severity: 'WARN',
              quote: '비중을 크게 실을 구간입니다',
              reason: '위험 투자 조장으로 읽힐 수 있습니다.',
              source: 'rule',
              layer: 'L1_RAW',
              ruleId: 'RISK_INDUCEMENT',
            },
            {
              category: 'PROFIT_GUARANTEE',
              severity: 'WARN',
              quote: '수익이 날 수밖에 없는 구조',
              reason: '운영자가 등록한 표현입니다.',
              source: 'learned',
              layer: 'L2_SEPARATOR',
              ...(linked ? { phraseId: linked.id } : {}),
            },
            {
              // **음성 변형은 근사 매칭**이라 화면이 따로 표시해야 한다 (회신 Q5)
              category: 'SOLICIT_CONTACT',
              severity: 'WARN',
              quote: '텔레그렘 방으로 오세요',
              reason: '금지 표현과 자모 1자 차이입니다.',
              source: 'learned',
              layer: 'L5_PHONETIC',
              ...(linked ? { phraseId: linked.id } : {}),
            },
            {
              // 학생은 문서 전체를 보고 판정해 **문장을 못 짚는다** — quote 가 빈 값이다.
              // 화면이 이걸 `""` 로 그리면 고장으로 읽힌다
              category: 'UNSUPPORTED_CLAIM',
              severity: 'WARN',
              quote: '',
              reason: '근거 없는 단정으로 읽힙니다.',
              source: 'student',
              confidence: 0.73,
            },
          ] as Finding[]),
          needsOperatorReview: true,
          createdAt: ago(3 * HOUR),
        },
      });
    }
    log(title, !before);
  }

  // ── ⑤ 종목·시세 (수동 판정 큐) — 사유 3종 × 상한 전/후 ────────────────
  // `상한까지 D-N`과 `상한 초과`가 같은 화면에 있어야 붉은 줄의 뜻이 읽힌다.
  console.log('수동 판정 큐');
  for (const c of [
    { key: 'mq-cross', reason: 'CROSS_CHECK', stale: 2, label: '두 소스가 다른 값 (D-12)' },
    { key: 'mq-impl', reason: 'IMPLAUSIBLE_QUOTE', stale: 12, label: '이상값 필터 (D-2, 붉음)' },
    { key: 'mq-revert', reason: 'REVERTED_SOURCE', stale: 19, label: '되돌린 카드 (상한 초과)' },
  ]) {
    const title = `${MARK} 수동 판정 — ${c.label}`;
    const before = await prisma.report.findFirst({ where: { title } });
    const rep = await makeReport({
      key: c.key,
      researcherId: r2.researcherProfile!.id,
      title,
      status: 'PUBLISHED',
      publishedAt: ago((c.stale + 40) * DAY),
      deadline: ago(c.stale * DAY),
      manualReason: c.reason,
      manualOnly: true,
      ticker: 'KRW-BTC',
      assetName: '비트코인',
      assetClass: 'CRYPTO',
      basePrice: 96_000_000,
    });
    if (!before) {
      // 에스크로에 묶인 구매 — "구매 N건 에스크로"가 이 큐의 급함을 만든다
      await prisma.purchase.create({
        data: {
          reportId: rep.id,
          buyerId: buyer1.id,
          amountKrw: 12_000,
          escrowStatus: 'HELD',
          paymentMethod: 'CARD',
        },
      });
    }
    log(c.label, !before);
  }

  // ── ⑥ 신고 보상 안내 대기 ────────────────────────────────────────
  console.log('신고 보상 대기');
  {
    const target = await prisma.report.findFirst({
      where: { status: 'PUBLISHED', title: { not: { startsWith: MARK } } },
    });
    const before = await prisma.abuseReport.findFirst({
      where: { reporterId: buyer2.id, rewarded: true },
    });
    if (!before && target) {
      await prisma.abuseReport.create({
        data: {
          reporterId: buyer2.id,
          targetName: target.title,
          reportId: target.id,
          category: 'SOLICIT',
          detail: `${MARK} 보상 안내 대기 상태를 그리기 위한 신고입니다.`,
          status: 'CONFIRMED',
          rewarded: true,
          rewardNoticedAt: null,
          reviewedAt: ago(2 * DAY),
          reviewerId: operator.id,
          reviewNote: `${MARK} 확인 처리`,
        },
      });
    }
    log('보상 대상 · 안내 대기 1건', !before && !!target);
  }

  // ── ⑥-b 이용자 신고 — 처리 대기(PENDING) 샘플 ─────────────────────────
  // "이용자가 잡은 것"의 예시가 없어 신고 검토 화면이 비어 있었다 (2026-08-27 창업자 지시).
  // **모델이 놓친 위반**을 사람이 잡은 상황을 만든다: 게시 검수(RULE+IRIS)는 통과했는데
  // (검수 소견 0건) 본문에 개별 상담 유도가 **완곡하게** 들어 있어 규칙이 못 잡은 케이스.
  // 이 위에서 강제 철회를 누르면 교사 질문지(학습 표현 등록·IRIS 재학습)가 열린다.
  console.log('이용자 신고 대기');
  {
    const title = `${MARK} 조용한 성장주 리레이팅 (신고 대기)`;
    const before = await prisma.report.findFirst({ where: { title } });
    const rep =
      before ??
      (await prisma.report.create({
        data: {
          researcherId: r1.researcherProfile!.id,
          title,
          summary: `${MARK} 실적 개선 흐름을 근거로 중장기 상승을 봅니다.`,
          // **모델이 놓친 완곡한 1:1 상담 유도** — 채널명(카톡·텔레그램)도, 번호도 없어
          // 규칙이 못 잡는다. 사람은 "개별적으로 봐 준다"는 뜻을 읽고 신고한다
          content:
            `${MARK} 업황 회복과 수주 개선을 근거로 중장기 상승을 전망합니다. ` +
            `더 자세한 진입 시점이 궁금하신 분은 편하게 개별적으로 말씀 주세요 — 한 분 한 분 맞춰서 봐 드리겠습니다.`,
          priceKrw: 15_000,
          prepaymentRatio: 0,
          feeRateBp: 2000,
          status: 'PUBLISHED',
          publishedAt: ago(6 * DAY),
          predictionCard: {
            create: {
              assetClass: 'KR_EQUITY',
              ticker: '000660',
              assetName: 'SK하이닉스',
              direction: 'UP',
              targetType: 'RETURN_PCT',
              targetValue: 18,
              confidence: 6,
              selfStability: 1,
              deadline: ahead(60 * DAY),
              basePrice: 180_000,
              baseMode: 'FIXED_AT_PUBLISH',
            },
          },
        },
      }));
    // 게시 검수는 통과했다는 기록 — 소견 0건(모델이 못 잡았다). 강제 철회 질문지가
    // "RULE+IRIS 판정"으로 이 빈 소견을 싣고, 사람 판정과 대조한다
    const hadReview = await prisma.complianceReview.findFirst({ where: { reportId: rep.id } });
    if (!hadReview) {
      await prisma.complianceReview.create({
        data: {
          reportId: rep.id,
          reviewer: 'rule+student:IRIS.v5@t0.7/L7',
          decision: 'PASS',
          findingsJson: '[]',
          needsOperatorReview: false,
          operatorReviewedAt: ago(6 * DAY),
        },
      });
    }
    // 처리 대기 신고 — buyer1 이 개별 상담 유도로 신고
    const hadAbuse = await prisma.abuseReport.findFirst({
      where: { reporterId: buyer1.id, reportId: rep.id },
    });
    if (!hadAbuse) {
      await prisma.abuseReport.create({
        data: {
          reporterId: buyer1.id,
          reportId: rep.id,
          targetName: rep.title,
          category: 'ONE_ON_ONE',
          detail:
            '본문에서 "개별적으로 말씀 주세요, 한 분 한 분 맞춰 봐 드리겠습니다"라며 1:1 상담을 유도합니다. ' +
            '불특정 다수 대상 리포트가 아니라 개별 자문으로 넘어가는 것 같습니다.',
          status: 'PENDING',
        },
      });
    }
    log('처리 대기 신고 1건 (모델이 놓친 완곡한 상담 유도)', !before);
  }

  // ── ⑦ 돈 — 묶음 환불 / 보상 지시서 / 차단된 지급 ────────────────────
  console.log('돈');
  {
    // 같은 리포트를 셋이 사고 전부 환불 대기 → 묶음 환불 카드가 그려진다
    const title = `${MARK} 묶음 환불 표본 — 구매자 3명`;
    const before = await prisma.report.findFirst({ where: { title } });
    const rep = await makeReport({
      key: 'refund-group',
      researcherId: r3.researcherProfile!.id,
      title,
      status: 'CLOSED',
      publishedAt: ago(50 * DAY),
      deadline: ago(3 * DAY),
      priceKrw: 12_900,
    });
    if (!before) {
      for (const b of [buyer1, buyer2, buyer3]) {
        const p = await prisma.purchase.create({
          data: {
            reportId: rep.id,
            buyerId: b.id,
            amountKrw: 12_900,
            escrowStatus: 'REFUNDED',
            paymentMethod: 'CARD',
          },
        });
        await prisma.settlement.create({
          data: {
            purchaseId: p.id,
            outcome: 'UNDECIDABLE',
            researcherPayoutKrw: 0,
            platformFeeKrw: 0,
            buyerRefundKrw: 12_900,
            refundType: 'CASH',
            settledAt: ago(3 * DAY),
          },
        });
      }
    }
    log('묶음 환불 38,700원 → 구매자 3명', !before);
  }

  {
    // 플랫폼 귀책 보상 — 확정 대기 / 확정됨(실행 대기) 둘 다
    const title = `${MARK} 보상 지시서 표본`;
    const before = await prisma.report.findFirst({ where: { title } });
    const rep = await makeReport({
      key: 'comp',
      researcherId: r1.researcherProfile!.id,
      title,
      status: 'CLOSED',
      publishedAt: ago(60 * DAY),
      deadline: ago(16 * DAY),
      priceKrw: 20_000,
    });
    if (!before) {
      for (const [i, b] of [buyer1, buyer2].entries()) {
        const p = await prisma.purchase.create({
          data: {
            reportId: rep.id,
            buyerId: b.id,
            amountKrw: 20_000,
            escrowStatus: 'REFUNDED',
            paymentMethod: 'CARD',
          },
        });
        await prisma.compensationInstruction.create({
          data: {
            purchaseId: p.id,
            predictionCardId: rep.predictionCard!.id,
            researcherUserId: r1.id,
            amountKrw: 16_000,
            cause: i === 0 ? 'DATA_UNKNOWN' : 'SYSTEM_ERROR',
            status: i === 0 ? 'PENDING_REVIEW' : 'APPROVED',
            createdAt: ago((i === 0 ? 4 : 1) * DAY),
            ...(i === 1
              ? { reviewedAt: ago(12 * HOUR), reviewedBy: operator.id, reviewNote: `${MARK} 확정` }
              : {}),
          },
        });
      }
    }
    log('보상 지시서 — 확정 대기 1 · 실행 대기 1', !before);
  }

  {
    // 지급 대기인데 계좌가 없어 막힌 건 — `차단된 지급`
    const title = `${MARK} 계좌 없어 막힌 지급`;
    const before = await prisma.report.findFirst({ where: { title } });
    const rep = await makeReport({
      key: 'blocked',
      researcherId: r3.researcherProfile!.id,
      title,
      status: 'CLOSED',
      publishedAt: ago(70 * DAY),
      deadline: ago(5 * DAY),
      priceKrw: 30_000,
    });
    if (!before) {
      const p = await prisma.purchase.create({
        data: {
          reportId: rep.id,
          buyerId: buyer3.id,
          amountKrw: 30_000,
          escrowStatus: 'RELEASED',
          paymentMethod: 'CARD',
        },
      });
      await prisma.settlement.create({
        data: {
          purchaseId: p.id,
          outcome: 'HIT',
          researcherPayoutKrw: 24_000,
          platformFeeKrw: 6_000,
          buyerRefundKrw: 0,
          settledAt: ago(5 * DAY),
        },
      });
    }
    log('지급 24,000원 — 계좌 미등록으로 차단', !before);
  }

  // ── ⑧ 보안 — 계좌 상태 네 가지 ──────────────────────────────────
  console.log('보안 (정산 계좌)');
  for (const c of [
    { user: r1, status: 'VERIFIED', label: '정상 검증', last4: '4821' },
    { user: r2, status: 'HOLDER_MISMATCH', label: '예금주 이름 불일치', last4: '7734' },
    { user: r3, status: 'UNVERIFIED', label: '낯선 기기 변경 — 쿨다운 중', last4: '1092' },
  ]) {
    const before = await prisma.payoutAccount.findUnique({
      where: { researcherUserId: c.user.id },
    });
    if (!before) {
      await prisma.payoutAccount.create({
        data: {
          researcherUserId: c.user.id,
          bankCode: '004',
          accountNumberEnc: encryptField(`110${c.last4}9988`),
          accountLast4: c.last4,
          holderName: c.status === 'HOLDER_MISMATCH' ? '김철수' : '홍길동',
          verifiedNameEnc: encryptField(c.status === 'HOLDER_MISMATCH' ? '홍길동' : '홍길동'),
          status: c.status,
          verifiedAt: c.status === 'VERIFIED' ? ago(10 * DAY) : null,
          changedAt: ago(2 * DAY),
          ...(c.status === 'UNVERIFIED' ? { cooldownUntil: ahead(30 * HOUR) } : {}),
        } as Prisma.PayoutAccountUncheckedCreateInput,
      });
    }
    log(`${c.label} (${c.user.penName})`, !before);
  }

  {
    // 동결 — 거는 것은 본인, 푸는 것은 운영자
    const acct = await prisma.payoutAccount.findUnique({ where: { researcherUserId: r1.id } });
    const already = acct?.frozenAt != null;
    if (acct && !already) {
      await prisma.payoutAccount.update({
        where: { researcherUserId: r1.id },
        data: { frozenAt: ago(6 * HOUR), frozenBy: r1.id },
      });
    }
    log('정산 동결 1건 (본인이 걸었음)', !!acct && !already);
  }

  // ── ⑨ 2인 승인 대기 ────────────────────────────────────────────
  //
  // **`ApprovalAction` 으로 못 박는다** — `'UNFREEZE'` 로 적혀 있었고(실제 값은
  // `'PAYOUT_UNFREEZE'`), 그 행은 화면에 열거값 원문이 뜨는 데다 `consumeApproval`
  // 이 영영 못 찾는 승인서였다. 문자열이라 아무도 막지 않았다.
  console.log('승인 요청');
  for (const c of [
    {
      action: 'PAYOUT_UNFREEZE',
      summary: `${MARK}정량리서치랩 님의 정산 동결 해제`,
      amountKrw: null,
      reason: '본인 확인 통화 완료 — 계좌 변경은 본인이 한 것으로 확인',
      wait: 5 * HOUR,
    },
    {
      action: 'LARGE_PAYOUT',
      summary: `${MARK}칩워처 님에게 8,400,000원 지급`,
      amountKrw: 8_400_000,
      reason: '분기 정산 누적분 — 문턱(500만원) 초과',
      wait: 50 * HOUR,
    },
  ] satisfies { action: ApprovalAction; summary: string; amountKrw: number | null; reason: string; wait: number }[]) {
    const before = await prisma.operatorApproval.findFirst({ where: { summary: c.summary } });
    if (!before) {
      await prisma.operatorApproval.create({
        data: {
          action: c.action,
          targetId: `${MARK}-${c.action}`,
          summary: c.summary,
          amountKrw: c.amountKrw,
          requestedBy: operator.id,
          requestedAt: ago(c.wait),
          reason: c.reason,
          status: 'PENDING',
        },
      });
    }
    log(`${c.action} (${Math.round(c.wait / HOUR)}시간 대기)`, !before);
  }

  // ── ⑩ 문의 — 답변 대기(오래된 것 포함) ──────────────────────────
  console.log('문의');
  for (const c of [
    { topic: 'PAYOUT_MISSING', desk: 'money', text: '정산이 아직 안 들어왔어요', wait: 3 * HOUR },
    {
      topic: 'FREEZE_RELEASE',
      desk: 'security',
      text: '계좌를 바꾼 적이 없는데 알림이 왔어요',
      wait: 40 * HOUR,
    },
    { topic: 'REFUND_MISSING', desk: 'money', text: '환불이 안 들어왔습니다', wait: 20 * HOUR },
    { topic: 'OTHER', desk: 'report', text: '판정 결과가 이해가 안 됩니다', wait: 8 * HOUR },
  ]) {
    const detail = `${MARK} ${c.text}`;
    const before = await prisma.supportTicket.findFirst({ where: { detail } });
    if (!before) {
      await prisma.supportTicket.create({
        data: {
          userId: buyer2.id,
          topic: c.topic,
          desk: c.desk,
          detail,
          status: 'OPEN',
          createdAt: ago(c.wait),
        },
      });
    }
    log(`${c.desk}/${c.topic} (${Math.round(c.wait / HOUR)}시간 대기)`, !before);
  }

  // ── ⑪ 판정 이의 — 접수(OPEN) / 인정 후 되돌리기 대기(UPHELD) ──────────
  // 이의가 접수된 건은 **정산이 멈춘다.** 화면에서 그 사실이 읽히려면 판정·구매·
  // 정산이 한 줄로 이어진 표본이 있어야 한다.
  console.log('판정 이의');
  for (const c of [
    {
      key: 'disp-open',
      title: `${MARK} 이의 접수 — 시세가 다릅니다`,
      status: 'OPEN',
      category: 'PRICE_MISMATCH',
      observed: '시한 당일 종가는 82,400원이었는데 판정은 79,000원으로 되어 있습니다.',
      wait: 2 * DAY,
    },
    {
      key: 'disp-upheld',
      title: `${MARK} 이의 인정 — 되돌리기 대기`,
      status: 'UPHELD',
      category: 'PRICE_MISMATCH',
      observed: '분할 이후 수정주가가 반영되지 않았습니다.',
      wait: 5 * DAY,
    },
  ]) {
    const before = await prisma.report.findFirst({ where: { title: c.title } });
    const rep = await makeReport({
      key: c.key,
      researcherId: r2.researcherProfile!.id,
      title: c.title,
      status: 'CLOSED',
      publishedAt: ago(80 * DAY),
      deadline: ago(c.wait + DAY),
      priceKrw: 15_000,
    });
    if (!before) {
      const judgment = await prisma.judgment.create({
        data: {
          predictionCardId: rep.predictionCard!.id,
          outcome: 'MISS',
          settledPrice: 79_000,
          realizedReturnPct: -2.8,
          score: -140,
          info: -0.8,
          dataSource: 'kis',
          judgedAt: ago(c.wait + HOUR),
        },
      });
      const purchase = await prisma.purchase.create({
        data: {
          reportId: rep.id,
          buyerId: buyer3.id,
          amountKrw: 15_000,
          escrowStatus: 'REFUNDED',
          paymentMethod: 'CARD',
        },
      });
      await prisma.judgmentDispute.create({
        data: {
          judgmentId: judgment.id,
          purchaseId: purchase.id,
          buyerId: buyer3.id,
          actorRole: 'PURCHASER',
          category: c.category,
          observed: `${MARK} ${c.observed}`,
          claimedPrice: 82_400,
          status: c.status,
          createdAt: ago(c.wait),
          ...(c.status === 'UPHELD'
            ? {
                resolvedAt: ago(6 * HOUR),
                resolvedBy: operator.id,
                resolution: `${MARK} 원주가 대조 결과 이의가 맞습니다 — 되돌리기 예정`,
              }
            : {}),
        },
      });
    }
    log(`${c.status} (${Math.round(c.wait / DAY)}일 경과)`, !before);
  }

  // ── ⑫ 오늘의 경보 — 관리자 홈의 "무엇이 아픈가" 줄 ────────────────────
  // 운영자에게 간 OPS_ALERT 알림이 그대로 홈에 뜬다. 하나도 없으면 그 자리가
  // 영원히 빈 상자라 색·간격을 정할 수 없다.
  console.log('오늘의 경보');
  for (const c of [
    {
      title: '신고 누적 — 리포트 판매가 자동 중단됐습니다',
      body: `${MARK} 서로 다른 신고자 3명이 모여 판매를 멈췄습니다. 사람이 아직 안 본 상태입니다.`,
      wait: 3 * HOUR,
    },
    {
      title: '일일 출금 한도 80% 도달',
      body: `${MARK} 오늘 나간 돈이 한도의 80%를 넘었습니다 — 남은 지급이 밀릴 수 있습니다.`,
      wait: 6 * HOUR,
    },
    {
      title: '판정 이월 7일 초과 카드 3장',
      body: `${MARK} 시세를 못 받아 판정이 멈춘 카드가 일주일을 넘겼습니다. 구매자 돈이 묶여 있습니다.`,
      wait: 9 * HOUR,
    },
  ]) {
    const before = await prisma.notification.findFirst({
      where: { userId: operator.id, type: 'OPS_ALERT', body: c.body },
    });
    if (!before) {
      await prisma.notification.create({
        data: {
          userId: operator.id,
          type: 'OPS_ALERT',
          title: c.title,
          body: c.body,
          link: '/admin',
          createdAt: ago(c.wait),
          pushedAt: ago(c.wait),
        },
      });
    }
    log(c.title, !before);
  }

  console.log(`\n새로 만든 것 ${made}건 · 이미 있어 건너뛴 것 ${skipped}건`);
  console.log(`전부 제목·이름이 ${MARK} 로 시작합니다 — 지울 때 그것으로 고르면 됩니다.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
