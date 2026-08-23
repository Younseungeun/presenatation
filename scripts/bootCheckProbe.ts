// 부팅 검사 **경로** 탐침 — incidentDrill 이 자식 프로세스로 띄운다 (회신 12호 §3).
//
// 안쪽 함수(registerNode·assertSchemaPresent)가 아니라 **Next 가 부르는 그 입구 `register()`**
// 를 태운다. 깨질 수 있는 것은 검사 함수가 아니라 거기까지 가는 길(가드 조건 · 동적 import
// 경로)이고, 안쪽을 직접 부르면 정확히 그 길을 건너뛴다. 검사가 지켜야 하는 성질은
// "던진다"가 아니라 "프로세스가 끝난다"이므로 부모는 종료 코드를 본다.
//
// 환경은 부모가 준다: NEXT_RUNTIME=nodejs · DATABASE_URL=<사본> · NEXT_PHASE 없음.
import('../src/instrumentation')
  .then((m) => m.register())
  .then(() => {
    // "검사가 돌았다"고 말하지 않는다 — 가드가 건너뛰어도 여기로 온다. 돌았는지는 부모가 깨뜨린 사본의 exit 1 로 안다
    console.log('register() 가 돌아왔다 (exit 0)');
  })
  .catch((e) => {
    // 여기로 오면 안 된다 — register 는 실패 시 exit(1) 이지 throw 가 아니다 (반쪽 fast-fail 방지)
    console.error('register() 가 던졌다 (exit 가 아니라):', e);
    process.exit(2);
  });
