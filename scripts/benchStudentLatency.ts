import { readFileSync } from 'node:fs';
import { createStudentClientFromEnv } from '../src/infra/compliance/studentClient';
import type { ScreeningInput } from '../src/domain/compliance';

// **운영 길이 지연 벤치마크** (32차 II-4 (a) — 창 배치 추론 전후 실측).
//
// ≈700tk 문서 100건(DART 정상 산문 조합, 문서마다 다른 조각 + 위반 꼬리 1/4 회전)을
// 같은 클라이언트 경로(client.screen — 통짜 + 창)로 돌려 벽시계 지연의 P50/P95/P99 를
// 잰다. STUDENT_WINDOW_BATCH=0(낱개 순차) vs 1(배치)을 **같은 문서 셋**으로 비교하고,
// 두 모드의 소견이 문서 단위로 동일한지도 대조한다 — 빨라졌는데 판정이 달라졌으면
// 그것은 최적화가 아니라 다른 검수기다.
//
//   STUDENT_SIDECAR_URL=http://127.0.0.1:8766 npx tsx scripts/benchStudentLatency.ts

const TAILS: { label: string; text: string }[] = [
  { label: 'PRIVATE_INFO', text: '기관 매수 주문 내역을 비공개 경로로 입수했습니다. 내일 대량 매수 들어옵니다.' },
  { label: 'RUMOR', text: '증권가 찌라시에 따르면 이 회사가 곧 유상증자를 철회한다고 합니다. 소문이 사실이면 급등입니다.' },
  { label: 'SOLICIT_CONTACT', text: '카카오톡 오픈채팅으로 연락 주시면 종목 비밀 정보를 일대일로 알려드립니다.' },
  { label: 'PROFIT_GUARANTEE', text: '이 자리는 무조건 오르는 자리라 손실이 나면 제가 전액 물어드리겠습니다.' },
];
const DOCS = 100;
const TARGET_CHARS = 1400; // 토큰 ≈ 글자/2 → ≈700tk (probeWindowCap 와 같은 근사)

function input(content: string): ScreeningInput {
  return { title: '', summary: '', content, assetClass: 'KR_EQUITY', assetName: '', direction: 'UP' } as ScreeningInput;
}

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
}

async function main() {
  const dart = readFileSync('training/holdout/control-dart-clean.jsonl', 'utf-8')
    .split('\n').filter(Boolean)
    .map((l) => (JSON.parse(l) as { text: string }).text)
    .filter((t) => t.length > 120);
  // 문서마다 다른 산문 조합 — 같은 문서 100번이면 캐시·분산이 다 가려진다
  const docs: string[] = [];
  for (let d = 0; d < DOCS; d += 1) {
    let p = '';
    for (let i = d * 3; p.length < TARGET_CHARS; i += 1) p += dart[i % dart.length] + ' ';
    docs.push(p + TAILS[d % TAILS.length]!.text);
  }

  const url = process.env.STUDENT_SIDECAR_URL ?? 'http://127.0.0.1:8766';
  const results: Record<string, { ms: number[]; findings: string[] }> = {};
  for (const mode of ['0', '1'] as const) {
    process.env.STUDENT_WINDOW_BATCH = mode;
    const client = createStudentClientFromEnv({
      STUDENT_SIDECAR_URL: url, STUDENT_THRESHOLD: '0.7', STUDENT_MODEL_TAG: `bench${mode}`,
    } as unknown as NodeJS.ProcessEnv)!;
    const ms: number[] = [];
    const findings: string[] = [];
    for (const doc of docs) {
      const t0 = performance.now();
      const r = await client.screen(input(doc));
      ms.push(performance.now() - t0);
      findings.push((r?.findings ?? []).map((f) => f.category).sort().join(','));
    }
    results[mode] = { ms, findings };
    const name = mode === '0' ? '낱개 순차' : '창 배치  ';
    console.log(
      `${name} — ${DOCS}건 · P50 ${Math.round(pct(ms, 0.5))}ms · P95 ${Math.round(pct(ms, 0.95))}ms · ` +
      `P99 ${Math.round(pct(ms, 0.99))}ms · max ${Math.round(pct(ms, 1))}ms`,
    );
  }
  const diff = results['0']!.findings.filter((f, i) => f !== results['1']!.findings[i]).length;
  console.log(`판정 동일성: ${DOCS}건 중 불일치 ${diff}건 ${diff === 0 ? '✓' : '✗ — 배치가 판정을 바꿨다'}`);
  if (diff > 0) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
