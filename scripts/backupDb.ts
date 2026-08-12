import 'dotenv/config';
import { backupDatabase } from '../src/server/dbBackup';

// DB 백업 CLI — npm run db:backup
// 규칙·근거는 src/server/dbBackup.ts에 있다 (스케줄러도 같은 함수를 부른다).

async function main() {
  const r = await backupDatabase();
  console.log(
    `백업 완료 ${r.file} — ${(r.bytes / 1_048_576).toFixed(1)}MB / 리포트 ${r.reports}건 검증` +
      (r.removed > 0 ? ` / 오래된 백업 ${r.removed}개 삭제` : ''),
  );
}

main().catch((e) => {
  console.error('백업 실패:', e);
  process.exitCode = 1;
});
