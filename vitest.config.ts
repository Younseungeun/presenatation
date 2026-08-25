import path from 'node:path';
import { defineConfig } from 'vitest/config';

// **테스트를 두 갈래로 나눈다 — 속도가 아니라 사람의 습관 때문이다.**
//
// 피드백 루프가 10초를 넘으면 사람은 로컬에서 테스트를 안 돌리고 CI에 미룬다.
// 그러면 "전부 컨테이너를 요구한다"는 엄격함이 오히려 **테스트를 덜 돌리게** 만든다.
// 그래서 개발 중 반복은 순수 테스트(DB 없음)만 돌리고, 전체는 push·CI에서 강제한다.
//
// 갈래는 **파일 이름**이 정한다(`*.db.test.ts`). 목록으로 관리하면 새 테스트가
// 조용히 잘못된 쪽에 들어가지만, 이름이면 파일을 열기 전에 보인다 —
// 그리고 새로 쓰는 사람이 옆 파일을 복사하면 규칙이 저절로 따라온다.
const alias = { '@': path.resolve(__dirname, 'src') };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['**/*.db.test.ts', '**/node_modules/**'],
          environment: 'node',
          setupFiles: ['src/__tests__/setup/studentOff.ts'],
          // DB를 안 쓰므로 병렬로 돈다 — 이 갈래의 존재 이유가 이것이다
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'db',
          include: ['src/**/*.db.test.ts'],
          environment: 'node',
          setupFiles: ['src/__tests__/setup/studentOff.ts'],
          // 각자 임시 DB에 `prisma migrate deploy`를 실행하는데, 병렬로 돌리면
          // prisma CLI 경합으로 간헐 실패한다 → 파일 순차 실행으로 제거
          fileParallelism: false,
          /**
           * **`beforeAll` 이 마이그레이션을 돌린다 — 기본 10초로는 모자란다** (2026-08-25).
           *
           * `createTestDb` 는 `npx prisma migrate deploy` 를 동기로 부른다: npx 기동 +
           * 86개 마이그레이션 적용이라 혼자 돌아도 5~8초고, 파일이 61개라 뒤로 갈수록
           * 디스크가 바빠져 10초를 넘긴다. 그러면 vitest 가 훅을 끊고 **그 파일의 시험
           * 전체를 skip** 한다.
           *
           * 이것이 오늘 하루 "간헐 실패"의 정체였다. 화면에 뜨는 것은 `12 tests | 12
           * skipped` 뿐이라 **시험이 깨진 것처럼 보이는데 실제로는 시간이 모자란 것**이고,
           * 두 세션이 각각 마이그레이션·파일 이름을 의심하며 시간을 썼다. 어제
           * `pipelineCollision` 이 5초 문턱을 5.5초로 넘던 것과 같은 모양이다 —
           * **문턱이 실제 소요 시간에 너무 가까우면 실패가 원인을 거짓으로 말한다.**
           *
           * 재는 것은 속도가 아니라 동작이므로 시간에는 넉넉히 준다.
           */
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
