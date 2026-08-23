"""PyTorch(.pt) 와 ONNX(.onnx) 가 같은 답을 내는지 대조한다 (7차 검토 E-2).

    python check_parity.py

**왜 필요한가.** 학습은 PyTorch로 하고 서빙은 ONNX로 한다. 둘이 갈라지면 예외가
나지 않는다 — 학습 로그의 val F1은 멀쩡한데 서빙에서만 틀린 답이 나온다. 그런 실패는
"모델이 덜 배웠다"로 오진되고, 그러면 데이터를 더 넣는 헛수고를 몇 회차 반복하게 된다.

토크나이저 지문 대조가 "학습과 서빙이 같은 글자를 보는가"를 지키는 것과 짝이다.
이쪽은 "학습과 서빙이 같은 계산을 하는가"를 지킨다.

판정선: 최대 절대 오차 < 1e-4 (fp32 누적 오차의 여유). 넘으면 배포 금지.
"""
import json
from pathlib import Path

import numpy as np
import torch
from transformers import AutoTokenizer

from contract import MAX_LEN
from train import Student

import os
OUT = Path(os.environ.get("STUDENT_OUT", "out/student"))

PROBES = [
    "[카드] 방향 상승\n[제목] \n[요약] \n[본문] 영업이익률은 8.4%로 전분기와 유사한 수준입니다.",
    "[카드] 방향 상승\n[제목] \n[요약] \n[본문] 원금은 제가 보장해 드리겠습니다.",
    "[카드] 방향 상승\n[제목] \n[요약] \n[본문] 더 궁금하신 분은 프로필의 오픈채팅 링크로 들어오세요.",
    "[카드] 방향 하락\n[제목] \n[요약] \n[본문] 대출을 내서라도 지금 담아야 하는 자리입니다.",
    "[카드] 방향 상승\n[제목] \n[요약] \n[본문] 확인되지 않은 소문은 근거로 쓰지 않았습니다.",
]


def main():
    cfg = json.loads((OUT / "config.json").read_text(encoding="utf-8"))
    tok = AutoTokenizer.from_pretrained(str(OUT))

    model = Student(cfg["base"], len(cfg["labels"]))
    model.load_state_dict(torch.load(OUT / "model.pt", map_location="cpu"))
    model.eval()

    import onnxruntime
    sess = onnxruntime.InferenceSession(str(OUT / "model.onnx"), providers=["CPUExecutionProvider"])

    worst = 0.0
    print(f"{'입력':<22}{'최대 오차':>12}   PyTorch 로짓 앞 3개 / ONNX 로짓 앞 3개")
    for text in PROBES:
        enc = tok(text, truncation=True, max_length=MAX_LEN)
        ids = enc["input_ids"]
        with torch.no_grad():
            pt = model(
                torch.tensor([ids], dtype=torch.long),
                torch.tensor([[1] * len(ids)], dtype=torch.long),
            )[0].numpy()
        ox = sess.run(None, {
            "input_ids": np.array([ids], dtype=np.int64),
            "attention_mask": np.array([[1] * len(ids)], dtype=np.int64),
        })[0][0]
        err = float(np.max(np.abs(pt - ox)))
        worst = max(worst, err)
        body = text.split("[본문] ")[-1][:18]
        print(f"{body:<22}{err:>12.2e}   {np.round(pt[:3], 3)} / {np.round(ox[:3], 3)}")

    # 입력이 달라질 때 **출력이 실제로 달라지는가** — 상수 예측기는 여기서 걸린다.
    # 오차가 0이어도 둘 다 상수면 파이프라인은 멀쩡하고 모델이 죽은 것이므로,
    # 두 질문을 한 화면에서 답하게 한다.
    with torch.no_grad():
        spread_pt = []
        for text in PROBES:
            ids = tok(text, truncation=True, max_length=MAX_LEN)["input_ids"]
            spread_pt.append(model(
                torch.tensor([ids], dtype=torch.long),
                torch.tensor([[1] * len(ids)], dtype=torch.long),
            )[0].numpy())
    arr = np.stack(spread_pt)
    print(f"\nPyTorch 쪽 입력별 로짓 변동폭(라벨별 max-min): {np.round(arr.max(0) - arr.min(0), 3)}")

    print(f"\n최대 절대 오차 {worst:.2e}  →  {'통과' if worst < 1e-4 else '**불일치 — 배포 금지**'}")


if __name__ == "__main__":
    main()
