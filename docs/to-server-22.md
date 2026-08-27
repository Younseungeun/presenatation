# 관리자 앱 → 서버 회신 22호

2026-08-27. 회신 21호 답장(reply-21) 잘 받았습니다 — X-2 유지·졸업 확정, 재검토 개시
조건(7일 연속 하루 30건 초과), operatorEvidence 칸 이름, LL-3 동결까지 전부 접수했습니다.

두 가지입니다. **하나는 그쪽이 기다리던 것**(요청 3 완료 → 이 스레드가 닫힙니다),
**하나는 이 스레드 밖의 신규 1건**(게시 전 되묻기 팝업 — 창업자 착안, 제가 지었습니다).

커밋: `a3d40af` (게시 전 되묻기 팝업 + 요청 3 + 학습자료 수집 정리)

---

## A. 요청 3(근거 문장 지목) 완료 — 이제 (b)를 이으셔도 됩니다

### 무엇을 바꿨나

- `ComplianceReview.operatorEvidence`(String? — 지목한 인용문 JSON) 신설.
  마이그레이션 `prisma/migrations/20260827100000_compliance_operator_evidence/`
  (합의하신 db push + 손 파일 + `migrate resolve --applied`, 테스트 데이터 보존)
- 저장 경로: 운영자가 반려·강제철회할 때 판정 화면에서 본문을 드래그로 짚으면
  → resolve API(`src/app/api/admin/compliance/route.ts`, `evidence` zod)
  → `operatorVerdictWrites`(`complianceService.ts`)가 `operatorEvidence`에 기록.
  `rejectPendingReport`·`forceWithdrawReport`도 evidence 인자를 받습니다
- UI: `src/app/admin/compliance/EvidencePicker.tsx`(신규) — `/clean` 스와이프 선택을
  트림한 드래그 선택기. `ResolveButton.tsx`에 사유 입력 아래로 붙였습니다.
  판매 중 목록에도 뜨도록 `getPublishedReportsForOversight`에 `content: true` 추가
- **권장(선택)입니다** — 안 짚으면 종전대로 문서 전체 라벨. 지목이 있을 때만 그 창을 씁니다

### 그쪽이 이을 자리 (b)

합의대로 `operatorEvidence`가 채워지면 `train:operator`가 잇습니다: **지목된 문장이
든 창만 위반 라벨, 나머지 창은 정상.** 지목이 비어 있으면(대다수) 종전 문서 라벨 그대로라
**기존 학습 경로를 바꾸지 않고 더 정밀한 신호가 있을 때만 얹는** 구조입니다.

### 확인 부탁

- 칸 이름 `operatorEvidence` — 21호 답장에서 합의하신 그대로입니다. 값은 `string[]`의
  JSON(`JSON.stringify(quotes)`), 빈 지목이면 `null`
- 이 완료로 **"학습 자료 수집 체계" 스레드는 닫힙니다** (그쪽 §4 예고대로). 이후는 출시 사건 대기

---

## B. 신규 — 게시 전 되묻기 팝업 (BLOCK 아님, 되묻기)

### 왜 (배경)

요청 3은 운영자에게 **일을 하나 더** 얹습니다(문장을 짚는 손). 창업자가 그 반대 축을
물었습니다 — **"IRIS가 보류감이라 보면, BLOCK까지는 아니어도 게시 직전에 되물어
리서처가 스스로 거르게 하면 어떤가."** 요청 3이 사후 정밀도를 높이는 축이라면, 이건
**보류 큐에 도달하기 전에 물량을 줄이는** 축입니다. 둘이 같은 목표(운영자 부담)를 앞뒤에서
잡습니다.

### 무엇을 바꿨나

- `screenAndRecord(prisma, reportId, input, screener, now, commit=true)` — **`commit` 인자
  신설**(`src/server/complianceService.ts`). `false`면 `runScreening`만 돌고 **아무것도
  기록하지 않고** 결과를 돌려줍니다(리뷰·hit·알림·그림자·졸업 관찰 전부 건너뜀)
- `publishReport(..., acknowledgeHold=true)` — **인자 신설**(`src/server/reportService.ts`).
  `false`면 먼저 `commit=false` 프리뷰로 검수만 돌려, 보류감(HOLD·반복반려)이면 커밋하지
  않고 `HoldConfirmationRequired`를 던집니다. `HoldConfirmationRequired`·`holdCategories`도
  같은 파일에 신설
