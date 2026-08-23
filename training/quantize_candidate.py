"""보관본(fp32)을 int8 로 양자화해 **별도 후보**로 만든다 (31차 HH-4 · 먼저 재야 할 것).

fp32 와 int8 은 다른 모델이다 — 양자화는 가중치를 영구히 바꾼다. 그래서 out/student 를
덮어쓰지 않고 out/candidates/<sha>-int8/ 에 따로 놓고, 카나리아는 **int8 파일로** 굽는다
(사이드카가 기동 때 "내가 든 파일이 도장 찍힌 그 파일인가"를 물을 수 있게).
게이트 6종은 후보 사이드카(STUDENT_ARTIFACT_DIR)로 처음부터 다시 통과해야 승격 자격이 생긴다.

  .venv python quantize_candidate.py --src out/archive/<sha> --out out/candidates/<sha>-int8
"""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

import numpy as np

from contract import CANARY_FILE, CANARY_TEXTS, CANARY_TOL, MAX_LEN


def run_logits(sess, tok, text):
    ids = tok(text, truncation=True, max_length=MAX_LEN)["input_ids"]
    return sess.run(None, {
        "input_ids": np.array([ids], dtype=np.int64),
        "attention_mask": np.ones((1, len(ids)), dtype=np.int64),
    })[0][0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    src, out = Path(a.src), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    import onnxruntime
    from onnxruntime.quantization import QuantType, quantize_dynamic
    from transformers import AutoTokenizer

    fp32 = src / "model.onnx"
    int8 = out / "model.int8.onnx"
    int8.unlink(missing_ok=True)
    # **그대로는 실패한다** (2026-08-22 실측, r5 fp32): onnxruntime 의 양자화 전 형상 추론이
    # 내보내기가 남긴 낡은 value_info(814건)와 충돌한다("Inferred shape and existing shape differ
    # 256 vs 8"). 공식 전처리(quant_pre_process)로도 같은 오류다. r5 에 int8 이 없었던 이유가
    # 이것이다 — export_onnx 가 예외를 삼키고 fp32 로 갔다. 낡은 value_info 를 지우면 형상 추론이
    # 처음부터 다시 계산해 통과한다 (실측: 14.3MB int8 생성).
    import onnx
    m = onnx.load(str(fp32))
    del m.graph.value_info[:]
    pre = out / "_stripped.onnx"
    onnx.save(m, str(pre))
    quantize_dynamic(str(pre), str(int8), weight_type=QuantType.QInt8)
    pre.unlink(missing_ok=True)
    for name in ("config.json", "tokenizer.json", "tokenizer_config.json", "vocab.txt", "special_tokens_map.json"):
        if (src / name).exists():
            shutil.copy2(src / name, out / name)
    # fp32 파일은 후보 폴더에 두지 않는다 — 사이드카는 int8 을 우선 적재하지만, 둘이 같이 있으면
    # "무엇이 배포됐나"가 파일 하나 지우는 것으로 뒤집힌다
    cfg = json.loads((out / "config.json").read_text(encoding="utf-8"))
    # int8 은 다른 모델이라 이름도 다르다 — 파일 옆의 이름이 지문과 함께 간다 (회신 13호)
    cfg["name"] = f"{cfg.get('name', 'unnamed')}-int8"  # run(회차 기록)은 그대로 둔다
    (out / "config.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    tok = AutoTokenizer.from_pretrained(str(out))
    s32 = onnxruntime.InferenceSession(str(fp32), providers=["CPUExecutionProvider"])
    s8 = onnxruntime.InferenceSession(str(int8), providers=["CPUExecutionProvider"])
    logits, worst = [], 0.0
    for text in CANARY_TEXTS:
        l8 = run_logits(s8, tok, text)
        l32 = run_logits(s32, tok, text)
        worst = max(worst, float(np.max(np.abs(l8 - l32))))
        logits.append([round(float(v), 6) for v in l8])
    sha = hashlib.sha256(int8.read_bytes()).hexdigest()[:16]
    (out / CANARY_FILE).write_text(json.dumps({
        "model_file": int8.name, "model_sha": sha, "labels": cfg["labels"],
        "max_len": MAX_LEN, "tol": CANARY_TOL, "logits": logits,
        "quantized_from": hashlib.sha256(fp32.read_bytes()).hexdigest()[:16],
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"int8 {sha} ← fp32 {hashlib.sha256(fp32.read_bytes()).hexdigest()[:16]}")
    print(f"크기 {fp32.stat().st_size/1e6:.1f}MB → {int8.stat().st_size/1e6:.1f}MB · 카나리아 3건 int8 로 구움 (tol {CANARY_TOL:.0e})")
    print(f"fp32↔int8 카나리아 로짓 최대 차이 {worst:.3f}  (참고용 — 같은 파일로 구웠으므로 사이드카 대조는 이 값과 무관)")


if __name__ == "__main__":
    main()
