"""검수 학생 모델 파인튜닝 (증류).

입력:  data/*.jsonl  — TrainingExample (src/domain/studentText.ts 가 형식의 원본)
       data/labels.json — 출력 벡터의 라벨 순서 (train:export 가 생성)
출력:  out/student/  — 가중치·토크나이저·config.json

사용:  python train.py --data data/synth.v2.jsonl data/generated.jsonl data/founder.jsonl
주의:  train.v1(손코퍼스 유래)은 채점지라 절대 넣지 않는다 — train:export 는 잠겼다

설계 근거:
- 다중 라벨 시그모이드 8차원 (7유형 + CARD_MISMATCH). 헤드를 나누지 않는 이유는
  studentText.ts 주석 참고 — pos_weight 로 불균형을 다루면 구조가 같아진다.
- 기본 모델 koelectra-small-v3: 14M 파라미터, int8 양자화 후 약 14MB.
  브라우저 예산(100MB 이하, docs/model-plan.md)에 여유 있게 들어간다.
  정확도가 채택선에 못 미치면 klue/roberta-small(68M, int8 약 68MB)로 올려 재측정.
- CARD_MISMATCH 라벨은 문서 예시(42건)에만 있어 문장 예시에 묻히기 쉽다 —
  pos_weight 가 라벨별 빈도 역수로 계산되므로 자동으로 크게 잡힌다. 그래도 부족하면
  --doc-weight 로 문서 예시의 손실 자체를 증폭한다.
"""
import argparse
import json
import random
from pathlib import Path

import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset
from transformers import AutoModel, AutoTokenizer

# 학습·서빙 공유 계약 — 두 곳에 베껴 적으면 조용히 갈라진다 (contract.py 주석 참고)
from contract import MAX_LEN, tokenizer_fingerprint

# 기본 경로는 **로컬 디렉터리**다 (6차 F-3 확정).
# huggingface.co가 차단된 환경이라 허브 이름을 기본값으로 두면 첫 줄부터 실패한다.
# 무엇보다 Colab 같은 외부 노트북으로 도망가면 이 스레드가 지켜온 단일 진실 공급원이
# 깨진다 — "무엇으로 학습한 모델인가"에 답할 수 없게 된다. 파일을 반입해 로컬에서 돈다.
# 반입할 파일 목록은 local_models/README.md.
DEFAULT_MODEL = "../local_models/student-base"
SEED = 42


def load_examples(paths):
    rows = []
    for p in paths:
        for line in Path(p).read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))
    return rows


class JsonlDataset(Dataset):
    def __init__(self, rows, labels, tokenizer):
        self.rows = rows
        self.index = {l: i for i, l in enumerate(labels)}
        self.tokenizer = tokenizer

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        row = self.rows[i]
        # **여기서 패딩하지 않는다** (7차 E-3). 배치별로 가장 긴 예시에 맞춰 collate에서
        # 채운다 — 코퍼스 중앙값이 31토큰인데 상한(768)까지 채우면 연산의 96%가 패딩이다.
        # 재현성은 유지된다: 시드가 고정돼 셔플 순서가 매번 같으므로 배치 구성도 같다.
        enc = self.tokenizer(row["text"], truncation=True, max_length=MAX_LEN)
        y = torch.zeros(len(self.index))
        for l in row["labels"]:
            y[self.index[l]] = 1.0
        # 손실 마스크 (--mask-unlabeled 일 때만 쓰인다). 코퍼스는 위반 유형을 하나만
        # 적는데 모델은 8차원이라, 명시되지 않은 7개를 음성으로 가르치면 실제로 두 유형이
        # 겹치는 문장에서 거짓을 가르치게 된다. 마스크는 위반 예시의 미명시 차원을
        # 손실에서 빼고, 정상 예시(labels=[])는 전 차원을 그대로 음성으로 남긴다 —
        # 정상 문장이 유일하게 온전한 음성 신호원이므로 여기는 절대 마스킹하지 않는다.
        mask = y.clone() if row["labels"] else torch.ones(len(self.index))
        is_doc = 1.0 if row["id"].startswith("doc:") else 0.0
        return {
            "input_ids": enc["input_ids"],      # 아직 텐서가 아니다 — collate가 맞춘다
            "attention_mask": enc["attention_mask"],
            "labels": y,
            "loss_mask": mask,
            "is_doc": torch.tensor(is_doc),
        }


