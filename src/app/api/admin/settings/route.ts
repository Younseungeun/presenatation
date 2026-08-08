import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { SETTING_KEYS, setBooleanSetting, type SettingKey } from '@/server/appSettings';
import { prisma } from '@/server/db';
import { requireOperatorId, toErrorResponse } from '../../_lib/http';

// 운영 설정 토글 — 운영자만. 배포 없이 켜고 끌 수 있어야 "지금 끄고 싶다"에 대응한다.

const ALLOWED = Object.values(SETTING_KEYS) as string[];

const bodySchema = z.object({
  key: z.string().refine((k) => ALLOWED.includes(k), '알 수 없는 설정입니다'),
  value: z.boolean(),
});

export async function PATCH(req: NextRequest) {
  try {
    const operatorId = await requireOperatorId(prisma);
    const { key, value } = bodySchema.parse(await req.json());
    await setBooleanSetting(prisma, key as SettingKey, value, operatorId);
    return NextResponse.json({ key, value });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: e.issues[0]?.message ?? '입력 형식 오류' }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
