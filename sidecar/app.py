"""검수 학생 모델 사이드카 — 웹(Next.js)이 localhost HTTP로 부르는 추론 서비스.

**왜 별도 프로세스이고 왜 Python인가** (5차 검토 F-1 확정):
학습이 Python HuggingFace 토크나이저를 쓰는데 서빙을 Node에서 하면, 토큰이 한 자리만
다르게 잘려도 **예외 없이 조용히** 추론이 무너진다. 같은 런타임에서 서빙하면 그 위험이
질문 자체로 사라진다. 웹 프로세스에 얹지 않는 이유는 하나 더 있다 — 이 저장소의 웹
인스턴스는 SQLite 쓰기 직렬화 때문에 1벌로 잠겨 있어서, 거기서 CPU를 더 쓰면 늘릴
방법이 없다. HTTP 호출은 Node 비동기 I/O라 DB 락을 잡지 않는다.

**지금은 가중치 없이도 돈다 (6차 F-1 — 토크나이저 스텁).**
model.int8.onnx가 없으면 토크나이저만 올리고 소견은 빈 배열을 돌려준다. 그 상태로도
배관(요청·응답·실패 처리·그림자 기록)과 **토크나이저 지문 대조**를 실측할 수 있다 —
이 스레드에서 가장 큰 위험이 배관이 아니라 토크나이저 동일성이므로, 스텁이 재는 것이
곁가지가 아니라 본체다.

실행:  py -m uvicorn app:app --port 8765
"""
import hashlib
import json
import os
import time
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel
from transformers import AutoTokenizer

import sys

# 학습과 **같은** 계약을 쓴다 — 여기 다시 적으면 두 지문이 조용히 갈라진다.
# train.py가 아니라 contract.py에서 가져오는 이유: train.py는 torch를 import하는데
# 이 사이드카는 토크나이저만으로도 떠야 한다 (가중치 없이 배관을 먼저 검증한다).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "training"))
from contract import (  # noqa: E402
    CANARY_FILE,
    CANARY_TEXTS,
    MAX_LEN,
    tokenizer_fingerprint,
)

# **적재 경로 = 채택본 전용 디렉터리** (2026-08-22 실사고 후 분리).
#
# 전에는 out/student 를 직접 읽었다 — 그 디렉터리는 export_onnx.py 가 **후보**를 쓰는
# 곳이기도 해서, 후보를 내보낸 뒤 어떤 이유로든 사이드카가 재기동되면 **채택 게이트를
# 통과하지 않은 모델이 그대로 라이브**가 됐다(r6 기각본 d8a36c79 가 실제로 8765 에
# 올라가 있었다). 후보(out/student)와 채택본(out/deployed)을 디렉터리로 가른다:
#   내보내기 → out/student + archive/<sha>   (라이브 무관)
#   채택     → npm run student:promote -- <sha>  (archive → out/deployed) + 작업 재기동
# out/deployed 가 없으면 옛 경로로 되돌아간다 — 첫 승격 전까지의 호환.
_OUT = Path(__file__).resolve().parent.parent / "training" / "out"
# 후보 평가용 명시 경로 — 게이트는 후보(out/student)를 별도 포트에서 재야 한다:
#   STUDENT_ARTIFACT_DIR=../training/out/student python -m uvicorn app:app --port 8766
_ENV_DIR = os.environ.get("STUDENT_ARTIFACT_DIR")
ARTIFACT = (
    Path(_ENV_DIR).resolve()
    if _ENV_DIR
    else (_OUT / "deployed" if (_OUT / "deployed" / "model.onnx").exists() else _OUT / "student")
)
BASE = Path(__file__).resolve().parent.parent / "local_models" / "student-base"

app = FastAPI(title="intovill-screener-sidecar")

