import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { notifyNewDevice } from './deviceService';

// 간편 비밀번호 — **기기에 묶인 6자리** (2026-08-16 사용자 확정 구조).
//
// ── 구조의 뼈대: 간편 로그인은 "휴면 상태의 앱을 깨우는 것"이다 ──────
// 풀 로그인(본인 인증)이 기기를 신뢰 목록에 올리고, 그 뒤로는 이 기기에서
// 생체(동의자, 우선) 또는 간편 비밀번호(필수, 폴백)로 깨운다.
//
// 서버가 인정하는 것은 **"이 기기에서 이 비밀번호"**이지 비밀번호 자체가 아니다:
//   · 비밀번호가 유출돼도 다른 기기에서는 못 쓴다 — 새 기기는 무조건 풀 로그인이다
//   · 앱을 지웠다 깔면 기기 토큰이 사라지므로 자연히 풀 로그인으로 돌아간다
//
// ── 6자리 숫자를 지키는 법 ──────────────────────────────────
// 조합이 100만 개뿐이라 두 가지가 없으면 장식이다:
//   ① 시도 상한 — 연속 5회 실패면 잠그고, 풀 로그인으로만 다시 연다
//   ② 느린 해시(scrypt) — DB가 새어도 전수조사가 비싸게 만든다
// 그리고 너무 뻔한 값(111111, 123456)은 애초에 못 정하게 막는다.

export class PinError extends Error {
  constructor(
    message: string,
    /** 화면이 분기한다 — 다시 시도할 수 있는지, 풀 로그인으로 가야 하는지 */
    readonly code: 'WRONG_PIN' | 'PIN_LOCKED' | 'UNKNOWN_DEVICE' | 'WEAK_PIN' | 'BAD_FORMAT',
  ) {
    super(message);
    this.name = 'PinError';
  }
}

/** @근거 설계 국내 금융앱 통용 자릿수 — 사용자가 이미 외우고 있는 형식을 그대로 쓴다 */
export const PIN_LENGTH = 6;

/**
 * 연속 실패 상한. 넘으면 잠그고 풀 로그인으로만 다시 연다.
 *
 * 6자리 숫자는 조합이 100만 개라, 상한이 없으면 자동화된 시도가 언젠가 맞춘다.
 * 5회면 손이 미끄러진 사람은 안 걸리고, 훑는 사람은 10만분의 1도 못 가 본다.
 *
 * @근거 설계 실수한 본인은 안 걸리고 훑는 공격은 10만분의 1도 못 가 보는 선
 */
export const MAX_PIN_ATTEMPTS = 5;

/** 기기 쿠키 토큰 — 난수 32바이트. DB에는 해시만 둔다 */
export function newDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashDeviceToken(token: string): string {
  // 토큰이 이미 난수라 빠른 해시로 충분하다 — 느린 해시는 사람이 기억하는 값에나 필요하다
  return createHash('sha256').update(token).digest('base64url');
}

function hashPin(pin: string, salt: Buffer): Buffer {
  return scryptSync(pin, salt, 32);
}

