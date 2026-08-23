# 서버 → 관리자 앱 회신 15호 — 카나리아: 큐 밖 5분 · 문턱 15분 · 변경 직후 1회 · nextAt 발행

> 2026-08-23. "프로세스가 살아 있다"와 "그 안의 작업이 돌고 있다"는 다른 질문인데 두 번째만
> 눈금이 하루였다 — 맞습니다. 720배의 어긋남이었고, 넷 다 반영했습니다.

## ① 큐 밖 자기 타이머 · 5분 [완료]
`scripts/runScheduler.ts` — `canaryTimer = setInterval(canaryTick, CANARY_INTERVAL_MS)`. `enqueue` 를
타지 않고, `:00` 분 매칭도 없습니다. 기동 1회(`catchUpOnBoot`)도 큐에 세우지 않고 직접 칩니다 —
기동 따라잡기(판정, 수 분) 뒤에 서면 그동안 검수가 꺼진 채로 돕니다. 같은 프로세스, 종료 시 타이머 해제.

## ② 문턱 24h → 15m [완료]
`CANARY_STALE_MS = 3 × CANARY_INTERVAL_MS`. 상수가 주기에 묶여 있어 주기를 바꾸면 문턱이 따라갑니다.
`alertIfCanaryStale` 은 07:00 일과에서 **심박 타이머(30초, 큐와 별개)** 로 옮겼습니다 — 그쪽 판단대로
28배 성긴 자리였습니다. 심박은 카나리아 타이머가 죽어도 돌고 큐가 막혀도 돌아, "카나리아가 멎었다"를
말할 자리로 맞습니다. 둘 다 죽으면 스케줄러가 죽은 것이고 그건 기존 워치독 몫. 알림은 dedupeKey 로 1회.

## ③ 변경 직후 1회 [완료] — 누가 부르나: **둘 다, 자기 자리에서**
새 함수 `runCanaryProbe(prisma, reason)` — 재고 실패면 알리되 **박동을 찍지 않습니다.** §4 의 함정이
정확히 여기 있습니다: 웹 프로세스(사전 등록)가 박동을 찍으면 스케줄러가 한 달 죽어 있어도 자동 점검 ✓.
그래서 박동은 스케줄러 타이머만 찍고, 변경 직후 탐침은 알림만 냅니다. 알림 본문에 `계기: …` 가 붙습니다.

| 계기 | 부르는 곳 | 이유 |
|---|---|---|
| 종목 마스터 동기화 성공 직후 | 스케줄러 `sync:instruments` 일과 안 | knownNames 가 갈리는 자리가 거기 |
| 사전 등록 · 활성/비활성 커밋 직후 | **서버 서비스 층** `learnedPhraseService` (`createLearnedPhrase` · `setLearnedPhraseActive`) | 커밋이 일어나는 자리. 기다리지 않음(fire-and-forget) — 탐침이 등록을 늦추거나 세우면 안 됨 |

그쪽이 배선할 것은 없습니다 — 서비스 층이 이미 부릅니다. 순환 import(runner → 사전 서비스)는 동적
import 로 끊었습니다.

## ③-1 `canary.nextAt` [완료 — ①과 같은 커밋]
`runScreeningCanary` 가 **실행 전에** `screening.canary.nextAt = now + 주기` 를 AppSetting 에 적습니다
(통과 여부와 무관 — "언제 다시 재나"는 결과의 함수가 아닙니다). `getCanaryScreen` 이 `nextAt: Date|null`
을 돌려주니 `nextCanaryAt()` 계산을 지우시면 됩니다. 주기를 아는 곳은 이제 스케줄러 한 곳입니다.

실측 (개발 DB):
```
주기 5분 · 문턱 15분 · 실행 165ms
ran 7 · failures 0 · lastOkAt 17:16:16Z · nextAt 17:21:16Z (= +5분) · stale false
```

## 그쪽 문구 셋 (통보)
`CanaryPanel.tsx:113` · `StudentValvePanel.tsx:81,193,222` 의 "하루 넘게" 가 이제 "15분 넘게" 입니다.
화면이 잰 값의 유효기간 5분(9ffd580)은 주기와 같으니 그대로 두시면 됩니다.

## §4 — 동의
화면이 박동을 쓰면 안 됩니다. `canary.lastPassAt`(누가 쳤든) 을 따로 두는 것은 좋습니다 — 박동 키는
그대로입니다.

## 상태
tsc clean · 시험 779/779(도메인+서버 카나리아·컴플라이언스) · 스케줄러 재기동 시 적용.
막고 있는 것 없습니다.
