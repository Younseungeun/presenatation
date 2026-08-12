import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

// SQLite 백업.
//
// 왜 파일 복사가 아닌가: 실행 중인 DB 파일을 그냥 복사하면 쓰기 도중의 페이지를 함께
// 떠서 열리지 않는 파일이 나올 수 있다(스케줄러가 상시 쓰고 있으므로 실제로 겹친다).
// **VACUUM INTO는 SQLite가 트랜잭션 경계에서 일관된 스냅샷을 새 파일로 써 준다** —
// 잠금을 오래 잡지 않고, 조각도 정리해서 원본보다 작게 나온다.
//
// 뜬 파일은 **열어서 검증한다.** 검증 없는 백업은 복구를 시도하는 순간에야
// 망가진 걸 알게 되는데, 그때는 이미 원본이 없다.

/** 이 개수만 남기고 오래된 것부터 지운다 */
export const BACKUP_KEEP = 14;

export interface BackupResult {
  file: string;
  bytes: number;
  /** 검증으로 읽은 리포트 수 — 0이면 빈 백업을 의심해야 한다 */
  reports: number;
  removed: number;
}

/** DATABASE_URL이 가리키는 SQLite 파일의 절대 경로 (SQLite가 아니면 null) */
export function resolveSqlitePath(url = process.env.DATABASE_URL): string | null {
  if (!url?.startsWith('file:')) return null;
  const raw = url.slice('file:'.length);
  // Prisma는 상대 경로를 schema.prisma 위치(prisma/) 기준으로 푼다
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), 'prisma', raw);
}

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}`
  );
}

/** 백업 파일을 실제로 열어 읽는다 — 여기서 실패하면 백업이 아니라 쓰레기다 */
async function verify(file: string): Promise<number> {
  const client = new PrismaClient({ datasourceUrl: `file:${file}` });
  try {
    const rows = await client.$queryRawUnsafe<{ integrity_check: string }[]>(
      'PRAGMA integrity_check',
    );
    const verdict = rows[0]?.integrity_check;
    if (verdict !== 'ok') throw new Error(`무결성 검사 실패: ${verdict ?? '응답 없음'}`);
    return await client.report.count();
  } finally {
    await client.$disconnect();
  }
}

/**
 * 백업 1회.
 *
 * @param dir  기본 `backups/` — DB와 같은 디스크에 두면 디스크가 죽을 때 함께 죽는다.
 *             `DB_BACKUP_DIR`로 다른 드라이브·동기화 폴더를 지정하는 편이 낫다.
 */
export async function backupDatabase(
  now = new Date(),
  dir = process.env.DB_BACKUP_DIR ?? path.resolve(process.cwd(), 'backups'),
  keep = BACKUP_KEEP,
): Promise<BackupResult> {
  const source = resolveSqlitePath();
  if (!source) throw new Error('SQLite가 아닌 DATABASE_URL — 이 백업 방식은 쓸 수 없습니다');
  if (!existsSync(source)) throw new Error(`DB 파일이 없습니다: ${source}`);

  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `dev-${stamp(now)}.db`);
  if (existsSync(file)) unlinkSync(file); // 같은 분에 두 번 — 덮어쓴다

  const client = new PrismaClient();
  try {
    // SQLite는 윈도우에서도 슬래시를 받는다. 경로에 홑따옴표가 있으면 두 번 쓴다
    await client.$executeRawUnsafe(`VACUUM INTO '${file.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  } finally {
    await client.$disconnect();
  }

  const reports = await verify(file);

  // 검증을 통과한 백업만 세어서 회전시킨다
  const olds = readdirSync(dir)
    .filter((f) => f.startsWith('dev-') && f.endsWith('.db'))
    .map((f) => path.join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(keep);
  for (const old of olds) unlinkSync(old);

  return { file, bytes: statSync(file).size, reports, removed: olds.length };
}
