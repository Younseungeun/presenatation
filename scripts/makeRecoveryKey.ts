import { generateRecoveryKeyPair } from '../src/server/recoveryToken';

// 종이 열쇠 한 쌍을 만든다:
//   npm run recovery:key
//
// **인터넷이 끊긴 기기에서 한 번만 돌린다.** 출력의 아래쪽(개인키)은 종이에 인쇄해
// 금고에 넣고, 화면과 터미널 기록에서 지운다. 파일로 저장하는 순간 이 설계 전체가
// 무의미해진다 — 파일에 있는 열쇠는 서버를 턴 사람이 언젠가 가져간다.
//
// 위쪽(공개키)만 서버 환경 변수 RECOVERY_PUBLIC_KEY에 넣는다. 공개키로는 서명을
// 만들 수 없으므로, 서버가 통째로 털려도 이 값으로는 아무것도 못 한다.

const { publicKey, paperKey } = generateRecoveryKeyPair();

console.log('');
console.log('─── 서버 환경 변수에 넣을 값 (공개키) ───────────────────');
console.log(`RECOVERY_PUBLIC_KEY=${publicKey}`);
console.log('');
console.log('─── 종이에 인쇄해 금고에 넣을 값 (개인키) ───────────────');
console.log(paperKey);
console.log('');
console.log('※ 아래 값은 어떤 파일·비밀번호 관리자·클라우드에도 저장하지 마세요.');
console.log('※ 이 값을 잃으면 비상 복구가 불가능하고, 이 값이 새면 복구 경로가 뚫립니다.');
console.log('※ FOUNDER_CI_HASH가 함께 설정돼 있어야 복구 경로가 켜집니다 (npm run op:hash).');
console.log('');
