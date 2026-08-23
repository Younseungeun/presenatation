"""학습된 학생 모델 → ONNX (사이드카가 읽는 아티팩트).

사용:  python export_onnx.py
출력:  out/student/model.onnx  (fp32, 단일 파일 — 배포되는 것)
       out/student/model.int8.onnx  (양자화 성공 시에만)

**8차에서 이 파일이 조용히 죽은 그래프를 만들고 있었다.** 더미 입력이
`torch.ones(1, MAX_LEN)` 하나였고 그것을 input_ids와 attention_mask **양쪽에 같은
텐서 객체로** 넘겼다. torch 2.13의 dynamo 내보내기는 그 퇴화 입력에 특수화해
계산을 상수로 접어버렸다 — 그래프에 노드 592개가 그대로 있고 입력도 형식상 연결돼
있는데, **서로 다른 토큰 열을 넣어도 출력이 비트 단위로 같았다**(차이 정확히 0.0).

그 결과가 무엇이었는가: 하네스가 "학생은 어떤 임계값에서도 채택 불가"라고 두 회차
동안 보고했고, 나는 그것을 데이터 부족으로 읽어 코퍼스를 2.8배로 늘렸다. **재고 있던
것이 모델이 아니라 죽은 그래프였다.** 학습 로그의 val macro-F1(0.468)과 서빙 쪽
관측(상수 출력)이 양립할 수 없다는 것을 알아채는 데 두 회차가 걸렸다.

그래서 이 파일은 이제 **내보낸 뒤 반드시 두 가지를 확인하고, 실패하면 파일을 쓰지 않는다**:
  ① 입력 반응성 — 다른 입력에 다른 출력을 내는가 (죽은 그래프 검출)
  ② PyTorch 대조 — 같은 입력에 같은 답을 내는가 (계산 동일성)
7차 검토 E-2가 요구한 것이 ②였고, 그때 미뤘다. ①은 그때 아무도 요구하지 않았지만
**실제로 일어난 실패가 이쪽**이라 함께 넣는다.

**단일 파일로 만드는 이유**: torch 2.13의 내보내기는 가중치를 model.onnx.data로
따로 뺀다(202/223 초기화자). 두 파일이 되면 ① 배포·복사에서 하나만 옮기는 사고가
나고 ② onnxruntime 양자화의 형상 추론이 외부 데이터에서 깨진다(실측: InferenceError).

**int8은 필수가 아니다 (3차 F-4 서버 전용 확정의 따름정리).**
원래 양자화를 넣은 이유는 브라우저 예산 100MB였는데 그 예산 자체가 폐기됐다.
그래서 양자화는 실패해도 파이프라인을 세우지 않는다 — 다만 **무엇이 배포되는지는
반드시 분명히 말한다.**
"""
import hashlib
import json
from pathlib import Path

import numpy as np
import onnx
import torch

from contract import CANARY_FILE, CANARY_TEXTS, CANARY_TOL, MAX_LEN
from train import Student

import os
# 부검 런은 런마다 폴더가 다르다 — STUDENT_OUT 로 바꿔 잡는다 (기본 out/student)
OUT = Path(os.environ.get("STUDENT_OUT", "out/student"))

# 검사에 쓰는 토큰 열. **퇴화하지 않아야 한다** — 같은 값이 반복되거나 두 입력이
# 같은 객체면 내보내기가 그 상황에 특수화한다(이 파일이 겪은 실패 그대로).
_RNG = np.random.default_rng(1234)


def _probe(n: int) -> torch.Tensor:
    body = _RNG.integers(100, 20000, size=n - 2)
    return torch.tensor([[2, *body.tolist(), 3]], dtype=torch.long)


def _run_onnx(sess, ids: torch.Tensor) -> np.ndarray:
    return sess.run(None, {
        "input_ids": ids.numpy().astype(np.int64),
        "attention_mask": np.ones_like(ids.numpy(), dtype=np.int64),
    })[0][0]


def _run_torch(model, ids: torch.Tensor) -> np.ndarray:
    with torch.no_grad():
        return model(ids, torch.ones_like(ids))[0].numpy()


