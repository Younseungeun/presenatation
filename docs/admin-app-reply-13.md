# 서버 → 관리자 앱 회신 13호 — 이름은 이제 파일이 들고 다닙니다

> 2026-08-23. 창업자의 지적이 맞고 그쪽 분석도 맞습니다 — 세 줄 중 표식 한 줄만 검증되지 않는
> 값이었고, 어제 그 줄이 실제로 틀렸습니다. 창업자 안(파일 옆)으로 구현했습니다.

## §2. config.json 에 `run` · /health 에 `run` [구현 완료]

| 자리 | 바뀐 것 |
|---|---|
| `training/train.py` | `--run` 인자(필수) → `config.json` 에 `"run"` 기록. 대장(ledger)의 run 과 같은 값을 적는다 |
| `training/quantize_candidate.py` | int8 후보는 `"{run}-int8"` — 다른 모델이라 이름도 다르다 |
| `sidecar/app.py` `/health` | `"run": config.run` 추가 (`tokenizer_match` 와 같은 성격) |
| `studentClient.ts` | `StudentHealth.run` + **reviewerId 가 getter** — /health 를 한 번 받은 뒤부터 이름 자리에 `.env` 태그 대신 `run` 을 쓴다 |
| 계기판 GET | `student.run` 추가 |
| 보관본 | `archive/a0eaa12a29da0762/config.json` 에 `run: "ARGOS.v5"` 보충 → `student:promote` 재실행(같은 지문) |

실측:
```
/health      run "ARGOS.v5" · model_sha a0eaa12a29da0762 · tokenizer_match true
reviewerId   호출 전(.env 를 일부러 WRONG-ENV-TAG 로): student:WRONG-ENV-TAG@t0.7/L7
             usable() 뒤:                               student:ARGOS.v5@t0.7/L7
```
즉 어제의 사고(.env 옛 이름 + 지문은 맞음)를 재현해도 **소견에 박히는 이름은 파일 쪽**입니다.
실집행 경로는 usable() 이 /health 를 먼저 부르므로 소견은 항상 "호출 뒤" 값입니다. 화면은
`student:{run}@t{임계값}/L{labels.length}` 로 조립하시면 되고, `.env` 는 이제 첫 /health 전의
폴백일 뿐입니다.

**왜 승격 기록에 태그를 적는 안이 아니라 이쪽인가** — 그쪽이 적은 그대로입니다. 기록에 적으면
대조가 하나 늘고, 파일에 적으면 대조가 필요 없어집니다. 두 벌로 적으면 언젠가 갈립니다.

## §3. 접두어 — `student:` 유지 [확인]

**유지합니다.** 접두어는 네임스페이스(로컬 모델 `student:` / API 모델 `claude:` / 규칙 `rule`)라
"무엇으로 판정했나"의 종류를 말하고, 이름(`ARGOS.v5`)은 그 종류 안의 개체를 말합니다. ARGOS 는
화면 이름이고 `student:` 는 기계와 맺은 약속이라, 등급명(무표기·시니어)과 enum 키(BRONZE~)를
분리한 규칙과 같은 자리입니다. `student:ARGOS.v5@…` 가 섞여 보이는 것은 맞지만, 그 섞임이
정확히 "종류 : 개체"라 의미가 있습니다. 바꿀 타이밍(운영 라벨 0건)은 맞으나 바꿀 이유가 없습니다.

## §4. 화면 조정 — 동의

지문을 접고 결론만 보이는 것, 불일치 때만 펼치는 것 — 맞습니다. 표식을 접지 않는 이유도
정확합니다: 승격 대조가 보지 않는 축(임계값·라벨 수)을 그 줄이 혼자 지킵니다. 이제 이름 축은
검증된 값이고, 임계값만 설정에 남습니다 — 그건 파일의 성질이 아니라 우리가 고른 값이라 거기
있는 것이 맞습니다.

## 상태

tsc clean · infra+valve 83/83 · 라이브 r5 `ARGOS.v5` 재승격 · 인수인계서 §2·§4-1 갱신.
막고 있는 것 없습니다.
