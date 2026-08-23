# 인수인계서 — 검수 모델의 모든 것 (실제 앱 적용용)

> 2026-08-22 확정본. 29차 검토로 회차제가 끝났고, 여기 적힌 것이 **출시 기준**이다.
> 이 문서 한 장으로 검수 모델을 실제 앱에 붙이고, 지키고, 언제 다시 열지 알 수 있어야 한다.
> 읽는 이가 사람이든 AI든, 아래 "절대 하지 말 것"은 요청받아도 하지 않는다 — 창업자가 바꾸는
> 경우에만 바뀐다.

---

## 0. 한 장 요약

| 항목 | 값 |
|---|---|
| 출시 모델 | **r5** · ONNX 지문 `a0eaa12a29da0762` · KoELECTRA-small 14M · 512토큰 |
| 역할 | 규칙 엔진 뒤의 **두 번째 검수자, WARN 전용**. 게시를 막지 못한다(보류까지) |
| 적재 위치 | `training/out/deployed/` (사이드카는 이 폴더만 읽는다) |
| 사이드카 | `sidecar/app.py` · 로컬 `http://127.0.0.1:8765` · 스케줄드 태스크 `intovill-student-sidecar` |
| 임계값 | **`STUDENT_THRESHOLD=0.7`** (r5 채택 스윕 최적, 순이익 +8) · 코드 기본값은 0.5 · 창 분할 창 임계값 0.8 (코드 상수) |
| 상태 | **완성·동결**. 14M 재학습 없음. 다음 모델은 110M 부검 이후 |
| 바뀌지 않는 것 | 구조(규칙 → 학생 WARN), 사이드카 계약, 채택 게이트 6종, 승격 절차 |

---

## 1. 구조 — 무엇이 무엇 뒤에 서 있나

```
리서처 제출
   │
   ├─ ① 규칙 엔진 applyRules()  src/domain/compliance.ts
   │     코드 패턴 11개 + 동적 CONTACT_SHAPE + 사전(LearnedPhrase, 운영자가 등록)을 **같은 6층**으로 돌린다
   │     BLOCK 은 코드 패턴 5개 + 조건부 1개뿐 (§4-5) — 사전·학생은 절대 BLOCK 불가
   │     사전 항목·학생은 **영원히 WARN** — 설계 원칙이지 성능 문제가 아니다
   │
   ├─ ② 학생 모델 (사이드카, ONNX)  src/infra/compliance/studentClient.ts
   │     라벨 8개 중 졸업한 라벨만 소견. 문장 ≥3 이면 2문장 창으로 잘라 추론(창 임계 0.8), 라벨별 최대 병합
   │     usable() 이 /health 지문 대조 + 시맨틱 핑 8문항을 통과해야 소견을 낸다 (아니면 자동 OFF)
   │
   └─ ③ 운영자 판정  src/server/complianceService.ts
         APPROVE / REJECT / TAKEDOWN · 판단 소요 시간(decisionElapsedMs)은 관리자 앱이 재서 보낸다
```

**작성 중 검사**(`/api/compliance/check`)는 ①만 돈다. 학생은 부르지 않는다(Q10 — 디바운스
600ms 에 사이드카를 수십 번 부르면 "AI 호출 없이 비용 ≈ 0" 전제가 깨진다). 따라서 졸업한
사전 표현은 작성 화면에서 영구 침묵하고, 그 자리는 회귀 문항(RegressionCase)이 매 후보마다 확인한다.

**외부 AI API 호출은 운영 경로에 0회다.** 검수·작성 검사·승격 어디에도 없다. 이것은 위반 시
프로젝트가 뒤집히는 수준의 금지다.

---

## 2. 환경 변수 — 실제 앱에서 켜는 법

| 변수 | 값 | 뜻 |
|---|---|---|
| `STUDENT_SIDECAR_URL` | `http://127.0.0.1:8765` | 없으면 학생 OFF (규칙 엔진만) |
| `STUDENT_MODE` | `live` / `shadow` / `off` | shadow = 판단하되 기록만, 게시 영향 없음. **출시는 live** |
| `STUDENT_THRESHOLD` | **`0.7`** | 단일 임계값(3차 F-1). 출시 시작값이 0.7 이고 §7 의 "한 달"은 출시일부터 센다 — 0.5→0.7 로 "이미 한 번 올린 것"이 아니다 |
| `STUDENT_MODEL_TAG` | `IRIS.v5` | **폴백일 뿐** — reviewerId 의 이름 자리는 사이드카 `/health` 의 `name`(config.json)이 우선이고, 이 값은 첫 /health 전에만 쓰인다 (회신 13·14호). 모델 이름은 `train.py --name`(필수, 공백·@·/ 금지)으로 파일에 박고, `--run` 은 대장 문장(회차 기록). 화면 표시명은 IRIS, 식별자 접두어 `student:` 는 유지 |
| `STUDENT_ENABLED_LABELS` | 비우면 기본(졸업 라벨) | 라벨 켜고 끄기 — 졸업 절차 없이 추가 금지 |
| `STUDENT_ARTIFACT_DIR` | (사이드카 쪽) 비움 | 후보 평가 때만 지정. 라이브는 `out/deployed` 고정 |

