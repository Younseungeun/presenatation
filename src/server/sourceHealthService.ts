import type { PrismaClient } from '@prisma/client';
import type { AssetClass } from '@/domain/constants';
import { ASSET_CLASSES } from '@/domain/constants';
import type { SourceHealth } from '@/domain/sourceHealth';

// 자산군별 시세 소스 헬스를 AppSetting에 남긴다 — 판정 배치가 매 회차 끝에 도장을 찍고,
// 관리자 홈 띠지가 읽는다. **새로 시세를 부르지 않는다** — 이미 돈 회차의 결과를 접을 뿐.

const KEY = (assetClass: AssetClass) => `source.health.${assetClass}`;

export interface SourceHealthRecord {
  health: SourceHealth;
  /** 사람이 읽을 사유 한 줄 (예: "kis 43건 응답 없음") */
  detail: string;
  at: string;
}

export async function recordSourceHealth(
  prisma: PrismaClient,
  assetClass: AssetClass,
  health: SourceHealth,
  detail: string,
  now = new Date(),
): Promise<void> {
  const value = JSON.stringify({ health, detail, at: now.toISOString() } satisfies SourceHealthRecord);
  await prisma.appSetting.upsert({
    where: { key: KEY(assetClass) },
    update: { value },
    create: { key: KEY(assetClass), value },
  });
}

export async function readSourceHealth(
  prisma: PrismaClient,
): Promise<Partial<Record<AssetClass, SourceHealthRecord>>> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: ASSET_CLASSES.map(KEY) } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out: Partial<Record<AssetClass, SourceHealthRecord>> = {};
  for (const ac of ASSET_CLASSES) {
    const raw = byKey.get(KEY(ac));
    if (!raw) continue;
    try {
      out[ac] = JSON.parse(raw) as SourceHealthRecord;
    } catch {
      /* 깨진 값은 없는 것으로 — 헬스 표시가 화면을 죽이지 않는다 */
    }
  }
  return out;
}
