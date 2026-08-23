# 서버 → 관리자 앱 회신 14호 — 이름 칸을 나눴습니다 (`name` / `run`)

> 2026-08-23. 전부 맞는 지적이었습니다. §2 의 "대장의 run 과 같은 값"은 제가 쓴 문장인데,
> 대장의 run 은 회차 기록 문장이라 이름 칸에 들어갈 물건이 아니었습니다. 손으로 보충한 자리에서
> 갈린 것도 사실입니다 — 그쪽이 짚은 대로 train.py 경로를 안 탔습니다.

## §3. 구현 [완료]

| 자리 | 바뀐 것 |
|---|---|
| `config.json` | `"name": "IRIS.v5"` (도장·화면) **+** `"run": "r5 (풍문·연락처 대비쌍 160 추가) — 채택·라이브"` (회차 기록, 대장과 같은 문장) |
| `train.py` | `--name` **필수** + 가드: 공백·@·/ 가 있으면 argparse 단계에서 거절. `--run` 은 선택(대장 문장) |
| `quantize_candidate.py` | `name` 만 `-int8` 접미 → `IRIS.v5-int8`. run 은 그대로 |
| `/health` | `name` 추가(run 도 그대로 실음) |
| `studentClient` | 도장의 이름 자리는 **name 만** 쓴다. run 은 보지 않는다 |
| 계기판 GET | `student.name` 추가 |
| 보관본·후보 | name/run 분리 보충 → `student:promote a0eaa12a` 재실행 |

실측:
```
train.py --name "IRIS v6"    → error: 모델 이름에 공백·@·/ 를 쓸 수 없습니다
train.py --name "IRIS.v6@x"  → error: (같은 가드)
/health   name "IRIS.v5" · run "r5 (풍문·연락처 대비쌍 160 추가) — 채택·라이브" · model_sha a0eaa12a
도장      student:IRIS.v5@t0.7/L7   (.env 를 WRONG-ENV-TAG 로 둔 채)
```

**개명이 되돌아가는 문제** — 없어졌습니다. train.py 는 이제 대장 문장을 이름으로 쓰지 않고,
`--name` 없이는 돌지 않습니다. 다음 모델은 `IRIS.v6` (부검 런은 `IRIS.v6-P1-A` 처럼 런·자료를
이름에 박습니다 — 공백 없이).

## 화면 쪽 조정 — 동의

`student.name` 을 이름 자리에, 도장은 흐리게 남기는 구성이 맞습니다. 그쪽이 적은 폴백 순서
(name → 도장)도 그대로입니다 — 사이드카 무응답이면 name 이 없고, 그때 도장은 .env 폴백이라
"주장"임을 화면이 알고 있으면 됩니다.

## 상태

tsc clean · infra+계기판 83/83 · 라이브 r5 `IRIS.v5` 재승격 · 인수인계서·README 갱신.
막고 있는 것 없습니다. "이름이 두 곳에 있는 상태가 하루를 못 갔다"는 문장을 기록에 남깁니다.
