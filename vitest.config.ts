import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // 통합 테스트들이 각자 임시 SQLite에 `prisma migrate deploy`를 실행하는데,
    // 병렬 실행 시 prisma CLI 경합으로 간헐 실패 → 파일 순차 실행으로 제거
    fileParallelism: false,
  },
});