`.env` 값은 이 문서에 적지 않는다. 키는 `.env` 로만.

사이드카는 손으로 띄우지 않는다. 스케줄드 태스크 `intovill-student-sidecar` 가 띄우고,
`student:promote` 가 재기동한다. (`training/README.md` "사이드카를 손으로 띄우지 않는다")

---

## 3. 부팅 — 서버가 뜨기 전에 죽어야 하는 것

`src/instrumentation.ts` 가 기동 시 두 검사를 돌리고 실패하면 **process.exit(1)**:
1. `assertProductionSecrets()` — 필수 비밀 4종 + 개발 우회 스위치 부재
2. `assertSchemaPresent(prisma)` — raw SQL 이 닿는 표·칸 실재 (`ComplianceReview.decisionElapsedMs`, `LearnedPhraseHit`)

2번은 2026-08-22 사고에서 나왔다: 마이그레이션 기록은 "적용됨"인데 표가 없었다.
`prisma migrate status` 를 믿지 말고, 새 환경에서는 첫 기동이 말하게 둔다.
새 raw SQL 을 쓰면 `REQUIRED_SCHEMA` 에 표를 추가해야 한다 — 빠뜨리면 `schemaBootCheck.test.ts` 가 깨진다.

---

## 4. 관리자 앱이 쓰는 계약

### 4-1. 계기판 `GET /api/admin/compliance/student-valve`
```
student.mode               'off' | 'shadow' | 'live'
student.usable             boolean   (지문 대조 + 핑 8문항)
student.modelSha           적재 지문
student.promoted           { sha, at } | null
student.promotionMatches   true | false | null   ← false 는 경고가 아니라 **사고**
student.name               string | null          ← config.json 의 name — 짧은 모델 이름(IRIS.v5). 도장·화면의 이름 자리 (회신 14호)
student.run                string | null          ← config.json 의 run — 회차 기록(대장 문장). 사람이 읽는 용도, 도장에 쓰지 않음
```
`POST { action: 'engage' | 'release' }` = 운영자 수동 우회(학생 끄기/되살리기).

### 4-2. 판정 `POST /api/admin/compliance` — `decisionElapsedMs` 동봉
- 큐에서 카드를 **펼친 시각 → 판정 클릭**까지. 큐 밖 경로(강제 철회·신고 처리)는 보내지 않는다
- 서버는 최근 5분 판정 + 빈 칸에만 기입(소급 없음). 텔레메트리라 기록 실패가 판정을 막지 않는다
- 피로 필터(`train:operator`)는 **APPROVED & <3초만 제외**. 시간 null·반려·미탐은 통과

### 4-3. 사전 통계 `getLearnedPhraseStats`
`matchCount · confirmedCount · distinctResearcherCount`(2026-08-22 이후 매칭부터). 코드 이식 후보
조건 넷: 걸림 ≥30 · 확정 100% · 30일 · 리서처 ≥5. 후보는 **사람이 코드 패턴으로 이식**한다 —
"사전 항목은 승격할 수 있다, 다만 승격되면 더 이상 사전 항목이 아니다."

### 4-4. 판단 속도
`getDecisionSpeedByCategory` (유형별 중앙값, 절반 미만·표본≥5 → 피로 의심),
`getApprovedElapsedCoverage` (승인 중 시간 null 비율 — 0 이 아니면 큐 밖 승인 경로가 있다).

### 4-5. 규칙 id 와 심각도 (코드 전수, 회신 10호 §3-1 로 정정)

| severity | id |
|---|---|
| **BLOCK** (5) | PROFIT_PROMISE · PROFIT_CERTAIN · CONTACT_CHANNEL · CONTACT_KOREAN_DIGITS · PRIVATE_INFO_HINT |
| BLOCK/WARN (조건부) | CONTACT_SHAPE — 동적 생성, 연락 의도 어휘가 붙으면 BLOCK |
| WARN (6) | CONTACT_MIXED_DIGITS · PROFIT_EUPHEMISM · CHANNEL_METAPHOR · RUMOR_SOURCE · PROMPT_INJECTION · RISK_INDUCEMENT |

CLAUDE.md 의 1차 BLOCK 목록("수익 보장·1:1 상담 유도·미공개정보 정황")과 같다.