def verify(model, path: Path, tol: float) -> None:
    """죽은 그래프와 계산 불일치를 잡는다. 어느 쪽이든 배포하지 않는다.

    `tol`이 갈리는 이유: fp32는 같은 계산을 그대로 옮긴 것이라 오차가 부동소수점
    누적분(1e-6 수준)뿐이어야 한다. int8은 **일부러 정밀도를 버린** 것이라 같은 잣대를
    들이대면 항상 실패한다 — 그쪽에서 지켜야 하는 것은 "값이 같다"가 아니라
    "판정이 뒤집히지 않는다"이므로 문턱을 느슨하게 둔다.
    죽은 그래프 검사(①)는 **양쪽 모두 같은 문턱**이다. 정밀도와 무관한 실패라서다.
    """
    import onnxruntime
    sess = onnxruntime.InferenceSession(str(path), providers=["CPUExecutionProvider"])

    a, b = _probe(32), _probe(48)
    oa, ob = _run_onnx(sess, a), _run_onnx(sess, b)
    response = float(np.max(np.abs(oa - ob)))
    if response == 0.0:
        raise SystemExit(
            "\n✗ **죽은 그래프입니다.** 서로 다른 토큰 열에 대해 출력이 완전히 같습니다.\n"
            "  내보내기가 입력에 특수화해 계산을 상수로 접은 상태입니다.\n"
            "  더미 입력이 퇴화하지 않았는지(같은 값 반복·두 입력에 같은 객체) 보십시오.\n"
        )

    err = max(float(np.max(np.abs(_run_torch(model, x) - _run_onnx(sess, x)))) for x in (a, b))
    if err >= tol:
        raise SystemExit(
            f"\n✗ **PyTorch와 ONNX가 다른 답을 냅니다** (최대 오차 {err:.2e} ≥ {tol:.0e}).\n"
            "  학습 로그의 지표와 서빙 결과가 다른 것을 재게 됩니다. 배포하지 않습니다.\n"
        )

    print(f"  검증 통과 — 입력 반응 {response:.3f} · PyTorch 대조 오차 {err:.2e}")


