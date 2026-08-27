# 로컬 소형 LLM 2단 검수 — 후보 반입 목록 (36차 MM-1 승인 이행)

사장님이 브라우저로 받아 넣으실 목록입니다 (110M 가중치 반입과 같은 방식 —
이 환경은 huggingface.co 차단이라 제가 직접 못 받습니다).
전부 **로컬 실행 파일·가중치**라 추가 비용 0, 외부 API 호출 0입니다.

## 넣을 위치

```
presenatation/local_models/llm2/        ← 모델 gguf 파일들
presenatation/local_models/llm2/llama.cpp/   ← 실행기 압축 해제
```

(`local_models/` 는 이미 .gitignore — 저장소에 안 들어갑니다)

## 0. 실행기 (필수 1개) — llama.cpp Windows 빌드

- 주소: https://github.com/ggml-org/llama.cpp/releases (최신 릴리스)
- 받을 파일: Assets 중 **`llama-b____-bin-win-cpu-x64.zip`** (구버전 이름은
  `…win-avx2-x64.zip` — 개발 PC i7-9700F 는 AVX2 지원이라 둘 다 됩니다). 수십 MB
- 왜 이것: 검토자 지시가 **GBNF 문법 강제**(JSON 형식을 프롬프트가 아니라 문법으로
  강제)인데, 이 기능이 llama.cpp 에 내장돼 있습니다. 서버 모드(`llama-server`)를
  localhost 로 띄워 하네스가 두드립니다 — 외부로는 아무것도 안 나갑니다

## 1. 모델 후보 (2~3종 반입 — 실측으로 고릅니다)

⚠ **받기 전에 각 모델 페이지의 라이선스를 한 번 확인해 주세요** (상업적 이용 허용
여부). 아래 표기는 제 지식 기준이라 페이지 원문이 우선입니다 — 특히 ③④.

### ① Qwen3-4B-Instruct (주력 후보 — 4B급 최강, 라이선스 확실)

- 페이지: https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507-GGUF
- 받을 파일: **`Qwen3-4B-Instruct-2507-Q4_K_M.gguf`** (약 2.5GB)
- 라이선스: Apache 2.0 (상업 이용 자유)
- 한국어: 다국어 학습이 강해 4B급에서 한국어 문맥 이해 상위

### ② Gemma 3 4B it (대조 후보 — 다국어 강함)

- 페이지: https://huggingface.co/google/gemma-3-4b-it-qat-q4_0-gguf
  (구글 공식 양자화판. 다운로드에 구글 약관 동의 버튼이 뜰 수 있습니다)
- 받을 파일: 그 저장소의 `.gguf` (약 3GB)
- 라이선스: Gemma 라이선스 — 상업 이용 허용, 금지 용도 정책 준수 조건

### ③ 한국어 특화 1종 (아래 중 라이선스가 허용하는 것 하나)

- **Kanana 1.5 2.1B instruct** (카카오): https://huggingface.co/kakaocorp — `kanana-1.5-2.1b-instruct` 계열.
  1.5 세대가 상업 허용으로 공개됐다고 알고 있으나 **페이지에서 확인 필수**
  (1.0 세대는 비상업이었습니다). GGUF 판이 없으면 safetensors 로 받아도 됩니다(제가 변환)
- **HyperCLOVA X SEED 1.5B** (네이버): https://huggingface.co/naver-hyperclovax —
  `HyperCLOVAX-SEED-Text-Instruct-1.5B`. 라이선스 원문 확인 필수
- ⚠ **EXAONE (LG) 은 제외** — 한국어 성능은 최상급이지만 라이선스가 연구 전용
  (비상업)이라 우리 용도에 못 씁니다. 받지 마세요

### ④ (선택) 처리량 예비 — Qwen3-1.7B

- https://huggingface.co/Qwen/Qwen3-1.7B-GGUF 의 `…Q4_K_M.gguf` (약 1.1GB, Apache 2.0)
- 4B 가 처리량 반증 조건(큐가 게시량을 못 따라감)에 걸릴 때의 체급 다운 카드.
  미리 받아 두면 실측을 한 번에 끝냅니다

## 2. 반입 후 진행 (제 몫)

1. llama-server 기동 확인 + **GBNF JSON 문법** 작성 (형식 붕괴 반증 조건: 문법을
   쓰고도 파싱 가능 JSON < 95% → 폐기)
2. 오프라인 하네스: 같은 잣대(채점지 86 + 문서 34 + r6 264 + 홀드아웃 101)를
   IRIS P1-A 와 나란히 실측 — LLM 은 전부 zero-shot 이라 오염 없음
3. 처리량 실측: 운영 대리 분포 100건, 건당 시간·시간당 처리량 vs 예상 게시량 ×2
4. 결과표 보고 → 검토자 편입 판정

채택선(사전 등록): r6 λ=4 순이익 > P1-A(+75) · 부정형 오탐 ≤ 3 · risk_heavy 오탐
증가 0 · 처리량 ≥ 피크 ×2. 셋 중 하나라도 반증이면 트랙 폐기, 현 3겹 유지.
