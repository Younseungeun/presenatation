import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import {
  engageStudentBypass,
  getStudentOutageBoard,
  releaseStudentBypass,
} from '@/server/studentValveService';
import { requireOperatorId, toErrorResponse } from '../../../_lib/http';
import { SETTING_KEYS } from '@/server/appSettings';
import { readCanaryBeat } from '@/server/screeningCanaryRunner';
import { composeReviewerStamp } from '@/server/complianceService';
import { readAttendanceBeat } from '@/server/studentAttendance';
import { readHeartbeat } from '@/server/schedulerHealth';
import {
  createStudentClientFromEnv,
  listUnavailability,
  studentMode,
} from '@/infra/compliance/studentClient';

/**
 * 학생 장애 우회 밸브 + 출근 계기판 (21차 Y-1(b) · 관리자 앱 2회차 B-3 · 인계 3호).
 *
 *   GET  계기판 한 벌 — 장애 시작 시각 · 장애 보류 건수 · 밸브 상태 · 학생 출근 상태
 *   POST { action: 'engage' | 'release' } — 밸브 내리기 / 미리 올리기
 *
 * 내리는 것도 올리는 것도 운영자다 (정산 동결과 달리 양쪽 다 운영 판단이라 대칭).
 * 밸브는 2시간 뒤 저절로 만료된다 — 연장하려면 다시 내려야 하고, 그 클릭이 곧
 * "아직 우회가 필요하다"는 사람의 판단 기록이다.
 *
 * student.usable 은 시맨틱 핑까지 포함한 값이다 — true 면 "자리에 있고 정신도
 * 멀쩡하다"까지 확인된 것 (게이트 캐시라 이 조회가 사이드카를 매번 부르지는 않는다).
 */