def bake_canary(model, deployed: Path, cfg: dict) -> None:
    """**배포되는 그 파일**로 카나리아 정답을 굽는다 (9차 G-1).

    정답의 출처가 PyTorch가 아니라 **배포본**인 것이 요점이다. fp32를 배포하면 fp32로,
    int8을 배포하면 int8로 굽는다 — 그래야 사이드카가 기동할 때 "내가 지금 든 파일이
    내보내기가 도장 찍은 그 파일인가"를 물을 수 있다. PyTorch로 구우면 int8 배포에서
    영원히 어긋난다(정밀도를 일부러 버린 것이므로).

    **PyTorch 대조는 이미 verify()가 했다.** 그러니 여기서 재는 것은 다른 질문이다:
    저쪽은 "옮기는 과정이 계산을 바꿨는가", 이쪽은 "서빙 스택 전체가 이것을 재현하는가"다.
    카나리아는 토크나이저까지 함께 태우므로 라벨 순서·어휘·차원 중 하나만 어긋나도 걸린다.
    """
    import onnxruntime
    from transformers import AutoTokenizer

    tok = AutoTokenizer.from_pretrained(str(OUT))
    sess = onnxruntime.InferenceSession(str(deployed), providers=["CPUExecutionProvider"])
    logits = []
    for text in CANARY_TEXTS:
        ids = tok(text, truncation=True, max_length=MAX_LEN)["input_ids"]
        out = sess.run(None, {
            "input_ids": np.array([ids], dtype=np.int64),
            "attention_mask": np.ones((1, len(ids)), dtype=np.int64),
        })[0][0]
        logits.append([round(float(v), 6) for v in out])

    (OUT / CANARY_FILE).write_text(json.dumps({
        # 어느 파일로 구웠는지 — 배포본이 바뀌면 카나리아도 다시 구워야 한다
        "model_file": deployed.name,
        # **이름만으로는 부족하다.** 이름은 늘 model.onnx다 — 카나리아를 만들면서
        # 카나리아 자신이 "이름은 맞는데 내용이 다르다" 계열의 취약점이 됐다.
        # 옛 canary.json 옆에 새 model.onnx 를 손으로 복사하면 이름은 그대로다.
        "model_sha": hashlib.sha256(deployed.read_bytes()).hexdigest()[:16],
        # 라벨 목록을 함께 박는다: 순서가 바뀌면 로짓은 그대로인데 뜻이 달라진다.
        # 그건 값 대조로는 안 잡히는 유일한 어긋남이라 이름을 따로 적어 둔다.
        "labels": cfg["labels"],
        "max_len": MAX_LEN,
        "tol": CANARY_TOL,
        "logits": logits,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  카나리아 {len(CANARY_TEXTS)}건 구움 → {CANARY_FILE} (기준: {deployed.name})")

def main():
    cfg = json.loads((OUT / "config.json").read_text(encoding="utf-8"))
    model = Student(cfg["base"], len(cfg["labels"]))
    model.load_state_dict(torch.load(OUT / "model.pt", map_location="cpu"))
    model.eval()

    raw = OUT / "_raw.onnx"
    # **더미는 서로 다른 텐서, 값도 다양하게.** 여기가 8차 결함의 자리다.
    ids = _probe(64)
    mask = torch.ones_like(ids)
    torch.onnx.export(
        model, (ids, mask), raw,
        input_names=["input_ids", "attention_mask"], output_names=["logits"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "seq"},
            "attention_mask": {0: "batch", 1: "seq"},
            "logits": {0: "batch"},
        },
        opset_version=17,
    )

    # 외부 데이터를 본문으로 접어 단일 파일로 만든다 (위 주석 참고)
    fp32 = OUT / "model.onnx"
    m = onnx.load(str(raw), load_external_data=True)
    onnx.save(m, str(fp32), save_as_external_data=False)
    for stray in (raw, OUT / "_raw.onnx.data"):
        stray.unlink(missing_ok=True)

    print("fp32 검증:")
    verify(model, fp32, tol=1e-4)

    deployed = fp32
    int8 = OUT / "model.int8.onnx"
    int8.unlink(missing_ok=True)  # 옛 양자화본이 남아 사이드카에 먼저 잡히는 사고를 막는다
    try:
        from onnxruntime.quantization import QuantType, quantize_dynamic
        # 낡은 value_info 를 지우지 않으면 형상 추론 충돌로 실패한다 (quantize_candidate.py 주석;
        # 공식 quant_pre_process 도 같은 오류) — r5 가 int8 없이 나간 원인. 임시본은 양자화 뒤 지운다
        stripped = onnx.load(str(fp32))
        del stripped.graph.value_info[:]
        pre = OUT / "_stripped.onnx"
        onnx.save(stripped, str(pre))
        quantize_dynamic(str(pre), str(int8), weight_type=QuantType.QInt8)
        pre.unlink(missing_ok=True)
        print("int8 검증:")
        verify(model, int8, tol=0.5)  # 값이 아니라 판정이 뒤집히지 않는지만 본다
        deployed = int8
    except SystemExit as e:  # 검증 실패 — 양자화본을 버리고 fp32로 간다
        int8.unlink(missing_ok=True)
        print(f"양자화본 폐기 ({str(e).strip().splitlines()[0]})")
    except Exception as e:  # noqa: BLE001 — 어떤 이유든 fp32로 간다
        int8.unlink(missing_ok=True)
        print(f"양자화 건너뜀 ({type(e).__name__}: {e})")

    bake_canary(model, deployed, cfg)
    print("→ 배포:", deployed.name, f"({deployed.stat().st_size / 1e6:.1f}MB)")

    # ── 판본 보관 (2026-08-21 실사고 후 추가) ────────────────────────────
    # r3 재학습이 채택 중이던 모델(aeb1786b)을 덮어써 원본이 소실됐다 — 롤백 수단이
    # 재현 학습뿐이었고, 재현은 비트 단위 동일이 아니다. 내보낼 때마다 sha 이름으로
    # 사본을 남긴다. 롤백 = 보관본 셋을 out/student/ 로 복사 + 사이드카 재기동.
    import shutil
    sha = hashlib.sha256(deployed.read_bytes()).hexdigest()[:16]
    arch = deployed.parent.parent / "archive" / sha
    arch.mkdir(parents=True, exist_ok=True)
    # 토크나이저 파일도 함께 — 보관본만으로 승격이 가능해야 한다 (회신 10호 §1)
    for name in (deployed.name, "config.json", CANARY_FILE, "tokenizer.json", "tokenizer_config.json", "vocab.txt", "special_tokens_map.json"):
        src = deployed.parent / name
        if src.exists():
            shutil.copy2(src, arch / name)
    print(f"→ 보관: {arch}")


if __name__ == "__main__":
    main()
