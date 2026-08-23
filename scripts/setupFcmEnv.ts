// 파이어베이스 서비스 계정 JSON → .env 세 줄.
//
// **값이 사람 손이나 채팅을 거치지 않게 하려고** 만든 스크립트다. 비공개 키는 여러 줄
// PEM이라 손으로 옮기면 줄바꿈이 깨지고, 깨진 키는 "인증 실패"라는 애매한 오류만 낸다.
// 파일에서 바로 읽어 `\n`으로 접어 넣으면 그 실수가 원천적으로 없다.
//
// 실행: npm run setup:fcm -- "C:\Users\jooyon\Desktop\fcm-key.json"
//
// ⚠ JSON 파일을 저장소 안에 두지 말 것 — 한 번 커밋되면 이력에서 지워지지 않는다.
//   이 스크립트는 파일을 옮기거나 지우지 않는다(사용자가 직접 지우도록).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const KEYS = ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY'] as const;

function fail(msg: string): never {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const jsonPath = process.argv[2];
if (!jsonPath) {
  fail(
    '서비스 계정 JSON 경로를 넘겨주세요.\n' +
      '  예: npm run setup:fcm -- "C:\\Users\\jooyon\\Desktop\\fcm-key.json"',
  );
}
if (!existsSync(jsonPath)) fail(`파일을 찾을 수 없습니다: ${jsonPath}`);

let parsed: Record<string, unknown>;
try {
  parsed = JSON.parse(readFileSync(jsonPath, 'utf8'));
} catch {
  fail('JSON을 읽지 못했습니다 — 파이어베이스에서 받은 파일이 맞는지 확인해 주세요.');
}

const projectId = parsed.project_id;
const clientEmail = parsed.client_email;
const privateKey = parsed.private_key;
if (typeof projectId !== 'string' || typeof clientEmail !== 'string' || typeof privateKey !== 'string') {
  fail(
    '이 파일에는 project_id·client_email·private_key가 없습니다.\n' +
      '  파이어베이스 콘솔 → 프로젝트 설정 → 서비스 계정 → "새 비공개 키 생성"으로 받은 파일이어야 합니다.',
  );
}
if (!privateKey.includes('BEGIN PRIVATE KEY')) {
  fail('private_key 형식이 예상과 다릅니다 — 파일이 잘렸을 수 있습니다.');
}

// .env는 한 줄 = 한 값이라 PEM의 실제 줄바꿈을 `\n` 두 글자로 접는다.
// FcmPushProvider 생성자가 이것을 되돌린다 (그쪽 주석 참고)
const folded = privateKey.replace(/\r?\n/g, '\\n');
const values: Record<string, string> = {
  FCM_PROJECT_ID: projectId,
  FCM_CLIENT_EMAIL: clientEmail,
  FCM_PRIVATE_KEY: folded,
};

const envPath = resolve(process.cwd(), '.env');
const before = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
let after = before;
const updated: string[] = [];
const added: string[] = [];

for (const key of KEYS) {
  // 값에 따옴표를 씌운다 — PEM에는 `/`·`+`가 섞이고 이메일에는 `@`가 있다
  const line = `${key}="${values[key]}"`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(after)) {
    after = after.replace(re, line);
    updated.push(key);
  } else {
    if (after.length > 0 && !after.endsWith('\n')) after += '\n';
    after += `${line}\n`;
    added.push(key);
  }
}

writeFileSync(envPath, after, 'utf8');

// **값은 절대 찍지 않는다** — 터미널 기록도 유출 경로다. 있다/없다만 말한다
console.log('\n✔ .env에 넣었습니다.');
if (added.length > 0) console.log(`  추가: ${added.join(', ')}`);
if (updated.length > 0) console.log(`  갱신: ${updated.join(', ')}`);
console.log(`\n  프로젝트: ${projectId}`);
console.log(`  서비스 계정: ${clientEmail.replace(/^(.{6}).*(@.*)$/, '$1…$2')}`);
console.log(`  비공개 키: 길이 ${privateKey.length}자 — 값은 찍지 않습니다`);
console.log(
  '\n다음: ① 스케줄러를 다시 시작하면 푸시가 켜집니다 (npm run scheduler)\n' +
    `      ② 받으신 JSON 파일(${jsonPath})은 이제 지우셔도 됩니다\n`,
);