function serializePinHash(pin: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('base64url')}:${hashPin(pin, salt).toString('base64url')}`;
}

function verifyPinHash(pin: string, stored: string): boolean {
  const [saltB64, hashB64] = stored.split(':');
  if (!saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = hashPin(pin, Buffer.from(saltB64, 'base64url'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * 너무 뻔한 값은 못 정하게 한다 — 훑는 공격은 이런 값부터 넣는다.
 * 막는 것: 같은 숫자 반복(111111), 오름·내림 연속(123456·654321).
 */
export function isWeakPin(pin: string): boolean {
  if (new Set(pin).size === 1) return true;
  const digits = [...pin].map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const descending = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  return ascending || descending;
}

function assertPinFormat(pin: string): void {
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) {
    throw new PinError(`간편 비밀번호는 숫자 ${PIN_LENGTH}자리입니다`, 'BAD_FORMAT');
  }
  if (isWeakPin(pin)) {
    throw new PinError(
      '너무 추측하기 쉬운 번호입니다 — 같은 숫자 반복이나 연속된 숫자는 쓸 수 없습니다',
      'WEAK_PIN',
    );
  }
}

/**
 * 간편 비밀번호를 설정하고 이 기기를 신뢰 목록에 올린다.
 *
 * **부르는 쪽이 관문을 통과했어야 한다** (라우트에서 최근성 검사 — 방금 본인 인증한
 * 세션만). 여기는 순수하게 만들기만 한다.
 *
 * 같은 기기에서 다시 설정하면(oldDeviceToken) 옛 기록을 지운다 — 안 지우면 기기
 * 하나가 표에 줄을 계속 늘린다.
 */
export async function setupPin(
  prisma: PrismaClient,
  input: { userId: string; pin: string; label: string; oldDeviceToken?: string | null },
  now = new Date(),
): Promise<{ deviceToken: string }> {
  assertPinFormat(input.pin);

  if (input.oldDeviceToken) {
    await prisma.trustedDevice.deleteMany({
      where: { deviceTokenHash: hashDeviceToken(input.oldDeviceToken), userId: input.userId },
    });
  }

  const deviceToken = newDeviceToken();
  const created = await prisma.trustedDevice.create({
    data: {
      userId: input.userId,
      deviceTokenHash: hashDeviceToken(deviceToken),
      pinHash: serializePinHash(input.pin),
      label: input.label.trim().slice(0, 40) || '내 기기',
      createdAt: now,
    },
  });
  // 기존 기기들에 알린다 — 유심을 가로챈 쪽이 심은 것이라면 이 알림이 유일한 신호다
  await notifyNewDevice(prisma, { userId: input.userId, label: created.label, kind: 'PIN' }, now);
  return { deviceToken };
}

/**
 * 간편 로그인 — 기기 토큰과 비밀번호가 **함께** 맞아야 한다.
 *
 * 실패 문구는 남은 횟수를 알려준다. 본인이 손이 미끄러진 경우가 대부분이라,
 * 몇 번 남았는지 모르면 불안해서 풀 로그인으로 도망가게 된다 — 그러면 간편
 * 로그인을 만든 의미가 없다.
 */
export async function verifyPinLogin(
  prisma: PrismaClient,
  input: { deviceToken: string; pin: string },
  now = new Date(),
): Promise<{ userId: string }> {
  const device = await prisma.trustedDevice.findUnique({
    where: { deviceTokenHash: hashDeviceToken(input.deviceToken) },
  });
  if (!device) throw new PinError('이 기기에서는 간편 로그인을 쓸 수 없습니다', 'UNKNOWN_DEVICE');
  if (device.lockedAt) {
    throw new PinError(
      '간편 비밀번호가 잠겼습니다 — 본인 인증으로 로그인하면 다시 설정할 수 있습니다',
      'PIN_LOCKED',
    );
  }

  if (!verifyPinHash(input.pin, device.pinHash)) {
    const attempts = device.failedAttempts + 1;
    const locked = attempts >= MAX_PIN_ATTEMPTS;
    await prisma.trustedDevice.update({
      where: { id: device.id },
      data: { failedAttempts: attempts, ...(locked ? { lockedAt: now } : {}) },
    });
    if (locked) {
      // 잠긴 것을 **본인에게 알린다** — 손이 미끄러진 것일 수도, 누가 훑는 것일 수도
      // 있다. 어느 쪽인지는 본인만 안다
      await prisma.notification.create({
        data: {
          userId: device.userId,
          type: 'PIN_LOCKED',
          title: '간편 비밀번호가 잠겼습니다',
          body:
            `"${device.label}"에서 간편 비밀번호가 ${MAX_PIN_ATTEMPTS}회 연속 틀려 잠겼습니다.\n` +
            '본인이라면 본인 인증으로 로그인해 다시 설정하시면 됩니다.\n' +
            '**본인이 아니라면 누군가 이 기기를 쥐고 있다는 뜻입니다 — 정산을 동결해주세요.**',
          link: '/settings/payout',
          createdAt: now,
        },
      });
      throw new PinError(
        '간편 비밀번호가 잠겼습니다 — 본인 인증으로 로그인하면 다시 설정할 수 있습니다',
        'PIN_LOCKED',
      );
    }
    throw new PinError(
      `비밀번호가 틀렸습니다 (${MAX_PIN_ATTEMPTS - attempts}회 남음)`,
      'WRONG_PIN',
    );
  }

  await prisma.trustedDevice.update({
    where: { id: device.id },
    data: { failedAttempts: 0, lastUsedAt: now },
  });
  return { userId: device.userId };
}

/** 이 기기가 이 사용자의 신뢰 기기인가 — 풀 로그인 응답이 "간편 비밀번호 설정 필요"를 판단할 때 쓴다 */
export async function isTrustedDevice(
  prisma: PrismaClient,
  userId: string,
  deviceToken: string | undefined,
): Promise<boolean> {
  if (!deviceToken) return false;
  const device = await prisma.trustedDevice.findUnique({
    where: { deviceTokenHash: hashDeviceToken(deviceToken) },
    select: { userId: true, lockedAt: true },
  });
  // 잠긴 기기는 "설정이 필요한 기기"다 — 풀 로그인을 했으니 다시 정하게 한다
  return device?.userId === userId && device.lockedAt === null;
}
