"""코퍼스 토큰 길이 분포 — MAX_LEN을 근거 있게 정하기 위한 실측 (7차 검토 E-3).

`MAX_LEN=512`에 padding="max_length"를 쓰면 30토큰 문장도 512로 채워져 연산의
대부분이 패딩에 쓰인다. 배치별 동적 패딩은 배치 구성에 따라 손실이 달라져 재현성
조건이 하나 늘어난다 — 그래서 **고정 상한을 낮추는 쪽**을 택한다. 그 값의 근거가
이 측정이다: P99를 넘겨 자르면 상위 1%만 잘리고, 그 1%는 truncation으로 처리된다.
"""
import json
import sys
from pathlib import Path

from transformers import AutoTokenizer

sys.path.insert(0, str(Path(__file__).resolve().parent))

BASE = Path(__file__).resolve().parent.parent / "local_models" / "student-base"


def main():
    tok = AutoTokenizer.from_pretrained(str(BASE))
    lens = []
    for f in sorted(Path("data").glob("*.jsonl")):
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.strip():
                lens.append(len(tok(json.loads(line)["text"])["input_ids"]))
    lens.sort()
    n = len(lens)

    def pct(q):
        return lens[min(n - 1, int(n * q))]

    print(f"표본 {n}건")
    print(f"  최소 {lens[0]} · 중앙 {pct(0.5)} · P90 {pct(0.90)} · P95 {pct(0.95)} · P99 {pct(0.99)} · 최대 {lens[-1]}")
    for cut in (64, 96, 128, 160, 192, 256):
        over = sum(1 for l in lens if l > cut)
        print(f"  MAX_LEN={cut:4d} → 잘리는 예시 {over:3d}건 ({over / n * 100:.1f}%) · 연산량 512 대비 {cut / 512:.2f}배")


if __name__ == "__main__":
    main()
