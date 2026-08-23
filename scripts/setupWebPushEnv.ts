// VAPID 열쇠 한 쌍을 만들어 .env에 넣는다.
//
// **콘솔에서 받아 올 값이 없다** — 이 열쇠는 우리가 만드는 것이라, 웹 푸시는
// 외부 계정 없이 오늘 바로 켤 수 있다. 공개키는 브라우저에 나가고(구독할 때 필요)
// 비공개키는 서버에만 남는다.
//
// ⚠ **한 번 만들면 바꾸지 않는다.** 바꾸면 이미 구독한 브라우저들이 전부 무효가 되고,
//    그 사람들은 알림이 조용히 끊긴 것을 모른다. 이미 있으면 덮어쓰지 않는 이유다.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import webpush from 'web-push';

const envPath = resolve(process.cwd(), '.env');
const before = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';

if (/^VAPID_PUBLIC_KEY=/m.test(before)) {
  console.log('\n이미 VAPID 열쇠가 있습니다 — 덮어쓰지 않습니다.');
  console.log('바꾸면 기존 구독이 전부 무효가 되고, 그 사람들은 알림이 끊긴 줄 모릅니다.\n');
  process.exit(0);
}

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
let after = before;
if (after.length > 0 && !after.endsWith('\n')) after += '\n';
after += `VAPID_PUBLIC_KEY="${publicKey}"\n`;
after += `VAPID_PRIVATE_KEY="${privateKey}"\n`;
// 공개키는 브라우저가 구독할 때 필요하다 — NEXT_PUBLIC_으로 한 번 더 둔다.
// **공개키는 새어도 안전하다**(이름 그대로 공개용). 비공개키만 서버에 갇힌다
after += `NEXT_PUBLIC_VAPID_PUBLIC_KEY="${publicKey}"\n`;
writeFileSync(envPath, after, 'utf8');

console.log('\n✔ VAPID 열쇠를 만들어 .env에 넣었습니다.');
console.log(`  공개키: ${publicKey.slice(0, 12)}… (브라우저에 나감 — 새어도 안전)`);
console.log(`  비공개키: 길이 ${privateKey.length}자 — 값은 찍지 않습니다\n`);