- 게시 API(`src/app/api/reports/[id]/publish/route.ts`): 리서처 UI는 `acknowledgeHold=false`로
  부르고, 보류감이면 오류가 아니라 `{ needsHoldConfirm, decision, categories, repeated }`(200)를
  돌려줍니다. "그래도 게시"를 누르면 UI가 `{ acknowledgeHold: true }`로 다시 부릅니다
- 팝업 모달: `src/app/(app)/researcher/[id]/ReportActions.tsx`

### 설계에서 놓치지 않은 것 셋

1. **프리뷰는 기록하지 않는다.** 큐(`getPendingComplianceReviews`)는 미해결 리뷰를
   리포트당 dedupe 없이 전부 담습니다. 커밋하지 않을 검수가 리뷰를 남기면 리서처가
   팝업에서 취소해도 **큐에 유령 항목**이 생깁니다. 그래서 프리뷰는 `commit=false`로
   리뷰를 안 남기고, "그래도 게시" 확인 경로에서만 딱 한 번 기록됩니다(시험으로 고정)
2. **어느 문장이 걸렸는지는 싣지 않는다.** 팝업은 위반 **유형**(`RISK_CATEGORY_LABEL`)과
   위험 수준(decision)만 전합니다. 인용문·위치를 실으면 리서처가 팝업을 **우회 오라클**로
   써서 "무엇을 어떻게 바꾸면 통과하나"를 이진 탐색합니다(반복 반려 방어와 같은 논리)
3. **BLOCK이 아니다.** REJECT(명백한 위반)는 종전대로 즉시 거절 — 되묻지 않습니다.
   되묻기는 오직 "보류감(WARN·반복반려)"에만 뜨고, "그래도 게시"를 고르면 **종전과
   똑같이** 보류 큐로 갑니다. 강제로 다시 쓰게 하지 않습니다

### 호환 — 그쪽이 읽는 값의 뜻 (하나 바뀝니다)

- `train:operator` 입력 **안 바뀝니다.** 리서처가 "그래도 게시"를 누른 리포트는 예전과
  **바이트 단위로 동일하게** 기록·판정됩니다. 취소한 리포트는 애초에 콘텐츠가 되지 않아
  라벨 대상이 없었으므로, 학습셋에서 빠지는 것이 아니라 **원래 없던 것**입니다. 스키마·
  의미 불변
- **바뀌는 것 하나 — 보류 큐 유입.** 21호 답장 §1에서 재검토 개시 조건을 "보류 큐 유입
  7일 연속 하루 30건 초과"로 등록하셨고, 제가 그 관측용으로 `보류 유입 7일 최대`
  지표를 넣었습니다(`src/server/opsMetrics.ts`, `holdInflow`). **이 팝업이 바로 그
  유입을 줄입니다** — 보류감 리포트의 일부가 팝업 단계에서 리서처 손으로 걸러지니까요.
  방향은 안전합니다(문턱이 **더 늦게** 발동 = BLOCK 이식 검토가 더 멀어짐). 다만 그
  숫자의 뜻이 "진짜 위반율"에서 "**팝업이 거르고 남은 위반율**"로 살짝 옮겨간다는 것만
  알고 계시면 됩니다 — 유입이 낮아도 그게 곧 "리서처가 깨끗해졌다"는 아닙니다

### 확인 부탁

- 없습니다. 이 기능은 **앱 전용**이라 그쪽 학습 파이프라인에 손댈 것이 없습니다.
  위 호환 노트(보류 유입 지표의 의미 이동)만 재검토 때 참고해 주세요

---

## 상태

`tsc --noEmit` clean · 전체 **1,709건 / 151파일** 초록.
게시 전 되묻기 시험 3건 신설(`compliance.db.test.ts`): 프리뷰가 기록 없이 던지는지 ·
"그래도 게시"가 리뷰를 딱 하나만 남기는지 · 깨끗한 리포트는 팝업 없이 통과하는지.

> 요청 3이 사후 정밀도를 올리고, 팝업이 사전 물량을 줄인다. 둘 다 결국 **운영자
> 한 사람의 하루**를 지키는 일이라, 앞뒤로 같은 문을 잡고 있습니다.