def collate(batch):
    """배치 안에서 가장 긴 예시에 맞춰 패딩한다 (동적 패딩).

    패딩 자리는 attention_mask가 0이라 계산에서 빠지므로 결과가 달라지지 않는다 —
    바뀌는 것은 **얼마나 많은 자리를 헛계산하느냐**뿐이다.
    """
    longest = max(len(b["input_ids"]) for b in batch)
    ids, masks = [], []
    for b in batch:
        pad = longest - len(b["input_ids"])
        ids.append(b["input_ids"] + [0] * pad)
        masks.append(b["attention_mask"] + [0] * pad)
    return {
        "input_ids": torch.tensor(ids, dtype=torch.long),
        "attention_mask": torch.tensor(masks, dtype=torch.long),
        "labels": torch.stack([b["labels"] for b in batch]),
        "loss_mask": torch.stack([b["loss_mask"] for b in batch]),
        "is_doc": torch.stack([b["is_doc"] for b in batch]),
    }


class Student(nn.Module):
    def __init__(self, base, num_labels):
        super().__init__()
        self.encoder = AutoModel.from_pretrained(base)
        hidden = self.encoder.config.hidden_size
        self.head = nn.Linear(hidden, num_labels)

    def forward(self, input_ids, attention_mask):
        out = self.encoder(input_ids=input_ids, attention_mask=attention_mask)
        cls = out.last_hidden_state[:, 0]  # [CLS]
        return self.head(cls)


def average_precision(scores, targets):
    """한 라벨의 평균 정밀도 (PR 곡선 아래 넓이).

    **임계값을 고르지 않고 재는 값이다** (8차 E-3). macro-F1 은 0.5에서 잰 한 점이라,
    저울(pos_weight)을 바꾸면 출력 분포가 통째로 밀려 성적이 오르내린다 — 분류력이
    변한 것인지 눈금이 옮겨간 것인지 구별할 수 없다. 평균 정밀도는 **순위**만 보므로
    단조 변환에 흔들리지 않고, 그래서 임계값을 나중에 스윕하는 이 파이프라인에
    맞는 잣대다.

    sklearn 을 들이지 않는다 — 이 한 함수 때문에 의존성을 늘릴 이유가 없고,
    오프라인 반입 환경(6차 F-3)에서 패키지 하나가 늘면 반입 목록도 늘어난다.
    """
    order = sorted(range(len(scores)), key=lambda i: -scores[i])
    total_pos = sum(1 for t in targets if t > 0.5)
    if total_pos == 0:
        return None  # 이 분할에 양성이 없으면 잴 수 없다 — 0으로 벌주지 않는다
    tp = 0
    ap = 0.0
    for rank, i in enumerate(order, start=1):
        if targets[i] > 0.5:
            tp += 1
            ap += tp / rank  # 이 지점의 정밀도 × 재현율 증가분(1/total_pos)
    return ap / total_pos


def macro_ap(logits, targets):
    """라벨별 평균 정밀도의 거시 평균. 체크포인트 선택은 이 값으로 한다."""
    vals = []
    for c in range(targets.shape[1]):
        v = average_precision(logits[:, c].tolist(), targets[:, c].tolist())
        if v is not None:
            vals.append(v)
    return sum(vals) / len(vals) if vals else 0.0


