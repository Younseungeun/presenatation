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
import {
  createStudentClientFromEnv,
  describeUnavailability,
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
export async function GET() {
  try {
    await requireOperatorId(prisma);
    const board = await getStudentOutageBoard(prisma);
    const mode = studentMode();
    const client = mode === 'off' ? null : createStudentClientFromEnv();
    const usable = client ? await client.usable().catch(() => false) : false;
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
    return NextResponse.json({
      ...board,
      student: {
        mode,
        reviewerId: client?.reviewerId ?? null,
        usable,
        modelSha: health?.modelSha ?? null,
        // **못 쓰는 이유를 함께 보낸다.** 여기까지 `health` 를 이미 받아 놓고 `modelSha` 만
        // 꺼내 쓰고 있었다 — 사유가 변수에 담긴 채 화면에 한 번도 도착하지 않았다.
        // 장애 알림은 상태가 **바뀌는 순간** 한 번만 나가는데 고치러 오는 사람이 보는 곳은
        // 화면이라, 알림을 놓치면 "결근"만 남는다 (2026-08-22 토크나이저 건이 그랬다).
        // 쓸 수 있을 때는 null — 정상인데 사유를 적으면 그 줄이 배경음이 된다
        unavailableReason: usable ? null : describeUnavailability(health),
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
