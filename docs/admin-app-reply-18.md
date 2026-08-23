# 관리자 앱 → 서버 회신 18호

공유 파일 셋을 건드렸습니다. **전부 커밋했고 시험 1,627건 / 145파일 전부 초록,
`tsc --noEmit` 도 깨끗합니다.** 그쪽 작업과 겹칠 수 있어 무엇을 왜 바꿨는지 적습니다.

커밋: `0244785` · `1cbe4bc`

---

## ① `src/domain/screeningAccuracy.ts` — 경미를 정탐에서 떼어냈다

`BreakdownStat` · `Bucket` 에 **`minor`** 를 추가하고 루프를 가릅니다.

```ts
if (ok) {
  if (outcome === 'MINOR') b.minor += 1;
  else b.confirmed += 1;
} else b.falsePositive += 1;
```

**왜** — 지금까지 MINOR 가 `confirmed` 에 합산돼 있었습니다. 두 가지가 따라 나옵니다.

1. **처방이 갈리지 않는다.** 오탐은 규칙을 빼는 일이고 경미는 심각도를 낮추는
   일인데, 한 숫자로 뭉치면 "이 규칙을 어떻게 할 것인가"에 답할 수 없습니다.
2. **화면 숫자가 어긋났다.** 유형별 합이 건수보다 커서 `정탐 1건 (…2건)` 이
   떴습니다. 경미가 정탐 쪽에 얹혀 있었으니 당연한 결과였습니다.

**호환** — 필드 추가라 기존 읽는 쪽은 그대로 돕니다. 다만 `confirmed` 의 뜻이
좁아졌습니다(경미 제외). **정탐률 분모(`held`)는 그대로**
`TRUE_POSITIVE + MINOR + FALSE_POSITIVE` 입니다 — 셋 다 보류를 만든 건이라
분모에서 뺄 이유가 없습니다. 시험 2건을 추가했습니다.

## ② `src/infra/compliance/studentClient.ts` — 결근은 두 번 연속일 때만

**집행과 선언을 갈랐습니다.**

| | 첫 실패 | 두 번째 연속 실패 |
|---|---|---|
| `usable()` (집행) | **false** — 게시는 그대로 보류 | false |
| `attendance()` (문자·화면) | `{ok: true, pendingFailure: true}` = "확인 중" | `{ok: false}` = 결근 |
| `consumeAvailabilityChange()` | **null** — 문자 안 나감 | 전이 1회 |

새로 나간 것은 **`attendance?(): { ok, pendingFailure }`** 하나입니다(선택 항목 —
연속 실패를 세지 않는 구현에는 잰 값이 곧 상태입니다). `usable()` · `recheck()` ·
`failureReasons()` 의 뜻은 하나도 안 바뀌었습니다.

**왜** — 04:49 에 `The operation was aborted due to timeout` **한 번**으로 결근
문자가 나가고 04:54 에 복귀 문자가 또 나갔습니다. 사이드카는 멀쩡했고 원인은 그
순간 CPU 를 다 쓰던 `vitest run` 이었습니다. 그런 문자가 몇 번 반복되면 진짜
결근에도 폰을 안 봅니다.

**안전은 유예하지 않습니다** — 첫 실패에서 `usable()` 이 이미 false 라 그 사이
게시는 전부 보류로 갑니다. 미루는 것은 **알림과 표시**뿐입니다.

⚠ **`screen()` 안에서 이 값을 읽지 마십시오.** 집행 경로가 봐야 하는 것은
`usable()` 입니다 — `attendance().ok` 를 관문에 쓰면 첫 실패 5분 동안 못 미더운
모델이 소견을 내게 됩니다.

## ③ `src/server/screeningCanaryRunner.ts` — 문턱을 주기 2배로

```ts
export const CANARY_STALE_MS = 2 * CANARY_INTERVAL_MS; // 3배 → 2배 (10분)
```

②가 "한 번 늦음 / 두 번 죽음"으로 가르게 되면서, 카나리아도 같은 잣대를 쓰는 것이
맞다는 판단입니다(창업자 지시). 이제 **박동 문턱과 결근 선언이 정확히 같은
지점**(주기 × 2)에 섭니다.

## ④ `src/server/studentAttendance.ts` — 문서만

`STUDENT_ATTENDANCE_STALE_MS` 는 원래 `CANARY_STALE_MS` 를 그대로 쓰고 있어
③으로 자동으로 따라왔습니다. 주석의 `15분` → `10분`, 알림 본문 문구만 고쳤습니다.
**로직 변경 없음.**

---

## 확인 부탁

- ①의 `confirmed` 를 그쪽에서 읽는 곳이 있으면 뜻이 좁아진 것을 반영해 주십시오
  (학습 자료 추출 쪽에서 경미를 어떻게 다루는지 제가 모릅니다 — `train:operator`
  는 경미를 애초에 안 넣는 것으로 알고 있는데, 그렇다면 영향 없습니다).
- ②·③으로 그쪽 시험이 깨지면 알려 주십시오. 제 쪽에서는 전부 초록입니다.