def net_value(logits, targets, cost_ratio, thresholds=(0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8)):
    """검증셋 **순이익** — 채택선과 같은 공식으로 잰다 (9차 검토 G-3).

        순이익 = 잡은 위반 건수 − λ × 잘못 잡은 건수

    **왜 AP를 버리는가.** macro-AP는 라벨마다 따로 순위를 매겨 면적을 낸 뒤 평균한다.
    그런데 배포는 8차원에 **단일 임계값**을 긋는다 — 라벨 간 로짓의 영점이 서로 맞는지를
    AP는 전혀 보지 않는다. 실제로 9차에 AP는 λ=1이 높은데 하네스는 λ=4가 나아,
    두 지표가 반대 방향을 가리켰다.

    **왜 임계값을 고정하지 않는가.** 검토안은 t=0.5 고정을 제안했으나, 저울(pos_weight)을
    바꾸면 출력 분포가 통째로 밀린다는 것이 바로 8차 E-3의 교훈이다 — λ=4 학습에서
    macro-F1@0.5가 여섯 에포크 동안 정확히 0.000이었는데 AP는 이미 0.55였다.
    고정 임계값으로 고르면 "눈금이 옮겨간 것"을 "못 배운 것"으로 오독하는 같은 함정에
    다시 빠진다. 배포도 임계값을 스윕해 정하므로, **스윕한 뒤의 최선**을 재는 것이
    배포 절차와 같은 질문이다.

    라벨을 합쳐 센다 — 채택선이 건수로 세고, 운영자 큐에 오는 것도 소견 건수다.
    """
    probs = torch.sigmoid(logits)
    best = (float("-inf"), 0.5)
    for t in thresholds:
        pred = (probs >= t)
        tp = int((pred & (targets > 0.5)).sum().item())
        fp = int((pred & (targets <= 0.5)).sum().item())
        v = tp - cost_ratio * fp
        if v > best[0]:
            best = (v, t)
    return best


def macro_f1(logits, targets, thresh=0.5):
    preds = (torch.sigmoid(logits) >= thresh).float()
    f1s = []
    for c in range(targets.shape[1]):
        tp = ((preds[:, c] == 1) & (targets[:, c] == 1)).sum().item()
        fp = ((preds[:, c] == 1) & (targets[:, c] == 0)).sum().item()
        fn = ((preds[:, c] == 0) & (targets[:, c] == 1)).sum().item()
        if tp + fp + fn == 0:
            continue  # 검증 분할에 이 라벨이 없으면 채점 불가 — 0으로 벌주지 않는다
        p = tp / (tp + fp) if tp + fp else 0.0
        r = tp / (tp + fn) if tp + fn else 0.0
        f1s.append(2 * p * r / (p + r) if p + r else 0.0)
    return sum(f1s) / len(f1s) if f1s else 0.0


