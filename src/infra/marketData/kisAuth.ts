import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// KIS 계정 관문 — **토큰과 호출 간격을 앱키 단위로 공유한다.**
//
// 시세 조회 로직(kisProvider)과 분리한 이유: 여기서 지키는 것은 시세가 아니라
// **계정의 제약**이다. 국내·미국 인스턴스를 따로 두더라도 KIS의 제한은 인스턴스가
// 아니라 계정 기준이라, 이 파일이 그 경계를 그대로 표현한다.
//
// ① 토큰 발급은 분당 1회 — 인스턴스마다 발급하면 두 번째가 막힌다.
//    게다가 배치는 각각 별도 프로세스라 메모리 캐시가 공유되지 않아, 연달아 돌리면
//    두 번째부터 전부 403으로 죽는다. 그래서 **파일에도 남겨 프로세스 사이에서 재사용**한다.
// ② 초당 호출 제한 — 연속 호출은 절반이 "초당 거래건수 초과"로 떨어진다.
//    실측: 0ms 5/10, 300ms 7/10, 600ms 7/10, **1100ms 10/10**. 그래서 직렬화한다.

/** 실측으로 정한 최소 호출 간격 — 1000ms에서는 간헐적으로 밀린다 */
export const MIN_CALL_GAP_MS = 1_100;

/** 토큰 만료 여유 — 경계에서 만료된 토큰을 쓰지 않도록 일찍 갱신한다 */
export const TOKEN_SAFETY_MS = 10 * 60_000;

export interface KisToken {
  value: string;
  expiresAt: number;
}

export interface SharedGate {
  token: KisToken | null;
  issuing: Promise<string> | null;
  lastCallAt: number;
  queue: Promise<unknown>;
}

/** 앱키 하나당 게이트 하나 — 같은 계정의 모든 인스턴스가 토큰과 호출 간격을 나눠 쓴다 */
const GATES = new Map<string, SharedGate>();

export function sharedGate(appKey: string): SharedGate {
  let g = GATES.get(appKey);
  if (!g) {
    g = { token: null, issuing: null, lastCallAt: 0, queue: Promise.resolve() };
    GATES.set(appKey, g);
  }
  return g;
}

// ── 토큰 파일 캐시 ───────────────────────────────────────────
//
// 위치는 OS 임시 폴더 — 저장소에 남기지 않는다(토큰은 24시간짜리 비밀이다).
// 파일명에 앱키 해시를 넣어 계정이 바뀌면 자동으로 다른 파일이 된다.
//
// **한계**: 서버를 여러 대로 늘리면 대수만큼 발급이 나가 분당 1회에 걸린다.
// 그때는 이 자리를 공용 저장소(DB·Redis)로 바꿔야 한다 — 지금은 단일 인스턴스 전제.
function tokenFilePath(appKey: string): string {
  let h = 0;
  for (let i = 0; i < appKey.length; i++) h = (h * 31 + appKey.charCodeAt(i)) | 0;
  return path.join(os.tmpdir(), `kis-token-${(h >>> 0).toString(36)}.json`);
}

export function readTokenFile(appKey: string): KisToken | null {
  try {
    const t = JSON.parse(fs.readFileSync(tokenFilePath(appKey), 'utf8')) as KisToken;
    return typeof t.value === 'string' && typeof t.expiresAt === 'number' ? t : null;
  } catch {
    return null;
  }
}

export function writeTokenFile(appKey: string, token: KisToken): void {
  try {
    fs.writeFileSync(tokenFilePath(appKey), JSON.stringify(token), { mode: 0o600 });
  } catch {
    // 파일을 못 써도 동작은 한다 — 메모리 캐시로 이 프로세스 안에서는 재사용된다
  }
}
