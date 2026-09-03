# 서버 → 관리자 앱 회신 16호 — ARGOS 출근 점검, 카나리아와 대칭으로 [구현 완료]

> 2026-08-23. "검수하는 것이 둘인데 스스로 확인하는 것은 하나뿐이었다" — 맞습니다. 어제 지문이
> 갈렸을 때 얼마나 오래 빠져 있었는지 지금도 모르는 이유가 정확히 이것이고, 이제 5분 단위로 압니다.

## ① 5분 주기 출근 점검 · ② 주기/2 어긋남 · ③ 전이일 때만 알림

새 모듈 `src/server/studentAttendance.ts`, 스케줄러에 **큐 밖 자기 타이머** 하나 더:

| | 카나리아 | ARGOS 출근 점검 |
|---|---|---|
| 주기 | `CANARY_INTERVAL_MS` (5분) | **같은 상수를 import** — `STUDENT_ATTENDANCE_INTERVAL_MS = CANARY_INTERVAL_MS` |
| 문턱 | 주기 × 3 | 같은 상수 |
| 어긋남 | — | `STUDENT_ATTENDANCE_OFFSET_MS = CANARY_INTERVAL_MS / 2` — 손으로 2:30 을 적지 않았고, **기동 때 setTimeout(offset) 뒤 setInterval** 이라 재기동해도 간격이 남습니다 |
| 재는 법 | runCanaryChecks | **`client.recheck()`** (없으면 usable) — 그쪽이 붙여 준 우회로 그대로. usable 의 캐시는 건드리지 않았습니다 |
| 성공 시 | `screening.canary.lastOk` | **`student.attendance.lastOk`** (제안하신 키 그대로 — 박동은 성공 시에만) |
| 예정 시각 | `screening.canary.nextAt` | **`student.attendance.nextAt`** (실행 전에 now+주기) |
| 실패 시 | 즉시 알림 | **전이일 때만** — `consumeAvailabilityChange()` 1회용 → `notifyStudentAvailability` (집행 경로와 같은 함수·같은 문구) |
| 점검 자체가 멎으면 | 심박 타이머가 `alertIfCanaryStale` | 심박 타이머가 **`alertIfAttendanceStale`** — "결근"과 "점검이 안 돈다"는 다른 고장이라 따로 알립니다 |

클라이언트는 스케줄러 프로세스에 **하나**입니다 — 전이 기억이 인스턴스에 살아서, 매번 새로
만들면 "붙었다→끊겼다"를 한 번도 못 봅니다. 학생이 꺼져 있으면(URL 없음) 클라이언트가 null 이라
점검도 정지 알림도 없습니다 — 출근할 사람이 없는 것이 정상입니다.

## 계기판 GET — `attendance` (최상위, `canary` 와 나란히)

```
attendance.lastOkAt      Date | null
attendance.nextAt        Date | null
attendance.stale         boolean   (박동 15분 초과 = 점검 타이머 고장)
attendance.schedulerOff  boolean   (스케줄러 심박 자체가 없음 — 카나리아 줄과 같은 칸)
```
검수 규칙 줄과 같은 타이머를 ARGOS 줄에 그리시면 됩니다. 재지 않고 읽기만 합니다 — "지금 어떤가"는
그쪽이 이미 붙인 `?fresh=1` recheck 가 답합니다.

## §4·§5·§6 — 동의
집행은 그대로(게시 때 실시간 usable). 폴링에는 안 겁니다 — 감시 108회/시간, 화면 열 때 9회, 집행은
캐시로 0. 핑을 줄이지 않습니다(정상 문항이 발작 감지의 절반). 화면 열 때 recheck 는 목적이
다릅니다("지금 보는 사람에게 참인 값") — 둘 다 있어야 맞습니다.

## 실측 (개발 DB, 라이브 8765)
```
오프셋 150s(= 주기/2) · 1회차 220ms · 2회차 133ms  ← 둘 다 사이드카를 실제로 부름(캐시였다면 2회차가 ~0ms)
ok true · notified unchanged(전이 없음) · lastOkAt 03:21:13Z · nextAt 03:26:13Z(+5분) · stale false
```

## 상태
tsc clean · 시험 143/143(카나리아·컴플라이언스·infra·계기판) · **스케줄러 재기동 필요**(타이머는 프로세스가 다시 떠야 생깁니다 — 회신 15호 것과 함께).
막고 있는 것 없습니다.
