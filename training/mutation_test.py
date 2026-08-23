"""카나리아 자체를 시험한다 — **가중치를 몰래 바꿔치기할 수 있는가** (10차 검토 I-4).

    py training/mutation_test.py [--trials 12]

검토가 준 닫힘 확인 질문은 이것이다:

    "이 방어 장치의 **식별자(이름)를 유지한 채**, 검사 대상의 **논리만 바꿔치기**할 수 있는가?"

방어가 외부의 이름(파일 이름, 포트 번호)에 기대면 항상 열린 상태라 무한 검사가 필요하고,
대상의 본질적 속성(가중치의 해시, 정답 로짓)에 결합되면 그 안에서 닫힌다. 이 스크립트는
**이름을 그대로 둔 채 내용만 훼손한 돌연변이**를 만들어, 방어가 기동을 거부하는지 잰다.

재는 값 — **돌연변이 생존율(기대값 0%)**. 다만 한 숫자로 뭉뚱그리지 않는다:

  ⓐ 신원 검사 (canary.json 의 model_sha 대조)
  ⓑ 값 검사   (구워 둔 로짓과의 대조)

둘을 **따로** 재는 이유는, 합쳐서 0%가 나오면 "둘 중 하나가 다 하고 있는데 어느
쪽인지 모르는" 상태가 되기 때문이다. 한쪽을 언젠가 걷어내는 날 그 사실이 필요하다.

원본은 건드리지 않는다 — 돌연변이는 임시 폴더에서만 산다.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from contract import CANARY_FILE, CANARY_TEXTS, MAX_LEN  # noqa: E402

ARTIFACT = Path(__file__).resolve().parent / "out" / "student"


def sha(path: Path) -> str:
    """사이드카가 쓰는 것과 **같은 계산** — 여기서만 다르게 재면 시험이 거짓말을 한다."""
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def flip(data: bytearray, offset: int, bit: int) -> None:
    data[offset] ^= 1 << bit


def mutate(src: Path, dst: Path, rng: random.Random, gross: bool) -> tuple[int, int]:
    """가중치 영역의 한 비트를 뒤집는다. 파일 **이름은 그대로** 둔다.

    - `gross=False`: 바이트의 **낮은 비트** — float32 가수의 끝자리다. 값이 거의 안 변한다.
    - `gross=True`:  바이트의 **높은 비트** — 그 바이트가 float의 상위 바이트면 부호·지수가
      바뀌어 값이 통째로 달라진다(정렬을 보장하지 않으므로 항상은 아니다).

    protobuf 머리말과 꼬리(그래프 구조·이름)를 피해 가운데를 겨냥한다. 구조를 깨면
    "적재 실패"로 잡히는데, 그건 **다른 방어가 잡은 것**이라 이 시험의 답이 아니다.
    """
    data = bytearray(src.read_bytes())
    lo, hi = int(len(data) * 0.20), int(len(data) * 0.95)
    offset = rng.randrange(lo, hi)
    bit = rng.choice([6, 7]) if gross else rng.choice([0, 1])
    flip(data, offset, bit)
    dst.write_bytes(bytes(data))
    return offset, bit


def identity_catches(mutant: Path, baked_sha: str) -> bool:
    """ⓐ 신원 검사 — 이름이 아니라 내용으로 대조한다."""
    return sha(mutant) != baked_sha


def value_catches(mutant: Path, spec: dict, tokenizer) -> tuple[bool, float]:
    """ⓑ 값 검사 — 구워 둔 로짓을 지금 이 가중치로 재현할 수 있는가."""
    import numpy as np
    import onnxruntime as ort

    session = ort.InferenceSession(str(mutant), providers=["CPUExecutionProvider"])
    tol = float(spec.get("tol", 1e-3))
    worst = 0.0
    for text, expected in zip(CANARY_TEXTS, spec["logits"]):
        ids = tokenizer(text, truncation=True, max_length=MAX_LEN)["input_ids"]
        got = session.run(
            None,
            {
                "input_ids": np.array([ids], dtype=np.int64),
                "attention_mask": np.ones((1, len(ids)), dtype=np.int64),
            },
        )[0][0]
        worst = max(worst, float(np.max(np.abs(np.asarray(got) - np.asarray(expected)))))
    return worst > tol, worst


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=12, help="변이 종류마다 시도할 횟수")
    ap.add_argument("--seed", type=int, default=1004)
    args = ap.parse_args()

    model = ARTIFACT / "model.onnx"
    canary = ARTIFACT / CANARY_FILE
    if not model.exists() or not canary.exists():
        raise SystemExit(f"배포 아티팩트가 없습니다: {ARTIFACT}")
    spec = json.loads(canary.read_text(encoding="utf-8"))
    baked = spec.get("model_sha")
    if not baked:
        raise SystemExit("canary.json 에 model_sha 가 없습니다 — 이 시험이 성립하지 않습니다")

    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(str(ARTIFACT))

    print(f"\n대상 {model.name}  가중치 {sha(model)}  카나리아가 구운 것 {baked}")
    print(f"시도 {args.trials}회 × 2종(미세/거친) — 파일 이름은 늘 model.onnx 그대로\n")

    rng = random.Random(args.seed)
    results: dict[str, dict[str, int]] = {}
    tmp = Path(tempfile.mkdtemp(prefix="mutation-"))
    try:
        for label, gross in (("미세 (가수 끝자리)", False), ("거친 (지수부)", True)):
            survived_a = survived_b = survived_both = broken = 0
            worst_seen = 0.0
            for _ in range(args.trials):
                mutant = tmp / "model.onnx"  # **이름을 유지한다** — 그것이 이 시험의 요지다
                offset, bit = mutate(model, mutant, rng, gross)
                a = identity_catches(mutant, baked)
                try:
                    b, worst = value_catches(mutant, spec, tokenizer)
                except Exception:
                    # 적재 자체가 실패한 것은 이 시험의 답이 아니다 — 다른 방어가 잡은 것이다
                    broken += 1
                    continue
                worst_seen = max(worst_seen, worst)
                if not a:
                    survived_a += 1
                if not b:
                    survived_b += 1
                if not a and not b:
                    survived_both += 1
            n = args.trials - broken
            results[label] = {"n": n, "a": survived_a, "b": survived_b, "both": survived_both}
            pct = lambda v: f"{(v / n * 100 if n else 0):.1f}%"
            print(f"[{label}]  유효 시도 {n}회" + (f" (구조 파손 {broken}회 제외)" if broken else ""))
            print(f"  ⓐ 신원 검사만 있었다면 생존   {survived_a}/{n}  {pct(survived_a)}")
            print(f"  ⓑ 값 검사만 있었다면 생존     {survived_b}/{n}  {pct(survived_b)}   (최대 로짓 오차 {worst_seen:.3g})")
            print(f"  ⓐ+ⓑ 지금 구현에서 생존       {survived_both}/{n}  {pct(survived_both)}\n")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    total_n = sum(r["n"] for r in results.values())
    total_survived = sum(r["both"] for r in results.values())
    print(f"▶ 돌연변이 생존율 {total_survived}/{total_n} = {total_survived / total_n * 100:.1f}%  (기대 0%)")
    if total_survived:
        raise SystemExit("✗ 이름을 유지한 채 내용을 바꿔치기할 수 있습니다 — 고리가 안 닫혔습니다")
    print("✓ 이름을 유지한 채로는 바꿔치기가 불가능합니다.\n")


if __name__ == "__main__":
    main()
