import { readFileSync } from 'node:fs';
import { createStudentClientFromEnv } from '../src/infra/compliance/studentClient';
import type { ScreeningInput } from '../src/domain/compliance';

// **운영 분포 지연 벤치마크** (32차 II-4 (a) 창 묶음 실측 → 33차 JJ-2 분포 정의 확정).
//
// **판정 기준은 운영 분포 P95 다** (docs/model-swap-rule.md "지연 예산의 정의").
// 기본 = 출시 전 대리 분포(300tk 50% · 500tk 30% · 700tk 20%, 33차 검토자 제시 —
// 첫 주 운영 실측 분포로 교체). `--worst` = 최악 길이(700tk) 100% — 회귀 추적용으로
// 남긴 32차 측정 모드이고 판정 기준이 아니다.
//
// 문서 100건(DART 정상 산문 조합, 문서마다 다른 조각 + 위반 꼬리 1/4 회전)을 같은
// 클라이언트 경로(client.screen — 통짜 + 창)로 돌려 벽시계 P50/P95/P99 를 잰다.
// STUDENT_WINDOW_BATCH=0(낱개 순차) vs 1(묶음)을 **같은 문서 셋**으로 비교하고, 두
// 모드의 소견이 문서 단위로 동일한지도 대조한다 — 빨라졌는데 판정이 달라졌으면
// 그것은 최적화가 아니라 다른 검수기다.
//
//   STUDENT_SIDECAR_URL=http://127.0.0.1:8766 npx tsx scripts/benchStudentLatency.ts [--worst]

const TAILS: { label: string; text: string }[] = [
  { label: 'PRIVATE_INFO', text: '기관 매수 주문 내역을 비공개 경로로 입수했습니다. 내일 대량 매수 들어옵니다.' },
  { label: 'RUMOR', text: '증권가 찌라시에 따르면 이 회사가 곧 유상증자를 철회한다고 합니다. 소문이 사실이면 급등입니다.' },
  { label: 'SOLICIT_CONTACT', text: '카카오톡 오픈채팅으로 연락 주시면 종목 비밀 정보를 일대일로 알려드립니다.' },
  { label: 'PROFIT_GUARANTEE', text: '이 자리는 무조건 오르는 자리라 손실이 나면 제가 전액 물어드리겠습니다.' },
];
const DOCS = 100;
// 토큰 ≈ 글자/2 (probeWindowCap 와 같은 근사). 운영 대리 분포는 33차 JJ-2 제시값 —
// 누적 비율로 채워 100건 중 정확히 50/30/20건이 되게 한다 (무작위 표집이면 회차마다 셋이 달라진다)
const WORST = process.argv.includes('--worst');
const MIX: { chars: number; share: number }[] = WORST
  ? [{ chars: 1400, share: 1 }]
  : [{ chars: 600, share: 0.5 }, { chars: 1000, share: 0.3 }, { chars: 1400, share: 0.2 }];

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
  // 문서마다 다른 산문 조합 — 같은 문서 100번이면 캐시·분산이 다 가려진다.
  // 길이는 대리 분포대로 섞고, 섞은 순서(교차 배치)로 돌린다 — 길이별로 몰아 돌리면
  // CPU 온도·부하 추세가 특정 길이 구간에만 실려 분포 P95 가 왜곡된다
  const docs: string[] = [];
  for (let d = 0; d < DOCS; d += 1) {
    const r = (d % 10) / 10; // 0.0~0.9 순환 — 10건 단위로 분포 비율이 정확히 재현된다
    let acc = 0;
    let chars = MIX[MIX.length - 1]!.chars;
    for (const m of MIX) {
      acc += m.share;
      if (r < acc) { chars = m.chars; break; }
    }
    let p = '';
    for (let i = d * 3; p.length < chars; i += 1) p += dart[i % dart.length] + ' ';
    docs.push(p + TAILS[d % TAILS.length]!.text);
  }
  const label = WORST ? '최악 길이 700tk 100%' : '운영 대리 분포 300/500/700tk = 50/30/20%';
  console.log(`문서 ${DOCS}건 · ${label}`);

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