export async function GET(req: NextRequest) {
  try {
    await requireOperatorId(prisma);
    const board = await getStudentOutageBoard(prisma);
    const mode = studentMode();
    const client = mode === 'off' ? null : createStudentClientFromEnv();

    // **화면을 열 때는 새로 잰다** (2026-08-23 창업자 지시 — 검수 규칙과 같은 규칙).
    //
    // 카나리아는 화면이 열릴 때마다 그 자리에서 다시 돈다. IRIS 만 캐시된 답을 보여 주면
    // 두 줄이 나란히 있는데 **한쪽만 어제 값**이다. 실제로 2026-08-22 에 지문이 갈렸을 때
    // 화면이 "출근"을 띄우고 있었던 것이 이 캐시 때문이다.
    //
    // **폴링에는 걸지 않는다.** 이 라우트는 계기판이 30초마다 다시 부르는데, 매번 새로
    // 재면 `/health` 1 + 핑 8 = 9회가 30초마다다(시간당 1,080회) — 5분 주기 스케줄러
    // 점검(시간당 108회)의 열 배다. 그래서 **여는 순간에만** `?fresh=1` 로 요청한다.
    const fresh = req.nextUrl.searchParams.get('fresh') === '1';
    const measured = client
      ? await (fresh && client.recheck ? client.recheck() : client.usable()).catch(() => false)
      : false;
    // **화면이 띄우는 것은 잰 값이 아니라 확정된 상태다** (2026-08-23 창업자 확정 B안).
    //
    // 한 번의 2초 초과로 결근 문자가 나갔다 5분 뒤 복귀 문자가 또 나간 일이 실제로
    // 있었다(원인은 사이드카가 아니라 CPU 를 다 쓰던 시험). 그래서 **두 번 연속**
    // 실패해야 결근이다 — 주기가 5분이라 진짜 결근은 늦어도 10분 안에 잡힌다.
    // 집행은 이미 첫 실패에서 막고 있으므로(`measured` 가 false 면 게시는 보류)
    // 이 유예로 위험해지는 것은 없다. 미루는 것은 **알림과 표시**뿐이다.
    const attendance = client?.attendance?.() ?? { ok: measured, pendingFailure: false };
    const usable = attendance.ok;
    // **적재 가중치 지문** (3회차 B-1): reviewerId 는 설정에서 조립되어 재학습으로
    // 가중치만 갈리면 그대로다 — "지금 누가 근무 중인가"는 사이드카가 실제로 적재한
    // 것의 지문으로만 말할 수 있다. 화면은 표식 옆에 앞 8자를 함께 그린다
    const health = client ? await client.health().catch(() => null) : null;
    // **승격 기록** (인계서 §3) — 적재 지문이 승격 명령 없이 바뀌면 그게 사고다. 화면은
    // modelSha 와 promoted.sha 를 대조한다: 같으면 ✓, 다르면 "승격 기록에 없는 지문 —
    // 재기동으로 올라온 것일 수 있습니다". 기록이 없으면(null) 아직 한 번도 승격 안 한 것
    const promotedRow = await prisma.appSetting.findUnique({
      where: { key: SETTING_KEYS.studentPromoted },
      select: { value: true, updatedAt: true },
    });
    let promoted: { sha: string; at: string } | null = null;
    if (promotedRow) {
      try {
        promoted = JSON.parse(promotedRow.value) as { sha: string; at: string };
      } catch {
        promoted = null;
      }
    }
    // **사유는 잰 쪽에서 받는다** (2026-08-23). 여기서 `describeUnavailability(health)` 로
    // 다시 계산하면 **핑 결과가 없어** 상태 플래그가 전부 정상인 경우 남는 답이 하나뿐이라
    // 늘 "상태는 정상인데 고정 문항이 어긋납니다"만 떴다 — 모델이 죽은 것인지·늦은
    // 것인지·지문이 어긋난 것인지 화면으로 구별할 수 없었다(고칠 곳이 전혀 다른 셋이다).
    // 클라이언트가 사유를 안 남기면(시험 목·URL 미설정) 그때만 여기서 계산한다.
    // 사유는 **잰 값**을 따른다 — 확정 전(`pendingFailure`)에도 무엇이 어긋났는지는
    // 이미 알고 있고, 화면이 "확인 중"이라고만 적고 이유를 감추면 볼 것이 없어진다
    const reasons = measured
      ? []
      : (client?.failureReasons?.() ?? []).length > 0
        ? client!.failureReasons!()
        : listUnavailability(health);

    // **카나리아 박동도 함께 보낸다** (2026-08-23 창업자 신고).
    //
    // 계기판의 `다음 점검까지` 타이머가 **이유 없이 노랑·빨강으로 올라갔다.** 원인은
    // 타이머가 아니라 데이터였다: `nextAt` 이 서버 렌더 시점에 한 번 실린 스냅샷이라,
    // 화면을 5분 넘게 켜 두면 스케줄러가 제때 돌아 값을 새로 써도 화면은 옛 값을 들고
    // 0:00 을 지나 칸을 올렸다. **정상인데 경보가 뜨는 것**이라 가장 나쁜 종류다.
    //
    // 카나리아를 여기서 다시 돌리지는 않는다 — 필요한 것은 "언제 통과했나"뿐이고,
    // 그건 AppSetting 두 줄이다(층별 결과는 화면이 자기 렌더에서 이미 잰다).
    // ⚠ **이름과 순서가 어긋나 있었다** (2026-08-23 화면에서 발견): 배열은
    // [카나리아, 출근, 스케줄러] 인데 `[canaryBeat, schedulerBeat, attendance]` 로 받아
    // **출근 자리에 스케줄러 심박이 들어갔다.** 화면은 `nextAt` 이 없어 타이머를 안 그렸다.
    // **tsc 가 못 잡는다** — 세 값이 전부 `.stale` 을 갖고 있고 응답은 그대로 펼쳐지므로
    // 타입이 맞는다. 위치로 받는 값은 이름이 아니라 **순서**가 계약이라, 줄을 늘릴 때마다
    // 이 자리가 다시 위험해진다.
    const [canaryBeat, attendanceBeat, schedulerBeat] = await Promise.all([
      readCanaryBeat(prisma),
      // IRIS 출근 점검 박동 — 카나리아와 대칭 (회신 16호). 재지 않고 읽기만: "지금 어떤가"는 usable/recheck 가 답한다
      readAttendanceBeat(prisma),
      readHeartbeat(prisma),
    ]);

    return NextResponse.json({
      ...board,
      canary: { ...canaryBeat, schedulerOff: schedulerBeat.stale },
      // student.attendance.{lastOkAt,lastRanAt,nextAt,stale,timerStale} — 화면은 검수 규칙 줄과
      // 같은 타이머를 IRIS 줄에 그린다. **타이머 칸이 읽는 것은 `timerStale`** 이다:
      // 그 칸이 답하는 질문은 "IRIS 가 답했나"가 아니라 "물어보러 갔나"이고, IRIS 자신의
      // 상태는 바로 옆 상태 칩(근무 중·확인 중·결근)이 이미 말한다
      attendance: { ...attendanceBeat, schedulerOff: schedulerBeat.stale },
      student: {
        mode,
        reviewerId: client?.reviewerId ?? null,
        usable,
        // **한 번 어긋났지만 아직 결근은 아니다** — 화면은 이 값을 "확인 중"으로 그린다.
        // 근무 중이라고 잘라 말하면 거짓말이고 결근이라고 하면 헛걸음 하나로 사람을 깨운다
        pendingFailure: attendance.pendingFailure,
        modelSha: health?.modelSha ?? null,
        // 파일이 들고 온 이름 — .env 태그가 아니라 config.json 의 run (회신 13호). 화면의 "근무자 표식" 근거
        name: health?.name ?? null,
        run: health?.run ?? null,
        // **못 쓰는 이유를 함께 보낸다.** 여기까지 `health` 를 이미 받아 놓고 `modelSha` 만
        // 꺼내 쓰고 있었다 — 사유가 변수에 담긴 채 화면에 한 번도 도착하지 않았다.
        // 장애 알림은 상태가 **바뀌는 순간** 한 번만 나가는데 고치러 오는 사람이 보는 곳은
        // 화면이라, 알림을 놓치면 "결근"만 남는다 (2026-08-22 토크나이저 건이 그랬다).
        // 쓸 수 있을 때는 null — 정상인데 사유를 적으면 그 줄이 배경음이 된다
        unavailableReason: reasons[0]?.sentence ?? null,
        // 항목으로도 보낸다 — 계기판이 배지로 늘어놓는다(검수 규칙의 층 배지와 같은 자리).
        // 고칠 것이 몇 개인지가 **고치러 가기 전에** 보여야 한다
        unavailableReasons: reasons,
        /* **검수 기록에 실제로 박히는 표식** — 화면이 이어 붙이지 않고 서버가 조립한다.
           자동 검수 참여자는 **규칙 엔진 + IRIS** 둘뿐이라 base 는 언제나 `rule` 이다.
           예전에는 `ANTHROPIC_API_KEY` 가 있으면 여기에 `claude:` 조각을 끼워 미리
           보여 줬는데, Claude 는 게시 검수에 참여하지 않으므로(2026-08-24 창업자 확정)
           **실제로 박히는 표식과 어긋나는 예고**였다 */
        reviewerStamp: composeReviewerStamp('rule', client?.reviewerId ?? null),
        promoted,
        promotionMatches: promoted && health?.modelSha ? promoted.sha === health.modelSha : null,
      },
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}

const bodySchema = z.object({ action: z.enum(['engage', 'release']) });

export async function POST(req: NextRequest) {
  try {
    const operatorId = await requireOperatorId(prisma);
    const { action } = bodySchema.parse(await req.json());
    if (action === 'engage') {
      const state = await engageStudentBypass(prisma, operatorId);
      return NextResponse.json({ ok: true, bypass: state });
    }
    await releaseStudentBypass(prisma, operatorId);
    return NextResponse.json({ ok: true, bypass: { active: false, until: null } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
