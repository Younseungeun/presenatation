import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { addToCart, getCart, removeFromCart } from '@/server/cartService';
import { prisma } from '@/server/db';
import { requireUserId, toErrorResponse } from '../_lib/http';

const addSchema = z.object({ reportId: z.string().min(1) });
const removeSchema = z.object({ reportId: z.string().min(1) });

/** 장바구니 조회 */
export async function GET() {
  try {
    const userId = await requireUserId();
    return NextResponse.json(await getCart(prisma, userId));
  } catch (e) {
    return toErrorResponse(e);
  }
}

/** 장바구니 담기 */
export async function POST(req: NextRequest) {
  try {
    const userId = await requireUserId();
    const { reportId } = addSchema.parse(await req.json());
    await addToCart(prisma, userId, reportId);
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}

/** 장바구니에서 빼기 */
export async function DELETE(req: NextRequest) {
  try {
    const userId = await requireUserId();
    const { reportId } = removeSchema.parse(await req.json());
    await removeFromCart(prisma, userId, reportId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return toErrorResponse(e);
  }
}