_tokenizer = None
_session = None
_model_file = None  # 실제로 읽은 아티팩트 — /health가 밝힌다 (무엇이 배포됐는지 숨기지 않는다)
_model_stat: tuple | None = None  # 적재 시점의 (크기, mtime) — 아래 주석 참고
_model_sha: str | None = None
_config: dict = {}
_ready = False          # 카나리아 통과 여부 — 소견을 낼 자격이 있는가
_ready_detail = "미검사"  # 왜 아닌지. **이유를 말하지 않는 거부는 진단을 지운다**


def _load():
    """토크나이저는 필수, 모델은 선택. 모델이 없으면 스텁 모드로 뜬다.

    **반쯤 켜진 상태를 만들지 않는다**: 토크나이저조차 없으면 아예 뜨지 않고,
    모델이 없으면 그 사실을 /health가 분명히 말한다. 웹 어댑터는 그 값을 보고
    소견을 쓰지 않는다 — 조용히 빈 결과를 정답처럼 쓰는 것이 가장 나쁘다.
    """
    global _tokenizer, _session, _config, _model_file
    if _tokenizer is not None:
        return
    src = ARTIFACT if (ARTIFACT / "tokenizer_config.json").exists() else BASE
    _tokenizer = AutoTokenizer.from_pretrained(str(src))
    cfg = ARTIFACT / "config.json"
    _config = json.loads(cfg.read_text(encoding="utf-8")) if cfg.exists() else {}
    # int8이 있으면 그것을, 없으면 fp32를 읽는다. 양자화는 필수가 아니다 —
    # 브라우저 예산이 폐기돼(3차 F-4) 서버에서 56MB는 제약이 아니기 때문.
    # 순서를 int8 우선으로 두는 이유는 크기가 아니라 **CPU 추론 속도**다.
    global _model_stat, _model_sha
    for name in ("model.int8.onnx", "model.onnx"):
        path = ARTIFACT / name
        if path.exists():
            import onnxruntime  # 모델이 있을 때만 — 스텁 모드에서는 의존성도 안 탄다
            _session = onnxruntime.InferenceSession(str(path), providers=["CPUExecutionProvider"])
            _model_file = name
            # **무엇을 적재했는지 지문으로 남긴다.** 파일 이름은 언제나 model.onnx라
            # 이름만으로는 어느 가중치인지 구별할 수 없다 — 9차에 실제로 그래서 틀렸다.
            st = path.stat()
            _model_stat = (st.st_size, int(st.st_mtime))
            _model_sha = hashlib.sha256(path.read_bytes()).hexdigest()[:16]
            break
    _run_canary()


