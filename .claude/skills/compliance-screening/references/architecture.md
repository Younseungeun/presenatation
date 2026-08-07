# 이 리포지토리의 검수 파이프라인

리서치 마켓플레이스(Next.js + Prisma + Vitest)의 컴플라이언스 검수 구현.
`CLAUDE.md` §7이 확정 사항의 단일 기준이고, 이 문서는 코드로 가는 지도다.

## 목차
- [파이프라인 흐름](#파이프라인-흐름)
- [파일 지도](#파일-지도)
- [데이터 모델](#데이터-모델)
- [실행 명령](#실행-명령)
- [확장 지점](#확장-지점)
- [깨면 안 되는 불변식](#깨면-안-되는-불변식)

---

## 파이프라인 흐름

```
리서처가 작성 중
  └─ POST /api/compliance/check (디바운스 600ms)
       규칙 + 학습 표현 + (의미 검색)  ← AI 호출 없음, 비용 ≈ 0
       "명백한 금지 표현은 없습니다" 까지만 말한다

제출 (publishReport)
  ├─ 1차 결정적 규칙  → BLOCK 이면 REJECT (AI 미호출)
  ├─ 학습 표현 · 의미 검색 → WARN
  ├─ 2차 Claude 검수  → PASS 면 PUBLISH / WARN·BLOCK·장애면 HOLD
  └─ 반복 반려 3회 이상이면 PASS여도 HOLD

HOLD → /admin/compliance 큐
  ├─ 승인 → finalizePublish (기준가·수수료를 이 시점에 확정)
  ├─ 반려 → DRAFT 복귀 + rejectionCount++ + 학습 표현 등록(선택)
  └─ (배치) 시한 경과 자동 만료 / 24시간 초과 재알림

게시 후
  └─ 강제 철회 → 판정 불가 확정 + 전액 환불 + 미탐 라벨
```

**보류 중에는 판매 조건을 확정하지 않는다.** 기준가를 제출 시점에 박으면 보류 기간의
시세 변동이 이미 실현된 채 판매되어 정보 이점이 생긴다. 그래서 승인 시점에 확정한다.

---

## 파일 지도

### 도메인 (순수 함수 — 여기서부터 읽는다)

| 파일 | 책임 |
|---|---|
| `src/domain/compliance.ts` | 유형 정의, 결정적 규칙, 정규화 2차 패스, 부정 문맥 처리, decision/action 분리 |
| `src/domain/learnedPhrases.ts` | 운영자가 등록한 표현의 매칭·검증·정확도 |
| `src/domain/semanticIndex.ts` | 코사인 유사도, 문장 분리, 의미 소견 생성 |
| `src/domain/screeningAccuracy.ts` | 운영자 판정 → 정탐/경미/오탐/미탐 분류 및 집계 |
| `src/domain/screeningEval.ts` | 평가 하네스 (탐지기를 "문장 → 소견" 함수로만 본다) |
| `src/domain/__fixtures__/screeningCorpus.ts` | 라벨된 평가 코퍼스 |
| `src/domain/instrumentRisk.ts` | 종목 자체의 위험(거래소 지정·상폐·과소 시총) |
| `src/domain/scoring.ts` | 예측 크기 하한·상한 (`maxMagnitudePct`) |

### 인프라 (어댑터)

| 파일 | 책임 |
|---|---|
| `src/infra/compliance/screener.ts` | AI 검수 포트 + 테스트 더블 |
| `src/infra/compliance/claudeScreener.ts` | Claude 어댑터 — 프롬프트, 무작위 경계, 구조화 출력 |
| `src/infra/embedding/provider.ts` | 임베딩 포트 + 픽스처 (**운영 어댑터 미연결**) |

### 서버 (Prisma)

| 파일 | 책임 |
|---|---|
| `src/server/complianceService.ts` | `runScreening` / `screenAndRecord` / 운영자 판정 기록 / 정확도 집계 / 강제 철회 |
| `src/server/complianceOpsService.ts` | 보류 만료·지연 재알림·벡터 백필 배치 |
| `src/server/learnedPhraseService.ts` | 학습 표현 CRUD + 건강도 |
| `src/server/semanticIndexService.ts` | 의미 인덱스 적재·백필·검색 |
| `src/server/reportService.ts` | 게시·승인·반려 트랜잭션 |

### 화면

| 경로 | 용도 |
|---|---|
| `src/app/researcher/[id]/new/ComplianceHints.tsx` | 작성 중 사전 검사 |
| `src/app/admin/compliance/page.tsx` | 운영자 큐 (탭: 본문/종목/판매중/학습표현) |
| `src/app/admin/compliance/ResolveButton.tsx` | 승인·반려·철회 + 정답 라벨 입력 |

---

## 데이터 모델

```prisma
ComplianceReview {
  decision, reviewer, findingsJson, needsOperatorReview
  // 정답 라벨 (screeningAccuracy.ts)
  operatorVerdict     // APPROVED | REJECTED | KEPT | TAKEDOWN
  operatorReason
  operatorCategories  // 운영자가 지목한 실제 위반 유형 JSON
  aiFindingsValid     // 승인 시: 지적 자체는 타당했는가
  escalatedAt         // 지연 재알림 중복 방지
  inputTokens / outputTokens / deliberationRatio  // 비용·숙고량
}

LearnedPhrase {
  phrase, normalized, category, note, active
  matchCount / confirmedCount   // 표현별 정확도
  vectorJson / vectorModel      // 의미 인덱스 (모델 식별자 필수)
}

Report.rejectionCount  // 반복 반려 → 자동 통과 경로 차단
```

`Finding`은 DB 스키마가 아니라 `findingsJson`에 직렬화된다. `source`와 `phraseId`는
나중에 추가된 선택 필드라 구버전 기록에는 없다 — 파싱은 항상 방어적으로.

---

## 실행 명령

```bash
npm run eval:screening      # 평가셋 기준선 (변경 전후 비교의 기준)
npm run batch:compliance    # 보류 만료 + 지연 재알림 + 벡터 백필 (하루 1회 이상)
npm run calibrate:semantic  # 임베딩 임계값 스윕 (공급자 연결 후)
npm run risk:set            # 종목 위험 등급 수동 등록
npx vitest run              # 회귀 테스트
```

---

## 확장 지점

**규칙 추가** — `compliance.ts`의 `RULES` 배열. 심각도 판단은 SKILL.md §2, §8 참고.

**유형 추가** — `RISK_CATEGORIES` + `RISK_CATEGORY_LABEL`에 추가하면 AI 출력 스키마,
운영자 반려 폼, 유형별 정확도 집계가 전부 따라온다 (한 곳만 고치면 되게 배선돼 있다).

**AI 모델 교체** — `claudeScreener.ts`의 `MODEL`. 프롬프트를 고쳤으면 반드시
`eval:screening`으로 오탐률을 재확인한다.

**임베딩 어댑터 연결** — `infra/embedding/provider.ts`의
`createEmbeddingProviderFromEnv()`가 지금 `null`을 돌려준다 (모델 가중치를 받을 수
없는 환경이라 미연결). 여기에 ONNX 어댑터를 반환하면 검수·작성 화면·배치가 전부
자동으로 켜진다. 연결 직후 `calibrate:semantic`으로 임계값을 정하고
`semanticIndex.ts`의 `SIMILARITY_THRESHOLD`에 반영한다.

---

## 깨면 안 되는 불변식

이것들은 테스트로 못 박혀 있다. 깨면 테스트가 먼저 잡는다.

1. **즉시 거절 오탐 0건** (`screeningEval.test.ts`) — 규칙이 낸 BLOCK만 REJECT다.
   AI·학습 표현·의미 검색은 어떤 경우에도 거절을 유발하지 않는다.
2. **자동 만료는 `operatorVerdict`를 남기지 않는다** — 시간이 만든 결과를 사람의 판단으로
   기록하면 정확도 지표가 오염된다.
3. **승인·반려·철회는 전부 `operatorVerdictWrites`를 거친다** — 라벨이 비는 종결 건이
   생기면 측정이 불가능해진다. 대기 건이 없으면 최근 기록에 붙이는 경로가 미탐의
   유일한 관측 통로다.
4. **판정·정산은 `buildJudgmentWrites`를 공유한다** — 자동 배치·수동 판정·강제 철회가
   같은 함수를 쓴다. 갈라지면 점수·정산·알림이 경로마다 달라진다.
5. **보류 중에는 기준가·수수료·카드 잠금을 확정하지 않는다** — 승인 시점에
   `finalizePublish`로 확정한다.
6. **오탐 사례 되먹임은 원문과 같은 경계 안에 넣는다** — 그 사례들도 사용자 입력이라,
   신뢰 구간에 두면 되먹임 경로가 새 프롬프트 인젝션 통로가 된다.
