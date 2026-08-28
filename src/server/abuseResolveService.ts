import type { PrismaClient } from '@prisma/client';
import { suspendsOnAbuseReports } from '@/domain/abuseSuspension';
import {
  AbuseReportError,
  notifySalesResumedAfterRejection,
  reviewAbuseReport,
  type ReviewAbuseReportInput,
} from './abuseReportService';
import {
  ComplianceTakedownError,
  forceWithdrawReport,
  operatorVerdictWrites,
  type TakedownSummary,
} from './complianceService';

// 신고 그룹 처리 — **판단 하나가 전부를 정한다** (2026-08-19 사용자 확정).
//
// 그전에는 "위반 확인"과 "강제 철회"가 다른 화면의 다른 버튼이었다. 확인은 신고(제보)에
// 대한 판단이고 철회는 상품에 대한 처분이라 따로 만들어졌는데, 실제로는 "이 글은
// 위반이다"라는 판단 하나가 둘 다를 정한다 — 운영자가 두 번 결정할 이유가 없다.
// 갈라져 있는 동안 실제 구멍도 있었다: 확인하는 순간 PENDING 신고가 줄어 **판매 중단이
// 풀리고, 위반이 확인된 리포트가 철회 전까지 다시 팔렸다** (알림으로 환기만 했다).
//
// 이 함수가 한 흐름으로 묶는 것:
//   확인 → ① 강제 철회 (전액 환불 · 수수료 0 · 점수 0 — forceWithdrawReport 그대로)
//          ② 미탐 기록 (검수가 통과시킨 글을 사람이 잡았다 — 검수 정확도의 유일한 미탐 경로)
//          ③ 신고자 전원 통지 + 첫 신고자 보상 (기존 reviewAbuseReport 규칙 그대로)
//   기각 → 신고 전원 기각 통지 + 무고 기록, 판매 중단은 저절로 풀린다 (PENDING이 사라지므로)
//
// **왜 신고 단위가 아니라 리포트 단위인가**: 운영자가 답하는 질문이 "이 신고가 맞나"가
// 아니라 "이 리포트를 내려야 하나"다. 같은 리포트에 모인 신고 셋은 한 판단의 세 증거지
// 세 개의 판단거리가 아니다.
//
// 별도 파일인 이유: abuseReportService는 purchaseService가 임포트하고,
// complianceService는 판정 파이프라인 깊숙이 얽혀 있다 — 양쪽을 한 파일에서 부르면
// 순환 임포트의 씨앗이 된다. 오케스트레이션은 바깥에서 한다.

export interface ResolveAbuseGroupInput {
  reportId: string;
  operatorUserId: string;
  decision: 'CONFIRMED' | 'REJECTED';
  /**
   * 검토 사유 — 어디로 가는지가 결말마다 다르다:
   *   · 확인 → **리서처의 강제 철회 통지**에 `사유:`로 실린다 (complianceService)
   *   · 기각 → **아무에게도 안 간다.** 통지가 양쪽 다 고정 양식이라(domain/notice),
   *     이 글은 `AbuseReport.reviewNote`에만 남아 반복 무고 판단의 근거가 된다
   */
  note: string;
  /** 확인일 때 실제 위반 유형 — 미탐 라벨이 되고, 유형 선택기의 근거가 된다.
   *  내장 RiskCategory 또는 운영자가 정의한 커스텀 유형 라벨(문자열)이 온다 */
  categories?: string[];
  /**
   * 근거 문장 지목 (2026-08-28 창업자 지시 — 필수는 UI 가 강제).
   * 강제 철회(미탐)·지적 타당(경계)의 재학습 자료 근거가 된다 — IRIS 가 그 문장 창만
   * 위반으로 배운다. 순수 오신고에는 오지 않는다(재학습 자료가 아니므로)
   */
  evidence?: string[];
  /**
   * **기각일 때만** — 신고자의 지적이 타당했는가 (2026-08-27 창업자 지시).
   *   · true  = "지적은 타당했으나 위반은 아님"(경미). 무고로 세지 않고, 검수 기록에
   *     KEPT + findingsValid=true 로 남겨 **경계 사례로 학습**에 넣는다(교사 질문지 생성).
   *   · false/미지정 = 순수 오신고. 종전대로 무고 이력에 남고 학습에는 안 들어간다.
   * 확인(CONFIRMED)일 때는 무시한다 — 그쪽은 미탐(TAKEDOWN)이 라벨이다.
   */
  findingsValid?: boolean;
}