def _run_canary() -> None:
    """**기동 시 파이프라인 스모크 테스트** (9차 G-1 · 11차 K-3 명칭 교정).

    ⚠ 가중치 무결성 검사가 아니다 — 그쪽은 model_sha 가 전담한다.
    여기가 잡는 것은 **라벨 순서 · 토크나이저 · 출력 차원 · 그래프 결합성**이다
    (근거: training/mutation_test.py — 로짓 대조만으로는 비트 훼손의 90%가 통과했다).

    파일마다 지문을 하나씩 더 다는 것은 블랙리스트 방어라 끝이 없다. 대신 미리 구워 둔
    입력을 지금 이 스택(토크나이저 + 적재한 그래프 + 라벨 순서)으로 통과시켜, 내보내기가
    본 것과 같은 답이 나오는지 한 자리에서 본다. 가중치·라벨 순서·어휘·차원 중
    **하나라도** 어긋나면 출력 벡터가 달라지므로 개별 검사가 필요 없다.

    **실패해도 프로세스를 죽이지 않는다** (9차에 정한 것). 죽이면 웹이 보는 것이
    "연결 거부"뿐이라 *안 떴다*·*죽었다*·*라벨이 어긋났다*가 구별되지 않는다 —
    이번 회차에 나를 구한 것이 정확히 그 반대였다(살아서 틀린 값을 말해 준 프로세스).
    감시자를 붙이면 재기동 루프가 되어 진단 가능한 실패가 로그 폭우로 바뀌기도 한다.
    대신 `ready=False`로 남아 **이유를 말하고**, `/screen`은 스스로 소견을 거부한다.
    """
    global _ready, _ready_detail
    if _session is None:
        _ready, _ready_detail = False, "스텁 모드 — 가중치 없음"
        return
    path = ARTIFACT / CANARY_FILE
    if not path.exists():
        # **없으면 통과가 아니라 미검증이다.** 검사할 수 없는 상태를 통과로 적으면
        # 카나리아를 둔 이유가 사라진다. export_onnx.py 를 다시 돌리면 생긴다.
        _ready, _ready_detail = False, f"{CANARY_FILE} 없음 — export_onnx.py 를 다시 돌리십시오"
        return
    try:
        import numpy as np
        spec = json.loads(path.read_text(encoding="utf-8"))

        # ⓐ 라벨 순서 — 값 대조로는 안 잡히는 유일한 어긋남이다.
        #    순서가 바뀌면 로짓은 그대로인데 **뜻이 달라진다**.
        if spec.get("labels") != _config.get("labels"):
            _ready, _ready_detail = False, "라벨 순서가 카나리아와 다릅니다"
            return
        # ⓑ 어느 파일로 구웠는가 — int8을 구워 놓고 fp32를 들면 오차 문턱이 안 맞는다
        if spec.get("model_file") != _model_file:
            _ready, _ready_detail = False, (
                f"카나리아는 {spec.get('model_file')} 로 구웠는데 {_model_file} 을 적재했습니다"
            )
            return
        # ⓑ' **이름이 아니라 내용으로 대조한다.** 이름은 늘 model.onnx라, 옛 canary.json
        #    옆에 새 가중치를 손으로 복사하면 ⓑ는 통과한다 — 카나리아 자신이 이 계열의
        #    취약점이 되는 자리였다. 로짓 대조가 어차피 걸러내지만, 그때는 "값이 다르다"만
        #    알 수 있고 **왜** 다른지는 모른다. 이 줄이 그 이유를 말해 준다.
        baked = spec.get("model_sha")
        if baked and baked != _model_sha:
            _ready, _ready_detail = False, (
                f"카나리아는 가중치 {baked} 로 구웠는데 지금 적재한 것은 {_model_sha} 입니다"
            )
            return

        tol = float(spec.get("tol", 1e-3))
        worst = 0.0
        for text, expected in zip(CANARY_TEXTS, spec["logits"]):
            ids = _tokenizer(text, truncation=True, max_length=MAX_LEN)["input_ids"]
            got = _session.run(None, {
                "input_ids": np.array([ids], dtype=np.int64),
                "attention_mask": np.ones((1, len(ids)), dtype=np.int64),
            })[0][0]
            if len(got) != len(expected):
                _ready, _ready_detail = False, f"출력 차원 {len(got)} ≠ 카나리아 {len(expected)}"
                return
            worst = max(worst, float(np.max(np.abs(np.array(expected) - got))))
        if worst >= tol:
            _ready, _ready_detail = False, f"카나리아 로짓 오차 {worst:.2e} ≥ {tol:.0e}"
            return
        _ready, _ready_detail = True, f"카나리아 {len(CANARY_TEXTS)}건 통과 (최대 오차 {worst:.2e})"
    except Exception as e:  # noqa: BLE001 — 어떤 이유든 준비 안 된 것으로 본다
        _ready, _ready_detail = False, f"카나리아 실행 실패: {type(e).__name__}: {e}"


class ScreenBatchRequest(BaseModel):
    """창 분할 채점용 — 같은 문서의 창 여러 개를 **한 요청**으로 받아 채점한다.

    32차 II-4 (a). 여기서 아끼는 것은 **HTTP 왕복**이지 ONNX 배치가 아니다 — 실측
    (2026-08-25, 110M·i7-9700F): 패딩 배치는 창당 82~123ms 로 낱개 실행(65~83ms)보다
    느렸다(메모리 대역폭 병목 + 패딩 헛계산 — 검토자의 gap 17 경고 그대로). 반면 요청
    하나의 왕복·파싱 비용이 창당 ~45ms 라, 이것을 없애는 것이 실제 이득의 전부다.
    그래서 서버 안에서는 **낱개로 순차 실행**한다(각 창이 제 길이로 돈다).
    """
    texts: list[str]
    threshold: float = 0.5