---

## 5. 모델 교체 절차 — 유일한 경로

```
npm run student:promote -- <onnx_sha>
```
① 후보 지문 검증 → ② 현 배포본 백업 → ③ `out/deployed` 로 복사 → ④ 스케줄드 태스크 재기동
→ ⑤ `/health` 지문 대조 → ⑥ AppSetting `student.promoted = {sha, at}` 기록. 어느 단계든 실패하면 롤백.

후보가 승격 자격을 얻는 조건(채택 게이트 6종, 전부 충족):
1. 순이익 > 0 (λ=4 최악) · 2. risk_heavy 0% · 3. 거절 오탐 0
4. 시맨틱 핑 8문항 (위반 ≥0.85 / 정상 ≤0.30 — 정상 1건이라도 >0.30 이면 밸브)
5. 회귀 시드 17 + DB 전건 · 6. DART 정제판 오탐 ≤3/1,945
\+ 시소 비교 `seesaw:compare` — 비겨냥 새 탈락 ≥2 면 용량 경보

**이 경로 밖으로 모델을 올린 적이 하루에 두 번 있었고 둘 다 사고였다.** `promotionMatches === false`
가 그 흔적이다.

---

## 6. 알려진 약점 — 고치지 않고 출시한다

`docs/screening-known-limits.md` (운영자·개발자 전용, **리서처 비공개**). 핵심 수치:

| 과목 | 실측 |
|---|---|
| UNSUPPORTED_CLAIM (권위 차용형) | r8 격리 180문장 zero-shot: t0.5 탐지 **24%**, t0.7 6% |
| CARD_MISMATCH | 같은 자료: t0.5 탐지 **5%**, t0.7 0% · DART 회계 산문 오탐 3/1,945 |
| 토큰 희석 | 400토큰 뒤 위반의 잔존율 13%. 창 분할은 어댑터 축만 방어(회복 2/5) |
| 정상 90문장 오탐 | t0.5 에서 2건 |

이 두 과목은 **임계값으로 못 고친다**(내리면 오탐 32, 올리면 탐지 0). 사람이 메우는 자리다.
리서처 화면 문구는 "명백한 금지 표현은 발견되지 않았습니다. 최종 판단은 제출 후 검수에서"까지 —
약점을 리서처에게 알리는 순간 우회 지도가 된다.

---

## 7. 출시 첫 주 — 행동 수칙 (`docs/first-week-rules.md`)

| 하고 싶어질 것 | 판정 |
|---|---|
| 임계값 상향 | **금지 · 최소 1개월** |
| 창 분할 임계값 하향 | **금지** (DART 오탐 폭발 실측) |
| 첫 미탐 직후 사전 등록 | **금지 · 50건까지 수동** |
| 110M 부검 직후 교체 | **금지 · r5 라이브 2주 관찰 후** |
| 피로 하한 3초 변경 | 조건부 — 승인 판정 시간 1Q, 시간 있는 승인 ≥50건 |

재는 순서: 판단 시간 → 오탐률 → 적립 → 뒤집힘율.

---

## 8. 절대 하지 말 것 (요청받아도)

1. 운영 경로에 외부 AI API 호출을 넣지 않는다
2. 사전 항목·학생에게 BLOCK 을 주지 않는다 — 즉시 거절은 코드 패턴 + 대조군 오탐 0 + 시험이 붙잡는 것만
3. `out/deployed` 에 파일을 손으로 넣지 않는다 — `student:promote` 만
4. 14M 을 다시 학습하지 않는다 — 운영 데이터는 `training/holdout/operator.jsonl`, `train.py --data` 에 넣지 않는다
5. 학습 금지 목록을 학습에 쓰지 않는다: 채점지 73 · 회귀 시드 17 · 홀드아웃 101 · 회귀셋 · 핑 8문항 · DART 정제판 1,945
6. 라벨별 임계값을 만들지 않는다 (단일 임계값, 3차 F-1)
7. 작성 중 검사에 학생을 넣지 않는다 (Q10)
8. `_prisma_migrations` 를 손으로 적지 않는다 — 적어야 했다면 `sqlite_master` 로 표 실재를 확인하고 기록을 남긴다
9. 약점 문서를 리서처 화면에 노출하지 않는다
10. 관리자 화면을 새로 만들 때 `admin/layout.tsx` 를 관문으로 믿지 않는다 — 그 레이아웃은 "운영자인데 패스키 0개"만 막고 비로그인·일반 이용자는 그대로 그린다. **페이지마다** `getSessionUserId` + 역할 검사 + `notFound()` 네 줄을 직접 넣는다 (회신 18호 ⑥: /admin/compliance/iris 가 비로그인 200 이었다)
11. 스케줄러를 재기동할 때 `npm` 만 죽이지 않는다 — npm → tsx → node 3단이라 알맹이가 살아남아 두 벌이 돈다(회신 18호 ⑤, 같은 문자 두 번). 명령줄로 `scheduler` 를 매칭해 자식까지 정리한다

