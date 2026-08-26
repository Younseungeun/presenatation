"""보관본(fp32)의 그래프를 융합(onnxruntime transformers optimizer)해 **별도 후보**로 만든다.

32차 II-4 (a) — 지연 최적화. 양자화(int8)와 달리 **가중치는 그대로**이고 커널만 융합된다
(Attention·LayerNorm·GELU 단일 연산화). 실측(P1-A, i7-9700F): 512tk 699→433ms(−38%),
로짓 최대 차 1e-6 — 수치적으로 같은 모델이다. 그래도 **파일이 다르면 다른 모델로 취급한다**
(int8 과 같은 규칙): out/candidates/<sha>-fused/ 에 따로 놓고 카나리아를 융합 파일로 굽고,
게이트는 후보 사이드카로 처음부터 재통과해야 승격 자격이 생긴다.

로짓 차가 PARITY_TOL(1e-4) 을 넘으면 **자동 폐기** — 융합은 무손실이어야 하고, 손실이
보이면 그것은 최적화가 아니라 다른 검수기다 (int8 3연속 폐기와 같은 원칙).

  .venv python fuse_candidate.py --src out/autopsy/P1-A --out out/candidates/<sha>-fused
"""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

import numpy as np

from contract import CANARY_FILE, CANARY_TEXTS, CANARY_TOL, MAX_LEN

PARITY_TOL = 1e-4  # @근거 실측 — 융합은 커널 재배열뿐이라 1e-6 대역. 1e-4 초과 = 무언가 깨졌다


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
    from onnxruntime.transformers import optimizer
    from transformers import AutoTokenizer

    fp32 = src / "model.onnx"
    fused_path = out / "model.onnx"  # 사이드카 기본 파일명 — 후보 폴더 안에서는 이것이 유일한 모델
    m = optimizer.optimize_model(
        str(fp32), model_type="bert", num_heads=12, hidden_size=768, opt_level=1, use_gpu=False,
    )
    m.save_model_to_file(str(fused_path))
    for name in ("config.json", "tokenizer.json", "tokenizer_config.json", "vocab.txt", "special_tokens_map.json"):
        if (src / name).exists():
            shutil.copy2(src / name, out / name)
    cfg = json.loads((out / "config.json").read_text(encoding="utf-8"))
    cfg["name"] = f"{cfg.get('name', 'unnamed')}-fused"  # run(회차 기록)은 그대로 둔다
    (out / "config.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

    tok = AutoTokenizer.from_pretrained(str(out))
    s32 = onnxruntime.InferenceSession(str(fp32), providers=["CPUExecutionProvider"])
    sf = onnxruntime.InferenceSession(str(fused_path), providers=["CPUExecutionProvider"])
    # 동등성: 카나리아 3문장 + 무작위 길이·배치 (융합 그래프는 배치 축도 지나므로 배치도 잰다)
    logits, worst = [], 0.0
    for text in CANARY_TEXTS:
        lf = run_logits(sf, tok, text)
        l32 = run_logits(s32, tok, text)
        worst = max(worst, float(np.max(np.abs(lf - l32))))
        logits.append([round(float(v), 6) for v in lf])
    rng = np.random.default_rng(7)
    for B, L in ((1, 24), (1, 256), (1, 512), (8, 128)):
        ids = rng.integers(1000, 20000, (B, L)).astype(np.int64)
        mask = np.ones((B, L), dtype=np.int64)
        feed = {"input_ids": ids, "attention_mask": mask}
        worst = max(worst, float(np.max(np.abs(s32.run(None, feed)[0] - sf.run(None, feed)[0]))))
    if worst > PARITY_TOL:
        fused_path.unlink(missing_ok=True)
        raise SystemExit(f"자동 폐기 — 융합 로짓 차 {worst:.2e} > {PARITY_TOL:.0e} (무손실 아님)")

    sha = hashlib.sha256(fused_path.read_bytes()).hexdigest()[:16]
    (out / CANARY_FILE).write_text(json.dumps({
        "model_file": fused_path.name, "model_sha": sha, "labels": cfg["labels"],
        "max_len": MAX_LEN, "tol": CANARY_TOL, "logits": logits,
        "fused_from": hashlib.sha256(fp32.read_bytes()).hexdigest()[:16],
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"fused {sha} ← fp32 {hashlib.sha256(fp32.read_bytes()).hexdigest()[:16]}")
    print(f"크기 {fp32.stat().st_size/1e6:.1f}MB → {fused_path.stat().st_size/1e6:.1f}MB · 로짓 최대 차 {worst:.2e} ≤ {PARITY_TOL:.0e}")


if __name__ == "__main__":
    main()