class ScreenRequest(BaseModel):
    """입력은 **이미 조립된 문자열 하나**다.

    카드·제목·요약·본문을 여기서 다시 합치지 않는다 — 그 직렬화는
    src/domain/studentText.ts의 buildStudentText 한 곳에만 있어야 하고,
    사이드카가 자기 방식으로 합치면 그 규칙이 두 곳으로 갈라진다.
    """
    text: str
    threshold: float = 0.5


def _model_is_stale() -> bool:
    """**적재한 뒤 디스크의 가중치가 바뀌었는가.**

    9차에 실제로 일어난 사고: 새 모델을 내보내고 사이드카를 다시 띄웠는데 옛 프로세스가
    죽지 않아 포트를 계속 쥐고 있었다. `/health`는 `model_file: "model.onnx"`라고 답했고
    토크나이저 지문도 맞았다 — **어느 쪽도 가중치를 보지 않았기 때문**이다. 그 상태로
    잰 값을 새 모델의 성적으로 보고했다.

    해시를 다시 계산하지 않고 (크기, mtime)만 본다. 56MB를 매 호출 해싱하면 /health가
    수백 ms가 되는데, 잡으려는 것은 "파일이 바뀌었다"이지 "내용이 같은가"가 아니다.
    """
    if _model_file is None or _model_stat is None:
        return False
    try:
        st = (ARTIFACT / _model_file).stat()
    except OSError:
        return True  # 적재한 파일이 사라졌다 — 낡은 것으로 본다
    return (st.st_size, int(st.st_mtime)) != _model_stat


@app.get("/health")
def health():
    """어댑터가 확인하는 값. **지문이 다르거나 낡았으면 웹은 소견을 쓰지 않는다.**"""
    _load()
    return {
        "ok": True,
        "stub": _session is None,  # True면 소견을 내지 않는 스텁 모드
        "tokenizer_sha": tokenizer_fingerprint(str(ARTIFACT if (ARTIFACT / "tokenizer_config.json").exists() else BASE)),
        "trained_tokenizer_sha": _config.get("tokenizer_sha"),
        # 모델의 이름 — config.json 이 들고 다닌다 (회신 13호). .env 의 태그는 주장이고 이것이 사실이다
        "name": _config.get("name"),  # 짧은 이름 — 도장·화면용 (회신 14호)
        "run": _config.get("run"),    # 회차 기록 — 대장과 같은 문장, 사람이 읽는 용도
        # 위 둘의 일치 여부를 합산한 한 칸 — 사람이 두 지문을 눈으로 대조하는 일은 언젠가 건너뛴다 (회신 10호)
        "tokenizer_match": _config.get("tokenizer_sha") is None or _config.get("tokenizer_sha") == tokenizer_fingerprint(str(ARTIFACT if (ARTIFACT / "tokenizer_config.json").exists() else BASE)),
        "model_file": _model_file,
        # 적재한 **가중치**의 지문. 파일 이름은 늘 같으므로 이 값이 유일한 신원이다
        "model_sha": _model_sha,
        # 적재 뒤 디스크의 파일이 바뀌었다 = 이 프로세스는 옛 가중치를 서빙 중이다
        "model_stale": _model_is_stale(),
        # 카나리아 통과 여부. 웹의 usable() 이 이 값을 보고 실집행에서 뺀다 —
        # 판단은 한 곳(usable)에 두고, 사이드카는 사실만 말한다
        "ready": _ready,
        "ready_detail": _ready_detail,
        "labels": _config.get("labels", []),
        "max_len": MAX_LEN,
    }


