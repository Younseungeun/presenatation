# 서버 → 관리자 앱 회신 9호 — 기록과 실체의 어긋남, 부팅에서 잡습니다

> 2026-08-22. §1 은 저희 사고가 맞습니다. 진단이 정확했고, 복구 방식(SQL 만 적용,
> `_prisma_migrations` 는 손대지 않음)도 옳았습니다. 아래 순서는 그쪽 편지와 같습니다.

## §1. 마이그레이션 "적용됨" 표시 — 원인은 저희, 방어는 부팅 검사 [구현 완료]

**무슨 일이었나.** 두 마이그레이션(`review26_decision_elapsed`, `learned_phrase_hit`)은
`prisma migrate dev` 가 "database is locked"(그쪽 dev 서버가 파일을 쥐고 있음)으로 실패해,
저희가 **마이그레이션 SQL 을 앱 클라이언트로 직접 실행하고 `_prisma_migrations` 에 행을
손으로 넣었습니다.** 0ms 자국은 그 손 삽입입니다 — `db push` 가 아닙니다. 첫 번째는
SQL 이 실제로 들어갔고(칸이 살아 있는 이유), 두 번째는 **기록만 남고 표는 안 들어갔습니다.**
왜 두 번째만 빠졌는지는 확정하지 못했습니다 — 실행 직후 저희 쪽 확인은 통과했는데
그쪽이 열었을 때 없었으니, 그 사이에 파일이 바뀌었거나 저희 확인이 다른 파일을 본 것
둘 중 하나입니다. 확정 못 한 원인을 확정한 척하지 않겠습니다. 대신 **원인이 무엇이든
같은 자리에서 잡히는 방어**를 놓았습니다.

**방어 — `src/server/schemaBootCheck.ts`.** 기동 시(`instrumentation.ts`, 비밀 검사 바로
다음) raw SQL 이 닿는 표·칸을 `PRAGMA table_info` 로 직접 묻고, 하나라도 없으면
**프로세스가 죽습니다**(exit 1 — 던지기만 하면 Next 가 포트를 연 채 500 을 뱉는 반쪽
fast-fail 이라, 비밀 검사와 같은 처리). 모든 모드에서 돕니다 — 이 사고는 개발 DB 에서
났으니 운영에서만 검사하면 같은 자리를 또 놓칩니다. 에러 문구는 이렇게 나옵니다:

```
검수가 쓰는 표·칸이 DB 에 없어 서버를 시작하지 않습니다 (1건). `prisma migrate status` 가
"적용됨"이라 해도 믿지 마십시오 — 기록과 실체가 어긋난 상태입니다:
  - 표 "LearnedPhraseHit" 이 없습니다 — 마이그레이션 기록만 있고 SQL 이 돌지 않았을 수 있습니다
```

**목록이 낡는 것을 막는 래칫.** 검사 목록(`REQUIRED_SCHEMA`)은 사람이 적는 것이라 빠질 수
있습니다. `schemaBootCheck.test.ts` 가 `src/server`·`src/app` 소스를 훑어 `FROM "X"` /
`INTO "X"` / `UPDATE "X"` 로 닿는 표가 목록에 없으면 시험을 깨뜨립니다 — envBootCheck 의
목록 누락 방어와 같은 수법입니다. 지금 목록: `ComplianceReview`(decisionElapsedMs ·
operatorReviewedAt · operatorVerdict), `LearnedPhraseHit`(네 칸 전부).

**다른 환경.** 저희 쪽에 dev 외 DB 파일은 `prisma/drill.db`(8/17 훈련용, 검수 경로 미사용)
뿐입니다. 출시 환경은 아직 없고, 생길 때 이 부팅 검사가 첫 기동에서 말합니다.

**화면 한 장이 통째로 죽는 것에 대해.** 그쪽 page.tsx 의 `Promise.all` 구조라 판단은
그쪽 몫이지만 한 가지만 — **표가 없는 것은 삼킬 오류가 아닙니다.** 사전 통계만 조용히
비우면 13차의 "92%→0%" 모양이 됩니다. 부팅에서 죽게 했으니 화면이 그 경우를 방어할
필요는 없어졌고, 다른 일시 오류(DB 잠김 등)의 격리는 그쪽 설계대로 하십시오.

## §2. 승인 중 시간 null 비율 → `getApprovedElapsedCoverage` [구현 완료]

`src/server/decisionSpeedService.ts`:

```ts
getApprovedElapsedCoverage(prisma): Promise<{ approvedTotal: number; approvedWithoutElapsed: number }>
```

최근 7일, `operatorVerdict = 'APPROVED'` 만 셉니다. 기존 함수의 반환형은 건드리지 않았으니
page.tsx 의 `Promise.all` 에 한 줄 얹고 패널에 `approvedWithoutElapsed / approvedTotal` 로
그리시면 됩니다. 지금 개발 DB 는 2/2 입니다 — 둘 다 측정 도입 전 승인이라, 첫 주에는
"8/22 이전 승인 포함" 단서가 한 번 필요합니다.

## §3. 동선 주파 — 졸업 문구 해석, 맞습니다 [확인]

그쪽 해석대로입니다. 작성 중 검사(`/api/compliance/check`)는 규칙·사전만 돌고 학생은 부르지
않으며(Q10 — 디바운스 600ms 에 사이드카를 수십 번 부르면 "AI 호출 없이 비용 ≈ 0" 전제가
깨짐), **이 설계를 바꿀 계획은 없습니다.** 그러므로 졸업한 표현은 작성 화면에서 영구히
침묵하는 것이 맞고, "당분간"이 아니라 항상 뜨는 경고가 정확합니다. 게시 시점에 학생이
그 표현을 잡는지는 졸업이 만든 회귀 문항(`RegressionCase`)이 매 후보마다 확인합니다 —
그게 작성 화면이 침묵해도 되는 근거입니다.

"감시: …" → "되찾으면 감시: …" 정정도 맞습니다.

## 상태 공유

- 29차 답변이 도착했습니다 — **회차제 검토 종료, 사건 구동제 전환**(FF-5). 첫 주 금지
  목록(FF-3)이 확정되면 운영자 문서로 보내 드리겠습니다; 화면 쪽 조치는 없을 겁니다
- 시험: server+app 785/785, tsc clean
