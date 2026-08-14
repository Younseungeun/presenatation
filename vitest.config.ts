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
          // DB를 안 쓰므로 병렬로 돈다 — 이 갈래의 존재 이유가 이것이다
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'db',
          include: ['src/**/*.db.test.ts'],
          environment: 'node',
          // 각자 임시 DB에 `prisma migrate deploy`를 실행하는데, 병렬로 돌리면
          // prisma CLI 경합으로 간헐 실패한다 → 파일 순차 실행으로 제거
          fileParallelism: false,
        },
      },
    ],
  },
});
