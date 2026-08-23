import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// **학생 모델 승격 — 원자적** (28차 EE-3: 당직 감지 폐기 → 승격 자체를 트랜잭션으로).
//
//   npm run student:promote -- <sha 앞 8~16자>
//
// 한 번의 실행이 ① 보관본 지문 검증 → ② 현행 deployed 백업 → ③ 복사 → ④ 작업 재기동
// → ⑤ /health 지문 대조 를 전부 마치거나, 어느 단계든 실패하면 **②로 되돌리고 재기동**한다.
// "파일만 바뀌고 재기동은 안 된 상태"(2026-08-22 실사고의 모양)를 만들 수 없게 하는 것이
// 목적이다 — 사고가 난 뒤 경보를 울리는 당직으로는 막지 못한다(검토자 판정).
//
// 반증 조건(검토자): 실행 도중 프로세스를 죽였을 때 사이드카가 구버전을 유지하지 못하면
// 원자성이 깨진 것이다. 그래서 복사 전에 백업을 먼저 만들고, 재기동은 마지막에 한다 —
// 중간에 죽으면 deployed 는 새 파일이지만 사이드카 메모리는 구버전이고(model_stale=true
// 로 usable 이 막음), 다음 실행이 백업으로 되돌릴 수 있다.

const TASK = 'intovill-student-sidecar';
const HEALTH = process.env.STUDENT_SIDECAR_URL ?? 'http://127.0.0.1:8765';
// 토크나이저 파일을 **반드시** 함께 옮긴다 (회신 10호 §1 실사고). 없으면 사이드카가 기본
// 토크나이저(local_models/student-base)로 폴백하고, 지문이 학습값과 갈려 usable() 이 거부 →
// 게시 전건 보류. /health 세 항목(ready·sha·stale)은 전부 통과하므로 눈으로는 못 본다.
const TOKENIZER_FILES = ['tokenizer.json', 'tokenizer_config.json', 'vocab.txt', 'special_tokens_map.json'];
const FILES = ['model.onnx', 'config.json', 'canary.json', ...TOKENIZER_FILES];

function sha16(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);
}

function schtasks(verb: 'end' | 'run'): void {
  // Windows 작업 스케줄러 — 당직(watchdog)이 자식 사이드카의 부모라 작업을 끝내면 둘 다 내려간다
  execFileSync('schtasks', [`/${verb}`, '/tn', TASK], { stdio: 'ignore' });
}

async function waitHealthy(expectSha: string, ms = 90_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const h = (await (await fetch(`${HEALTH}/health`)).json()) as {
        ready?: boolean; model_sha?: string; model_stale?: boolean;
        tokenizer_sha?: string; trained_tokenizer_sha?: string | null;
      };
      // usable() 이 보는 조건과 같아야 한다 — 토크나이저 지문이 갈리면 웹은 이 사이드카를 거부한다
      const tokOk = !h.trained_tokenizer_sha || h.trained_tokenizer_sha === h.tokenizer_sha;
      if (h.ready && !h.model_stale && h.model_sha === expectSha && tokOk) return true;
    } catch {
      /* 아직 안 떴다 */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

function copyAll(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of FILES) if (existsSync(join(from, name))) copyFileSync(join(from, name), join(to, name));
}

async function main() {
  const want = process.argv[2];
  if (!want) {
    console.log('사용: npm run student:promote -- <sha>');
    process.exitCode = 1;
    return;
  }
  const archiveDir = join('training', 'out', 'archive', want);
  const deployed = join('training', 'out', 'deployed');
  const backup = join('training', 'out', 'deployed.prev');

  // ① 보관본 검증 — 이름과 내용의 지문이 같아야 한다
  if (!existsSync(join(archiveDir, 'model.onnx'))) {
    console.log(`✗ 보관본이 없습니다: ${archiveDir}`);
    process.exitCode = 1;
    return;
  }
  const sha = sha16(join(archiveDir, 'model.onnx'));
  if (!TOKENIZER_FILES.some((n) => existsSync(join(archiveDir, n)))) {
    console.log(
      `✗ 보관본에 토크나이저 파일이 없습니다: ${archiveDir} — 이대로 올리면 사이드카가 기본 토크나이저로 폴백해 지문이 갈립니다 (usable:false · 게시 전건 보류). 학습 산출물 out/student 의 tokenizer*.json 을 보관본에 넣은 뒤 다시 실행하십시오`,
    );
    process.exit(1);
  }
  if (!sha.startsWith(want.slice(0, 8))) {
    console.log(`✗ 보관본 내용 지문(${sha})이 이름(${want})과 다릅니다 — 손상 의심`);
    process.exitCode = 1;
    return;
  }

  // ② 현행 백업 — 되돌릴 곳을 먼저 만든다
  const hadPrev = existsSync(join(deployed, 'model.onnx'));
  if (hadPrev) {
    rmSync(backup, { recursive: true, force: true });
    copyAll(deployed, backup);
    console.log(`② 백업: 현행 ${sha16(join(deployed, 'model.onnx'))} → deployed.prev`);
  }

  // ③ 복사 → ④ 재기동 → ⑤ 대조. 실패하면 백업으로 되돌리고 다시 재기동
  try {
    copyAll(archiveDir, deployed);
    console.log(`③ 복사: ${sha} → out/deployed`);
    schtasks('end');
    await new Promise((r) => setTimeout(r, 3000));
    schtasks('run');
    console.log('④ 작업 재기동');
    const ok = await waitHealthy(sha);
    if (!ok) throw new Error('/health 가 새 지문으로 준비되지 않았습니다 (90초)');
    console.log(`⑤ 확인: 라이브가 ${sha} 를 적재 — 승격 완료`);
    // ⑥ 승격 기록 — 화면이 적재 지문과 대조할 유일한 근거 (인계서 §3). ⑤ 뒤에 쓴다:
    // 기록이 먼저 생기고 재기동이 실패하면 "기록은 새 지문, 라이브는 옛 지문"이 된다
    const { prisma } = await import('../src/server/db');
    const { SETTING_KEYS } = await import('../src/server/appSettings');
    await prisma.appSetting.upsert({
      where: { key: SETTING_KEYS.studentPromoted },
      create: { key: SETTING_KEYS.studentPromoted, value: JSON.stringify({ sha, at: new Date().toISOString() }) },
      update: { value: JSON.stringify({ sha, at: new Date().toISOString() }) },
    });
    console.log('⑥ 승격 기록 저장 (AppSetting student.promoted)');
    rmSync(backup, { recursive: true, force: true });
  } catch (e) {
    console.log(`✗ 승격 실패: ${(e as Error).message}`);
    if (hadPrev) {
      copyAll(backup, deployed);
      try {
        schtasks('end');
        await new Promise((r) => setTimeout(r, 3000));
        schtasks('run');
      } catch {
        /* 재기동 자체가 막히면 당직이 다음 부팅에 세운다 — 파일은 이미 구버전이다 */
      }
      const prev = sha16(join(deployed, 'model.onnx'));
      const back = await waitHealthy(prev);
      console.log(back ? `↩ 롤백: 라이브가 구버전 ${prev} 로 복귀` : `↩ 롤백 파일 복구 — 라이브 확인은 사람이 (${HEALTH}/health)`);
    }
    process.exitCode = 1;
  }
}
main();
