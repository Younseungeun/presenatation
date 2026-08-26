"""교사(110M P1-A) 로짓 추출 — 증류 실험의 소프트 라벨 (사전 등록: README "증류 실험").

학습 자료의 각 예시를 교사에 통과시켜 8차원 로짓을 뽑아 저장한다. train.py 의
--teacher-logits 가 이 파일을 읽어 KD 항을 만든다.

  로짓을 저장하는 이유 (확률이 아니라): 온도 T 를 학습 쪽에서 바꿔 볼 수 있어야 한다 —
  sigmoid(z/T) 는 z 가 있어야 계산된다. 확률로 저장하면 T 가 추출 시점에 굳는다.

  .venv-gpu python distill_teacher_labels.py \
    --teacher out/autopsy/P1-A --data data/synth.v2.jsonl data/generated.jsonl \
    data/founder.jsonl rejected/generated.r8-round6.jsonl --out distill/teacher-P1-A.jsonl
"""
import argparse
import json
from pathlib import Path

import torch
from transformers import AutoTokenizer

from contract import MAX_LEN
from train import Student, load_examples


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--teacher", required=True, help="교사 아티팩트 폴더 (model.pt + config.json + tokenizer)")
    ap.add_argument("--data", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--batch", type=int, default=32)
    a = ap.parse_args()

    tdir = Path(a.teacher)
    cfg = json.loads((tdir / "config.json").read_text(encoding="utf-8"))
    labels = cfg["labels"]
    tokenizer = AutoTokenizer.from_pretrained(str(tdir))
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = Student(cfg["base"], len(labels))
    model.load_state_dict(torch.load(tdir / "model.pt", map_location=device))
    model.to(device).eval()
    print(f"교사 {cfg.get('name')} · base {cfg['base']} · device {device}")

    rows = load_examples(a.data)
    out_path = Path(a.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with out_path.open("w", encoding="utf-8") as f, torch.no_grad():
        for at in range(0, len(rows), a.batch):
            chunk = rows[at:at + a.batch]
            encs = [tokenizer(r["text"], truncation=True, max_length=MAX_LEN)["input_ids"] for r in chunk]
            width = max(len(e) for e in encs)
            ids = torch.zeros((len(encs), width), dtype=torch.long)
            mask = torch.zeros((len(encs), width), dtype=torch.long)
            for i, e in enumerate(encs):
                ids[i, : len(e)] = torch.tensor(e)
                mask[i, : len(e)] = 1
            logits = model(ids.to(device), mask.to(device)).cpu()
            for r, z in zip(chunk, logits):
                f.write(json.dumps({"id": r["id"], "logits": [round(float(v), 4) for v in z]},
                                   ensure_ascii=False) + "\n")
                written += 1
            if written % 320 == 0:
                print(f"  {written}/{len(rows)}")
    # 같은 id 가 여러 파일에 있으면 마지막 로짓이 이긴다 — 학습 쪽도 dict 로 읽으므로 일관됨
    print(f"교사 로짓 {written}건 → {out_path} (labels {len(labels)}차원, 교사 sha 는 대장 참조)")


if __name__ == "__main__":
    main()
