import type { PrismaClient } from '@prisma/client';

// 운영 설정 — 배포 없이 운영자가 켜고 끄는 값들.
// 환경변수로 두면 바꿀 때마다 재배포가 필요해 "지금 끄고 싶다"에 대응할 수 없다.
//
// 기본값은 **끈 상태**다. 이 설정들은 전부 "보여줄지 말지"를 정하는데,
// 초기에는 숫자가 작아 보여주는 쪽이 손해다. 켜는 것은 판단이 선 뒤의 일이라
// 아무도 손대지 않은 상태에서 저절로 켜져 있으면 안 된다.

export const SETTING_KEYS = {
  /** 시장 규모 띠지 표시 */
  marketTicker: 'ui.marketTicker.enabled',
  /** 띠지에 금액(에스크로·환불 누적)을 포함할지 — 규모와 금액은 민감도가 다르다 */
  marketTickerAmounts: 'ui.marketTicker.amounts',
  /**
   * 검출 사다리 문턱 프로필 — 콜드스타트 (12차 검토 C-7, 2026-09-01). 켜면 승격·BLOCK 자격의
   * 물량 조건을 절대 건수 대신 **꼬리 연속 정탐**으로 본다. 운영 초기 6개월 한정 — 표본이
   * 쌓이면 끈다. 배포 없이 바꾸려고 AppSetting 에 둔다
   */
  ladderColdstart: 'ladder.coldstart',
  /**
   * 지금 쓰는 **수동 2차 교사** 표식 (18차 V-4).
   *
   * 대화창의 교사는 버전이 오른다. 이 표식이 없으면 나중에 "이 라벨은 어느 교사가
   * 만들었나"를 영원히 못 가르고, 교사가 바뀐 전후의 라벨을 섞어 재학습하게 된다.
   *
   * **매 건 손으로 적게 하지 않는다** — 적게 하면 틀린다. 한 칸에 두고 바뀔 때만 고친다.
   * 대신 `updatedAt` 이 오늘이 아니면 화면이 하루 한 번 확인을 요구한다
   * (`teacherTagStale`): 조용한 설정 누락이 라벨을 조용히 오염시키는 것을 막는다.
   */
  teacherTag: 'screening.teacher.tag',
  /**
   * 마지막 **승격된 학생 모델 지문** (관리자 앱 인계서 2026-08-22 §3 → 회신 8호).
   *
   * 값은 JSON `{ "sha": "...", "at": ISO 시각 }`. `student:promote` 만 쓴다.
   * 화면은 사이드카 /health 의 적재 지문과 이 값을 대조한다 — 다르면 "승격 기록에 없는
   * 지문" 경고. 사람의 기억(어제 값)에 기대는 감시는 하루 세 번의 교체 앞에서 안 돈다.
   */
  studentPromoted: 'student.promoted',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

export interface UiSettings {
  marketTicker: boolean;
  marketTickerAmounts: boolean;
  ladderColdstart: boolean;
}

/** 화면이 쓰는 설정 한 벌 — 조회 한 번으로 끝낸다 */
export async function getUiSettings(prisma: PrismaClient): Promise<UiSettings> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: Object.values(SETTING_KEYS) } },
    select: { key: true, value: true },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    marketTicker: map.get(SETTING_KEYS.marketTicker) === '1',
    marketTickerAmounts: map.get(SETTING_KEYS.marketTickerAmounts) === '1',
    ladderColdstart: map.get(SETTING_KEYS.ladderColdstart) === '1',
  };
}

/** 검출 사다리가 부를 때마다 읽는다 (C-7) — 캐시 없음: 스위치를 내린 순간부터 표준 문턱이어야 한다 */
export async function getLadderColdstart(prisma: PrismaClient): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({
    where: { key: SETTING_KEYS.ladderColdstart },
    select: { value: true },
  });
  return row?.value === '1';
}

/**
 * 지금 쓰는 교사 표식과 **그것이 오늘 확인된 값인가** (18차 V-4).
 *
 * 검토의 요구: *"조용한 설정 누락을 막기 위해 하루 첫 보류 건을 열 때 현재 사용하는
 * 교사 모델을 강제로 묻는다."* `updatedAt` 이 그 판단의 근거다 — 확인 버튼이 같은 값을
 * 다시 저장하면 시각이 새로 찍히므로, 별도 칸 없이 "오늘 확인했는가"가 남는다.
 */
export interface TeacherTagState {
  tag: string | null;
  /** 오늘 확인되지 않았다 — 화면이 답 기록 전에 확인을 요구해야 한다 */
  stale: boolean;
}

export async function getTeacherTag(
  prisma: PrismaClient,
  now = new Date(),
): Promise<TeacherTagState> {
  const row = await prisma.appSetting.findUnique({
    where: { key: SETTING_KEYS.teacherTag },
    select: { value: true, updatedAt: true },
  });
  const tag = row?.value?.trim() || null;
  // 값이 없으면 낡음이다 — "아직 안 정했다"와 "오래됐다"는 화면에서 할 일이 같다
  if (!tag || !row) return { tag: null, stale: true };
  return { tag, stale: !isSameLocalDay(row.updatedAt, now) };
}

/** 확인·변경 둘 다 이 함수를 쓴다 — 같은 값을 다시 저장하는 것이 곧 "오늘 확인했다"다 */
export async function setTeacherTag(
  prisma: PrismaClient,
  tag: string,
  operatorUserId: string,
): Promise<void> {
  const value = tag.trim();
  if (!value) throw new Error('교사 표식이 비어 있습니다');
  await prisma.appSetting.upsert({
    where: { key: SETTING_KEYS.teacherTag },
    create: { key: SETTING_KEYS.teacherTag, value, updatedBy: operatorUserId },
    update: { value, updatedBy: operatorUserId },
  });
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 운영자가 켜고 끈다 — 누가 바꿨는지 남긴다 */
export async function setBooleanSetting(
  prisma: PrismaClient,
  key: SettingKey,
  value: boolean,
  operatorUserId: string,
): Promise<void> {
  const stored = value ? '1' : '0';
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: stored, updatedBy: operatorUserId },
    update: { value: stored, updatedBy: operatorUserId },
  });
}