@app.post("/screen")
def screen(req: ScreenRequest):
    """소견을 낸다. 스텁 모드에서는 토큰 정보만 돌려준다.

    스텁이 돌려주는 token_ids 앞부분은 장식이 아니다 — 학습 쪽에서 같은 문자열을
    토큰화한 결과와 대조하면, 가중치 없이도 토크나이저 동일성을 실측할 수 있다.
    """
    _load()
    started = time.perf_counter()
    enc = _tokenizer(req.text, truncation=True, max_length=MAX_LEN)
    ids = enc["input_ids"]
    out = {
        "token_count": len(ids),
        "token_ids_head": ids[:5],
        "findings": [],
        "stub": _session is None,
    }
    # **준비되지 않았으면 소견을 만들지 않는다.** usable() 이 이미 막지만, 생산자가
    # 쓰레기를 안 내보내는 것과 소비자가 안 쓰는 것은 다른 층의 방어다 —
    # usable() 을 거치지 않는 호출자가 생기는 날 이 줄이 유일한 방어가 된다.
    out["ready"] = _ready
    if _session is not None and _ready:
        import numpy as np
        # **패딩하지 않는다.** ONNX 그래프의 seq 축이 동적이라 실제 길이 그대로 넣으면 되고,
        # MAX_LEN까지 채우면 30토큰 문장에 768칸을 계산시키는 셈이다 (7차 E-3).
        # 학습도 같은 이유로 배치 최댓값까지만 채운다 — 패딩 자리는 attention_mask가 0이라
        # 결과가 달라지지 않고, 달라지는 것은 헛계산의 양뿐이다.
        logits = _session.run(
            None,
            {
                "input_ids": np.array([ids], dtype=np.int64),
                "attention_mask": np.array([[1] * len(ids)], dtype=np.int64),
            },
        )[0][0]
        probs = 1 / (1 + np.exp(-logits))
        labels = _config.get("labels", [])
        # 임계값은 **단일**이다 (3차 F-1) — 128건으로 라벨별 8차원을 스윕하면 검증셋 과적합
        out["findings"] = [
            {"category": labels[i], "score": float(p)}
            for i, p in enumerate(probs)
            if p >= req.threshold and i < len(labels)
        ]
    out["latency_ms"] = round((time.perf_counter() - started) * 1000, 2)
    return out


@app.post("/screen_batch")
def screen_batch(req: ScreenBatchRequest):
    """창 묶음 채점. 결과 순서 = 입력 순서. 준비 안 됐으면 소견 없이 사실만 말한다.

    각 창은 **제 길이 그대로 낱개 실행**한다 — /screen 과 완전히 같은 계산이라 판정이
    갈라질 자리가 없다. 상한 256 은 폭주 방어(운영 창 상한 40 + 여유) — localhost 전용
    서비스라 공격면은 아니고, 버그로 폭주한 호출자가 프로세스를 몇 분씩 잡는 것만 막는다.
    """
    _load()
    started = time.perf_counter()
    out = {"results": [], "stub": _session is None, "ready": _ready}
    if _session is not None and _ready and req.texts:
        import numpy as np
        labels = _config.get("labels", [])
        for text in req.texts[:256]:
            ids = _tokenizer(text, truncation=True, max_length=MAX_LEN)["input_ids"]
            logits = _session.run(None, {
                "input_ids": np.array([ids], dtype=np.int64),
                "attention_mask": np.array([[1] * len(ids)], dtype=np.int64),
            })[0][0]
            probs = 1 / (1 + np.exp(-logits))
            out["results"].append({
                "token_count": len(ids),
                "findings": [
                    {"category": labels[i], "score": float(p)}
                    for i, p in enumerate(probs)
                    if p >= req.threshold and i < len(labels)
                ],
            })
    else:
        out["results"] = [{"token_count": 0, "findings": []} for _ in req.texts]
    out["latency_ms"] = round((time.perf_counter() - started) * 1000, 2)
    return out