export interface ResolveAbuseGroupSummary {
  /** 처리한 신고 수 (서로 다른 신고자 수와 같다 — 1인 1신고 제약) */
  resolved: number;
  /** 이번 처리로 보상 대상이 생겼나 (리포트별 첫 신고자 규칙) */
  rewarded: boolean;
  /** 철회가 실제로 일어났으면 그 요약 (환불 건수·금액) */
  takedown: TakedownSummary | null;
  /** 철회를 건너뛴 이유 — 이미 닫혔거나 판정이 끝난 경우. 신고 확인은 그래도 진행된다 */
  takedownSkipped: string | null;
}

export async function resolveAbuseReportGroup(
  prisma: PrismaClient,
  input: ResolveAbuseGroupInput,
  now = new Date(),
): Promise<ResolveAbuseGroupSummary> {
  const pending = await prisma.abuseReport.findMany({
    where: { reportId: input.reportId, status: 'PENDING' },
    orderBy: { createdAt: 'asc' }, // 보상은 첫 신고자에게 — 순서가 곧 규칙이다
  });
  if (pending.length === 0) {
    throw new AbuseReportError('검토를 기다리는 신고가 없습니다');
  }

  // **지금 판매가 멈춰 있는가 — 신고를 처리하기 전에 재어 둔다.**
  // 처리하고 나면 PENDING이 사라져 중단도 함께 풀리므로, 그 뒤에는 "멈춰 있었다"는
  // 사실을 어디서도 되찾을 수 없다. 기각 통지를 보낼지가 이 값 하나에 달려 있다
  const wasSuspended = suspendsOnAbuseReports(new Set(pending.map((r) => r.reporterId)).size);

  // ① 확인이면 철회가 먼저다 — 신고를 먼저 확인하면 PENDING이 줄어 판매 중단이 풀리고,
  //    철회가 실행되기 전까지 위반이 확인된 리포트가 팔린다. 순서가 구멍을 막는다.
  let takedown: TakedownSummary | null = null;
  let takedownSkipped: string | null = null;
  if (input.decision === 'CONFIRMED') {
    try {
      takedown = await forceWithdrawReport(
        prisma,
        {
          reportId: input.reportId,
          operatorUserId: input.operatorUserId,
          reason: input.note,
          categories: input.categories ?? [],
          evidence: input.evidence,
          // **정형 통지는 보내지 않는다** (2026-08-20 사용자 확정) — 확인 창에서
          // 운영자가 리서처에게 직접 쓴 쪽지가 이 자리를 대신한다. 사유는 통지가
          // 아니라 감사 스냅샷·검수 라벨로 남는다
          notifyResearcher: false,
        },
        now,
      );
    } catch (e) {
      // **처분이 실패해도 관측은 남긴다** (2026-08-21).
      //
      // 여기까지 왔다는 것은 운영자가 확인 창에서 "위반이 맞다"를 고르고 실제 유형까지
      // 지목했다는 뜻이다. 철회가 안 되는 것은 **내릴 물건이 없다**는 사실일 뿐,
      // 검수가 놓쳤다는 사실을 바꾸지 않는다.
      //
      // 그동안은 이 catch가 라벨 쓰기까지 함께 삼켰다. 그래서 **판매가 끝난 뒤에야
      // 드러난 위반** — 검수가 가장 오래 놓친 건 — 이 미탐 집계와 학습 자료에서
      // 통째로 빠졌다. 미탐률이 실제보다 낮게 보이는 조용한 구멍이었다.
      //
      // `ALREADY_CLOSED`만 센다: 초안(NOT_APPLICABLE)은 팔린 적이 없어 놓칠 것도
      // 없었고, 데이터 사고(DATA_ERROR)를 미탐으로 세면 우리 사고가 검수 성적을 깎는다.
      if (e instanceof ComplianceTakedownError && e.reason === 'ALREADY_CLOSED') {
        await prisma.$transaction(
          await operatorVerdictWrites(
            prisma,
            input.reportId,
            'MISSED',
            input.operatorUserId,
            now,
            { reason: input.note, categories: input.categories ?? [], evidence: input.evidence },
          ),
        );
      }
      // 이미 닫혔거나 판정이 끝난 리포트 — 내릴 것이 없을 뿐, 신고가 틀린 것은 아니다.
      // 신고자 통지·보상·기록은 그대로 진행하고, 건너뛴 사실을 화면에 알린다
      if (e instanceof ComplianceTakedownError) takedownSkipped = e.message;
      else throw e;
    }
  }

  // ② 신고 전원 처리 — 기존 단건 함수를 그대로 쓴다. 보상 규칙(리포트별 첫 신고자·
  //    선착순 쿼터)과 통지 문구가 전부 거기 있고, 두 벌로 만들면 두 벌이 따로 낡는다
  let rewarded = false;
  for (const r of pending) {
    const reviewInput: ReviewAbuseReportInput = {
      id: r.id,
      operatorUserId: input.operatorUserId,
      decision: input.decision,
      note: input.note,
      // 확인(강제 철회)은 운영자가 확인 창에서 신고자마다 직접 쓴다 — 자동 통지까지
      // 나가면 한 사람이 같은 사건으로 두 통을 받는다. 기각은 반대로 **전부 자동**이다
      // (결과가 하나뿐이라 지을 사연이 없다)
      notifyReporter: input.decision === 'REJECTED',
    };
    const res = await reviewAbuseReport(prisma, reviewInput, now);
    rewarded = rewarded || res.rewarded;
  }

  // ③ 기각으로 판매가 다시 열렸으면 **리서처에게도** 알린다 (고정 양식).
  //    신고자 통지는 ②의 reviewAbuseReport가 사람 수만큼 보냈고, 이쪽은 이 한 줄이
  //    전부다 — 전에는 없어서 리서처는 멈췄다는 말만 듣고 열렸다는 말은 못 들었다
  if (input.decision === 'REJECTED' && wasSuspended) {
    await notifySalesResumedAfterRejection(prisma, input.reportId, now);
  }

  // ④ **기각인데 지적은 타당했으면** 검수 기록에 KEPT + findingsValid=true 로 남긴다
  //    (2026-08-27 창업자 지시). 위반은 아니라 판매는 재개하되, 신고자가 짚은 것은
  //    경계 사례라 모델이 배울 값이 있다 — verdictNeedsTeacherPack(KEPT, true) 가 참이라
  //    라우트의 storeTeacherPackForReport 가 이 건을 교사 질문지로 만든다.
  //    무고 제외(reporterRejectedCount)는 이 verdict 를 보고 getAbuseReports 가 판단한다.
  //    ⚠ 순수 오신고(findingsValid=false)에는 아무 verdict 도 쓰지 않는다 — 모델은 옳게
  //    통과시켰고 배울 게 없다(신고 경로의 '오탐'은 질문지 미작성, teacherPackStore 주석)
  if (input.decision === 'REJECTED' && input.findingsValid === true) {
    await prisma.$transaction(
      await operatorVerdictWrites(prisma, input.reportId, 'KEPT', input.operatorUserId, now, {
        reason: input.note,
        findingsValid: true,
        evidence: input.evidence,
      }),
    );
  }

  return { resolved: pending.length, rewarded, takedown, takedownSkipped };
}