def model_name(v: str) -> str:
    """도장에 들어갈 이름 — 구분자가 섞이면 그 자리에서 거절한다 (승격 뒤에 발견하면 이미 소견에 박힌 뒤다)."""
    import argparse as _ap
    if not v or any(ch in v for ch in " @/"):
        raise _ap.ArgumentTypeError(f"모델 이름에 공백·@·/ 를 쓸 수 없습니다: {v!r} (예: IRIS.v6)")
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", nargs="+", required=True)
    # 모델의 이름 — config.json 에 적혀 파일과 함께 간다 (회신 13호). 대장(ledger)의 run 과 같은 값.
    # .env 의 STUDENT_MODEL_TAG 는 사람이 타이핑한 주장이고, 이것이 사이드카 /health 로 나가는 사실이다
    # name = 짧고 안정된 **이름**(도장·화면) / run = 사람이 읽는 **회차 기록**(대장과 같은 문장). 둘을
    # 한 칸에 두면 대장 문장이 소견 도장에 박힌다 (회신 14호). 이름에는 구분자(공백·@·/)가 못 들어온다 —
    # 도장 형식 student:{name}@t{임계값}/L{라벨수} 의 경계가 흐려지기 때문
    ap.add_argument("--name", required=True, type=model_name, help="모델 이름, 예: IRIS.v6-P1-A (공백·@·/ 금지)")
    ap.add_argument("--run", default=None, help="회차 기록 — 대장(ledger)의 run 과 같은 문장")
    ap.add_argument("--base", default=DEFAULT_MODEL)
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--lr", type=float, default=3e-5)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--doc-weight", type=float, default=1.0,
                    help="문서 예시 손실 배율 — CARD_MISMATCH 가 묻히면 올린다")
    # 롤백 레버 (2차 검토 H-1 확정): 대화 교사 라벨이 의심되면 그 출처만 걷어내고 재학습한다.
    # 예: --exclude-labeler conversation:  (접두사 일치 — 모델명이 바뀌어도 걸린다)
    ap.add_argument("--exclude-labeler", action="append", default=[],
                    help="이 접두사로 시작하는 labeler의 예시를 제외 (반복 지정 가능)")
    # 3차 검토 F-3: 외부 검토 둘이 정반대 답을 냈다 (마스킹하라 / 하지 마라).
    # 둘 다 논거가 성립해 문서로 정할 수 없으므로 스위치로 두고 하네스가 판정한다.
    # 기본값 OFF인 이유는 표본 수다 — 마스킹하면 위반 73건 × 미명시 7차원 = 511개의
    # 음성 신호가 사라지고, 남는 음성은 정상 51건 × 8 = 408개뿐이다. 그러면 모델이
    # 유형 사이의 경계를 배울 자리가 없어져 라벨을 남발할 수 있고, 그 결과가 곧 오탐이다.
    # 실제로 겹치는 문장은 손코퍼스에서 소수라 노이즈 비율이 낮다는 판단이 더해진다.
    # **둘 다 돌려 보고 오탐률이 낮은 쪽을 고른다** — 이 값의 근거는 그 측정이다.
    ap.add_argument("--mask-unlabeled", action="store_true",
                    help="위반 예시의 미명시 라벨을 손실에서 제외 (기본: 음성으로 학습)")
    # ── pos_weight 는 재서 고르는 값이 아니라 **유도되는 값**이다 (8차 E-3) ──
    #
    # 예전에는 라벨별 (음성/양성)을 그대로 썼다. 이 코퍼스에서 11~15가 나오는데,
    # BCE에서 그 값은 "미탐이 오탐보다 13배 나쁘다"를 뜻한다 — 이 프로젝트가 명시한
    # 비용 모델(**오탐 > 미탐**: 에스크로 환불은 되돌릴 수 있고 떠난 리서처는 못 되돌린다)의
    # 정반대다. 그래서 8차 중반에 --pos-weight-cap 으로 눌러 봤는데, 그건 그것대로
    # 문제였다: **128건짜리 채점지에서 임계값과 저울을 동시에 스윕**하는 셈이라
    # 손실 함수 공간 자체가 검증셋에 맞춰 흔들린다(8차 검토 E-3 지적).
    #
    # 유도식:  pos_weight = (음성/양성) / λ
    #   ① (음성/양성) 로 라벨 불균형을 상쇄한다 — 여기까지가 "비용이 같다면"의 지점이다
    #   ② λ 로 되돌린다 — 오탐이 미탐보다 λ배 나쁘므로 양성 쪽을 그만큼 덜 민다
    # 이 코퍼스에서 (음성/양성) ≈ 15, λ = 4 이면 **약 3.75**가 나온다.
    # (8차에 손으로 골랐던 3과 거의 같은 자리다 — 값이 아니라 근거가 바뀐 것이다.)
    #
    # λ 는 하네스의 COST_RATIO 와 **같은 수**여야 한다. 학습이 한 비용비로 배우고
    # 채택 판정이 다른 비용비로 재면, 둘 다 옳아도 합쳐서 틀린다.
    ap.add_argument("--cost-ratio", type=float, default=4.0,
                    help="오탐 1건이 미탐 1건의 몇 배로 나쁜가 (scripts/evalStudent.ts COST_RATIO 와 일치)")
    # 안전장치로만 남는다 — 유도식이 이상한 값을 낼 때(어떤 라벨의 양성이 1건뿐인 경우 등)
    # 학습이 폭주하지 않게 막는 천장이지, 성능을 맞추는 손잡이가 아니다.
    ap.add_argument("--pos-weight-cap", type=float, default=50.0,
                    help="유도값의 안전 상한 (성능 조절용 아님)")
    args = ap.parse_args()

    random.seed(SEED)
    torch.manual_seed(SEED)

    labels = json.loads(Path("data/labels.json").read_text(encoding="utf-8"))
    rows = load_examples(args.data)
    if args.exclude_labeler:
        before = len(rows)
        rows = [r for r in rows
                if not any(r.get("labeler", "").startswith(p) for p in args.exclude_labeler)]
        print(f"labeler 제외: {before - len(rows)}건 제거 ({', '.join(args.exclude_labeler)})")
    random.shuffle(rows)
    n_val = max(1, len(rows) // 10)
    val_rows, train_rows = rows[:n_val], rows[n_val:]
    print(f"학습 {len(train_rows)}건 / 검증 {n_val}건 / 라벨 {len(labels)}차원")

    tokenizer = AutoTokenizer.from_pretrained(args.base)
    train_ds = JsonlDataset(train_rows, labels, tokenizer)
    val_ds = JsonlDataset(val_rows, labels, tokenizer)

    # pos_weight: 라벨별 (음성 수 / 양성 수). 드문 라벨(특히 CARD_MISMATCH)의 손실을 키운다
    counts = torch.zeros(len(labels))
    for r in train_rows:
        for l in r["labels"]:
            counts[labels.index(l)] += 1
    pos_weight = torch.tensor([
        (len(train_rows) - c) / c / args.cost_ratio if c > 0 else 1.0 for c in counts
    ]).clamp(max=args.pos_weight_cap)
    print(f"pos_weight (= 음성/양성 ÷ λ, λ={args.cost_ratio}):",
          {l: round(w.item(), 2) for l, w in zip(labels, pos_weight)})

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = Student(args.base, len(labels)).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight.to(device), reduction="none")

    best = (-1.0, float("-inf"))  # (AP, 순이익) — 순이익은 음수로 시작할 수 있다
    out_dir = Path("out/student")
    out_dir.mkdir(parents=True, exist_ok=True)

    for epoch in range(args.epochs):
        model.train()
        total = 0.0
        for batch in DataLoader(train_ds, batch_size=args.batch, shuffle=True, collate_fn=collate):
            opt.zero_grad()
            logits = model(batch["input_ids"].to(device), batch["attention_mask"].to(device))
            raw = loss_fn(logits, batch["labels"].to(device))
            if args.mask_unlabeled:
                m = batch["loss_mask"].to(device)
                # 마스크가 가린 차원은 분모에서도 빼야 한다 — .mean(dim=1) 그대로 두면
                # 가린 만큼 손실이 작아져, 라벨이 하나뿐인 예시일수록 덜 배우게 된다
                per = (raw * m).sum(dim=1) / m.sum(dim=1).clamp(min=1.0)
            else:
                per = raw.mean(dim=1)
            scale = 1.0 + (args.doc_weight - 1.0) * batch["is_doc"].to(device)
            loss = (per * scale).mean()
            loss.backward()
            opt.step()
            total += loss.item()

        model.eval()
        with torch.no_grad():
            vl, vt = [], []
            for batch in DataLoader(val_ds, batch_size=args.batch, collate_fn=collate):
                vl.append(model(batch["input_ids"].to(device), batch["attention_mask"].to(device)).cpu())
                vt.append(batch["labels"])
            logits, tgts = torch.cat(vl), torch.cat(vt)
            f1 = macro_f1(logits, tgts)
            ap = macro_ap(logits, tgts)
            nv, nv_t = net_value(logits, tgts, args.cost_ratio)
        print(f"epoch {epoch + 1}/{args.epochs}  loss {total:.3f}  "
              f"val 순이익 {nv:+.0f}@t{nv_t}  (macro-AP {ap:.3f} · F1@0.5 {f1:.3f})")

        # **AP를 주로, 순이익을 동점 판정으로** (9차 G-3 — 지시대로 해보고 되돌린 결과).
        #
        # 검토는 "채택선과 같은 공식으로 고르라"고 했고 그 논거(AP는 라벨 간 영점 정렬을
        # 보지 않는다)는 지금도 맞다. 그런데 **그대로 하니 하네스 성적이 나빠졌다**:
        #   AP 선택   → t=0.5, 최악 λ 순이익 17, 패러프레이즈 70.8%
        #   순이익 선택 → t=0.6, 최악 λ 순이익 15, 패러프레이즈 62.5%
        #
        # 원인은 지표가 아니라 **표본**이다. 검증 49건에 λ=4면 오탐 1건이 정탐 4건을 지워,
        # 순이익이 아홉 에포크 동안 0에 붙어 있다가 최대 +2였다(전 구간 t=0.8 선택 —
        # 사실상 "아무것도 예측하지 마라"가 최적해다). 그 좁은 정수 띠로는 고를 수 없다.
        # AP는 순위쌍 전부를 쓰므로 같은 49건에서 훨씬 많은 정보를 뽑는다.
        #
        # 그래서 역할을 나눈다 — **원칙이 아니라 표본 크기 때문이다**:
        #   선택(49건, 매 에포크)   → AP. 부드럽고 정보 밀도가 높다
        #   채택(128건, 규칙 기준선 차감) → 순이익. 배포 결정과 같은 공식
        # 다만 AP가 사실상 같은 두 체크포인트 사이에서는 순이익이 고르게 둔다 —
        # 그 자리에서는 검토의 논거(영점 정렬)가 그대로 유효하다.
        rank = (round(ap, 2), nv)
        if rank > best:
            best = rank
            torch.save(model.state_dict(), out_dir / "model.pt")
            tokenizer.save_pretrained(out_dir)
            (out_dir / "config.json").write_text(json.dumps({
                "name": args.name, "run": args.run,
                "base": args.base, "labels": labels, "max_len": MAX_LEN,
                "val_net_value": nv,
                "val_net_threshold": nv_t,
                "val_macro_ap": round(ap, 4),
                "val_macro_f1": round(f1, 4),
                "cost_ratio": args.cost_ratio,
                "pos_weight_cap": args.pos_weight_cap,
                "data": args.data,
                # **out_dir의 지문이다 — args.base가 아니다.** (2026-08-19 실행에서 잡힌 결함)
                # 서빙(사이드카)은 이 out_dir를 읽는데, save_pretrained가 저장하는 파일
                # 구성이 원본과 다르다(원본 vocab.txt / 저장본 tokenizer.json). 원본 지문을
                # 적어두면 **두 값이 영원히 달라 대조가 항상 실패**한다 — 실제로 그렇게 났다.
                # 지문이 답해야 하는 질문은 "이 모델과 함께 실린 토크나이저가 그대로인가"다.
                "tokenizer_sha": tokenizer_fingerprint(str(out_dir)),
            }, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n최고 val macro-AP {best[0]:.2f} (동점 판정 순이익 {best[1]:+.0f}) → out/student/")
    print("주의: 이 F1은 개발용 지표일 뿐입니다. 채택 판정은 반드시 저장소의 평가 하네스로")
    print("(npm run eval:screening 의 잣대 — 패러프레이즈 탐지율·오탐률·risk_heavy) 하세요.")


if __name__ == "__main__":
    main()