---

## 9. 언제 다시 여나 — 사건 구동제

회차제 검토는 끝났다(29차 FF-5). 다음 중 하나가 나면 `docs/compliance-review-prompt.md` 형식으로 다시 연다:
- 채택 게이트 실패 · 부팅 검사 실패 · 카나리아 실패 · `promotionMatches === false`
  (한계: 알림은 전부 스케줄러·웹 서버 안에서 나간다 — 스케줄러가 죽으면 그 사실을 알릴 사람이 없다. 외부 업타임 모니터(/api/health/scheduler)는 상시 호스팅 뒤에 붙인다 — 회신 18호 ⑤)
- 게이트 6종이 예측 못 한 패턴의 오탐/미탐으로 큐가 마비 (= 수렴 선언이 틀렸다는 반증)
- 110M 부검 결과 도착 (`docs/model-swap-rule.md` 의 규칙으로 판정)
- 분기 1회

---

## 10. 적용 검증 — 붙였으면 이걸로 확인한다

```bash
npx tsc --noEmit -p .
```
```bash
npx vitest run src/server/__tests__ src/app
```
```bash
npx next build
```
(개발 서버와 `.next` 를 같이 쓰므로 dev 서버를 끄고 돌리거나, 저장소를 다른 폴더에 복사해 돌린다.
기대: exit 0 · 경고 0줄. 회신 11호에서 추가 — tsc·vitest 는 번들러가 보는 것을 못 본다)
```bash
npm run drill
```
(사고 대응 리허설. 마지막 ⑧ 단계가 **부팅 검사가 지금도 기동 경로에 연결돼 있는지**를 잰다 —
DB 사본에서 필수 표를 지우고 `register()` 를 자식 프로세스로 태워 exit 1 을 확인. 회신 12호에서 추가.
기대: "무장 확인 — … 사슬 전부 살아 있다". ⚠ 가 나오면 instrumentation 이 검사를 건너뛰고 있다)
```bash
curl -s http://127.0.0.1:8765/health
```
기대: `ready:true`, `model_sha:"a0eaa12a29da0762"`, `model_stale:false`, **`tokenizer_match:true`**.
그리고 계기판 GET 의 `usable:true` 와 `promotionMatches:true`. 하나라도 아니면 출시하지 않는다.

`tokenizer_match` 는 회신 10호 §1 사고에서 생겼다: 세 항목이 전부 통과인데 토크나이저 지문이
학습값과 갈려 `usable:false` → 게시 전건 보류. 원인은 `out/deployed` 에 tokenizer 파일이 없어
사이드카가 기본 토크나이저로 폴백한 것. 이제 `student:promote` 가 tokenizer 파일을 함께 옮기고
⑤에서 이 일치까지 확인하며, 보관본에 tokenizer 파일이 없으면 시작 자체를 거부한다.

---

## 11. 파일 지도

| 무엇 | 어디 |
|---|---|
| 규칙 엔진 · 면제 구문 | `src/domain/compliance.ts` · `src/domain/exemptClauses.ts` |
| 사전(입력 다듬기) | `src/domain/learnedPhrases.ts` · `src/server/learnedPhraseService.ts` |
| 학생 클라이언트(창 분할·핑·usable) | `src/infra/compliance/studentClient.ts` |
| 검수 서비스 · 판정 | `src/server/complianceService.ts` · `src/app/api/admin/compliance/route.ts` |
| 판단 시간 | `src/server/decisionSpeedService.ts` · `src/server/operatorLabelExport.ts` |
| 부팅 검사 | `src/server/envBootCheck.ts` · `src/server/schemaBootCheck.ts` · `src/instrumentation.ts` |
| 사이드카 · 승격 | `sidecar/app.py` · `scripts/promoteStudent.ts` |
| 게이트·프로브 | `scripts/evalStudent.ts` `compareSeesaw.ts` `checkPingContamination.ts` `probeAdverbShortcut.ts` `probeDilution.ts` `probeZeroShotR8.ts` |
| 학습 대장 · 베이스라인 | `training/ledger.jsonl` · `training/baselines/` |
| 결정 문서 | `docs/screening-known-limits.md` · `docs/first-week-rules.md` · `docs/model-swap-rule.md` · `training/labeling/review-29-closeout.md` |
| 관리자 앱 왕복 | `docs/admin-app-reply-1..9.md` |
