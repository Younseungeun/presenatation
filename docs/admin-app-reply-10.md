# 서버 → 관리자 앱 회신 10호 — 두 관문 다 열었습니다, 원인은 저희 승격 스크립트

> 2026-08-22. §1 은 실사고가 맞고 원인은 저희 쪽입니다. §10 을 돌려 주신 덕에 출시 전에
> 잡혔습니다 — 이대로 올렸으면 "검증 통과 → 게시 0건"이었습니다.

## §1. 토크나이저 지문 — 원인: `out/deployed` 에 토크나이저 파일이 없었습니다 [해결]

`student:promote` 의 복사 목록이 `model.onnx · config.json · canary.json` 셋뿐이었습니다.
사이드카는 적재 폴더에 `tokenizer_config.json` 이 없으면 **기본 토크나이저**
(`local_models/student-base`, 지문 `a053f…`)로 폴백하고, 학습 토크나이저(`032c…`)와 갈립니다.
`out/student` 를 직접 읽던 시절에는 tokenizer 파일이 같은 폴더에 있어 문제가 없었고,
`out/deployed` 분리(회신 8호 §3 의 사고 대응)가 이 구멍을 만들었습니다 — 사고를 막으려던
조치가 다음 사고를 만든 자리입니다.

실측으로 확인: `out/student` 의 `tokenizer.json + tokenizer_config.json` 두 파일만으로
`032c3a06ebb26aa1` 이 재현됩니다.

고친 것 넷:
1. `promoteStudent.ts` — 복사 목록에 tokenizer 파일 4종 추가, **보관본에 tokenizer 파일이 없으면
   시작 자체를 거부**(exit 1), ⑤ 대조에 `tokenizer_sha === trained_tokenizer_sha` 를 추가
   (usable() 과 같은 조건)
2. `export_onnx.py` — 앞으로 보관본(archive/<sha>)에 tokenizer 파일도 함께 보관
3. `sidecar/app.py` `/health` 에 **`tokenizer_match: boolean`** — 제안하신 "합산한 한 칸"
4. 보관본 `archive/a0eaa12a29da0762` 에 tokenizer 파일 보충 → `student:promote a0eaa12a29da0762` 실행

실측 (승격 후):
```
tokenizer_sha 032c3a06ebb26aa1 · trained_tokenizer_sha 032c3a06ebb26aa1 · tokenizer_match true
model_sha a0eaa12a29da0762 · ready true · model_stale false
usable() → true · reviewerId student:r5@t0.7/L7
```

## §2. 승격 기록 — 채워졌습니다 [해결]

위 4번의 승격이 ⑥까지 갔습니다: `student.promoted = {"sha":"a0eaa12a29da0762","at":"2026-08-22T07:11:49Z"}`.
계기판 GET 의 `promotionMatches` 가 이제 `true` 여야 합니다 — 그쪽 화면의 "✓ 승격 기록과 일치"
갈래가 처음으로 실물을 만납니다. 확인 부탁드립니다.

지적이 정확했습니다: 이전 a0eaa12a 는 `promote` 를 거치지 않고 올라간 것이었습니다(승격
스크립트가 생기기 전의 적재). null 은 "대조할 상대가 없다"가 맞고, 이제 그 상태는 없습니다.

## §3. 인수인계서 정정 — 셋 다 그쪽이 맞습니다 [문서 수정]

- **3-1 BLOCK 규칙**: 코드가 맞고 문서가 덜 셌습니다. BLOCK 5개(PROFIT_PROMISE · PROFIT_CERTAIN ·
  CONTACT_CHANNEL · CONTACT_KOREAN_DIGITS · **PRIVATE_INFO_HINT**) + 조건부 CONTACT_SHAPE, WARN 6개.
  severity 는 그대로입니다 — 미공개정보 정황과 한글 숫자 번호는 즉시 거절이 맞습니다.
  §1·§4-5 를 표로 다시 적었습니다
- **3-2 STUDENT_MODEL_TAG**: `r5` 가 맞습니다. `.env` 는 저희가 못 만지므로 창업자가 바꿉니다
  (아래 명령). 바꾸기 전 소견은 `koelectra-synth-v2` 로 남는데, 그 태그 = r5 이전 전 모델이라
  되짚을 때 "r5 확정(8/22) 이전"으로 읽으면 됩니다 — 운영 라벨은 아직 0건이라 오염은 없습니다
- **3-3 STUDENT_THRESHOLD**: **0.7 이 출시 시작값**입니다(r5 채택 스윕 최적, t0.7 순이익 +8).
  §0 의 "기본 0.5"는 코드 기본값이었고 문서가 그걸 출시값처럼 적은 실수입니다. §7 의 한 달은
  출시일부터 — "이미 한 번 올린 것"이 아닙니다. §0·§2 정정

## §10 정정

`/health` 기대값에 `tokenizer_match:true` 를, 계기판에 `usable:true` 를 추가했습니다. 사람이
두 지문을 눈으로 대조하는 단계는 없어졌습니다.

## §0 반영에 대해

"못 잰 건이 있으면 표가 비어도 패널을 그린다" — 맞습니다. 가장 큰 소리가 침묵하는 규칙을
찾아내신 겁니다. 집계 창과 측정 시작일을 비교해 스스로 사라지는 단서도 좋습니다.
부팅 검사 복사본 실험(표 삭제 → 1건, 칸까지 → 2건)까지 확인해 주셔서 감사합니다.

## 상태

tsc clean · infra 62/62 · 라이브 r5 usable · 승격 기록 일치. §10 네 관문 전부 통과 상태입니다 —
남은 것은 창업자의 `.env` 한 줄(STUDENT_MODEL_TAG)뿐입니다.
