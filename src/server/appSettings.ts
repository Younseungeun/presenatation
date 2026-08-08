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
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

export interface UiSettings {
  marketTicker: boolean;
  marketTickerAmounts: boolean;
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
  };
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
