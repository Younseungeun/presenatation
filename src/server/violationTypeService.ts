import type { PrismaClient } from '@prisma/client';
import { isBuiltinCategory, RISK_CATEGORIES, RISK_CATEGORY_LABEL } from '@/domain/compliance';

export { isBuiltinCategory };

// 운영자 정의 위반 유형 (2026-08-28 창업자 지시).
//
// 강제 철회 때 "위반 유형 추가"로 새 유형(예: "논리적 비약")을 만든다. 내장 RiskCategory
// 로 담기지 않는 미탐을 잡으려는 것이라, **label 자체가 곧 operatorCategories 에 저장되는
// key** 다 — 표시는 어디서든 `RISK_CATEGORY_LABEL[key] ?? key` 로 풀린다(별도 라벨 맵 불요).
// 한 번 만들면 이후 검수·어뷰징 유형 선택기에 칩으로 뜬다.

const MAX_LABEL = 40;

// 내장 유형의 key·label 집합 — 커스텀 유형이 이것과 겹치면 표시·집계가 헷갈린다.
const BUILTIN_KEYS = new Set<string>(RISK_CATEGORIES);
const BUILTIN_LABELS = new Set<string>(Object.values(RISK_CATEGORY_LABEL));

/** 라벨을 검증한다 — 통과하면 정규화(trim)된 값을, 아니면 사유를 돌려준다. */
export function validateViolationTypeLabel(raw: string): { label: string } | { error: string } {
  const label = raw.trim().replace(/\s+/g, ' ');
  if (label.length === 0) return { error: '유형 이름을 적어 주세요' };
  if (label.length > MAX_LABEL) return { error: `유형 이름은 ${MAX_LABEL}자 이내로 적어 주세요` };
  // 내장 유형과 겹치면 만들지 않는다 — 같은 뜻이 두 key 로 갈라져 집계가 쪼개진다
  if (BUILTIN_KEYS.has(label) || BUILTIN_LABELS.has(label)) {
    return { error: '이미 있는 위반 유형입니다 — 위 칩에서 골라 주세요' };
  }
  return { label };
}

/** 활성 커스텀 유형의 라벨(=key) 목록 — 선택기가 칩으로 그린다. */
export async function getCustomViolationTypes(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.violationType.findMany({
    where: { active: true },
    orderBy: { createdAt: 'asc' },
    select: { label: true },
  });
  return rows.map((r) => r.label);
}

/**
 * 커스텀 유형을 보장한다 — 없으면 만들고, 있으면(비활성이면 되살려) 그대로 둔다.
 * 내장 유형이면 아무것도 하지 않는다(이미 유형 목록에 있다). 반환값은 실제 저장될 key.
 * 검증 실패는 던진다 — 유형이 라벨로 남는 구조라 오타가 곧 "없는 유형"이 된다.
 */
export async function ensureViolationType(
  prisma: PrismaClient,
  raw: string,
  createdBy: string,
  sourceReportId?: string,
): Promise<string> {
  if (isBuiltinCategory(raw.trim())) return raw.trim();
  const checked = validateViolationTypeLabel(raw);
  if ('error' in checked) throw new Error(checked.error);
  const { label } = checked;
  // 라벨이 unique 라 upsert 로 멱등하게. 되살릴 때 만든 사람·출처는 처음 값을 지킨다
  await prisma.violationType.upsert({
    where: { label },
    update: { active: true },
    create: { label, createdBy, sourceReportId },
  });
  return label;
}
