"""정적 양자화(static int8) 후보 — 35차 LL-2 사전 등록 실험.

동적 양자화(4연속 자동 폐기, 오차 1.12~3.80)와 다른 기법이다: 보정 자료(P1 표본)를
미리 통과시켜 각 층의 활성값 범위를 굽는다(QDQ). 110M 처럼 층이 깊은 모델은 동적이
깨져도 정적이 사는 경우가 있다 — 그것을 재는 실험이고, 폐기 기준은 int8 규칙 그대로:
검증 오차 ≥ 0.5 면 자동 폐기. 통과 시 별도 후보(카나리아 재굽기)로 만들어 게이트
전수를 재통과해야 승격 자격이 생긴다.

  .venv python quantize_static_candidate.py --src out/autopsy/P1-A \
    --calib data/synth.v2.jsonl data/generated.jsonl data/founder.jsonl rejected/generated.r8-round6.jsonl \
    --out out/candidates/<sha>-sint8
"""
import argparse
import hashlib
import json
import random
import shutil
from pathlib import Path

import numpy as np

from contract import CANARY_FILE, CANARY_TEXTS, CANARY_TOL, MAX_LEN
from train import load_examples

DISCARD_TOL = 0.5  # @근거 규칙 — export_onnx int8 자동 폐기 기준과 동일 (31차 HH-4)
CALIB_N = 150      # @근거 설계 — 활성값 범위 추정용 표본. 층별 min/max 라 수백이면 수렴


def run_logits(sess, tok, text):
    ids = tok(text, truncation=True, max_length=MAX_LEN)["input_ids"]
    return sess.run(None, {
        "input_ids": np.array([ids], dtype=np.int64),
        "attention_mask": np.ones((1, len(ids)), dtype=np.int64),
    })[0][0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--calib", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    src, out = Path(a.src), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    import onnx
    import onnxruntime
    from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_static
    from transformers import AutoTokenizer

    tok = AutoTokenizer.from_pretrained(str(src))
    rows = load_examples(a.calib)
    random.seed(42)
    random.shuffle(rows)
    texts = [r["text"] for r in rows[:CALIB_N]]

    class Reader(CalibrationDataReader):
        def __init__(self):
            self.it = iter(texts)

        def get_next(self):
            t = next(self.it, None)
            if t is None:
                return None
            ids = tok(t, truncation=True, max_length=MAX_LEN)["input_ids"]
            return {
                "input_ids": np.array([ids], dtype=np.int64),
                "attention_mask": np.ones((1, len(ids)), dtype=np.int64),
            }

    fp32 = src / "model.onnx"
    sint8 = out / "model.int8.onnx"
    sint8.unlink(missing_ok=True)
    # 동적 양자화와 같은 함정: 내보내기가 남긴 낡은 value_info 가 형상 추론과 충돌한다
    m = onnx.load(str(fp32))
    del m.graph.value_info[:]
    pre = out / "_stripped.onnx"
    onnx.save(m, str(pre))
    print(f"보정 {len(texts)}건으로 정적 양자화 시작 (수 분 소요)…")
    quantize_static(str(pre), str(sint8), Reader(),
                    quant_format=QuantFormat.QDQ,
                    activation_type=QuantType.QInt8, weight_type=QuantType.QInt8,
                    per_channel=True)
    pre.unlink(missing_ok=True)

    for name in ("config.json", "tokenizer.json", "tokenizer_config.json", "vocab.txt", "special_tokens_map.json"):
        if (src / name).exists():
            shutil.copy2(src / name, out / name)
    cfg = json.loads((out / "config.json").read_text(encoding="utf-8"))
    cfg["name"] = f"{cfg.get('name', 'unnamed')}-sint8"
    (out / "config.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

    s32 = onnxruntime.InferenceSession(str(fp32), providers=["CPUExecutionProvider"])
    s8 = onnxruntime.InferenceSession(str(sint8), providers=["CPUExecutionProvider"])
    logits, worst = [], 0.0
    for text in CANARY_TEXTS:
        l8 = run_logits(s8, tok, text)
        l32 = run_logits(s32, tok, text)
        worst = max(worst, float(np.max(np.abs(l8 - l32))))
        logits.append([round(float(v), 6) for v in l8])
    # 검증 표본도 대조 — 카나리아 3문장만으로는 운 좋은 통과가 가능하다
    for t in texts[:20]:
        worst = max(worst, float(np.max(np.abs(run_logits(s8, tok, t) - run_logits(s32, tok, t)))))
    if worst >= DISCARD_TOL:
        sint8.unlink(missing_ok=True)
        raise SystemExit(f"자동 폐기 — 정적 양자화 검증 오차 {worst:.3f} ≥ {DISCARD_TOL} (동적과 같은 결말)")

    sha = hashlib.sha256(sint8.read_bytes()).hexdigest()[:16]
    (out / CANARY_FILE).write_text(json.dumps({
        "model_file": sint8.name, "model_sha": sha, "labels": cfg["labels"],
        "max_len": MAX_LEN, "tol": CANARY_TOL, "logits": logits,
        "quantized_from": hashlib.sha256(fp32.read_bytes()).hexdigest()[:16],
        "method": "static-qdq-perchannel",
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"sint8 {sha} ← fp32 {hashlib.sha256(fp32.read_bytes()).hexdigest()[:16]}")
    print(f"크기 {fp32.stat().st_size/1e6:.1f}MB → {sint8.stat().st_size/1e6:.1f}MB · 검증 오차 {worst:.4f} < {DISCARD_TOL}")


if __name__ == "__main__":
    main()
