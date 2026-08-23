#!/usr/bin/env bash
# 110M 遺寃 ????31李??ъ쟾 ?깅줉 ?덉감 洹몃?濡?(training/README.md "110M 遺寃 ?????ъ쟾 ?깅줉").
# ??A = r5 ?ㅼ젙 / ??B = base 愿濡. ?먮즺 P0 / P1(+r8 180) / P2(+r6 264). ?쒖꽌??P0-A, P0-B, P1-A, P1-B, P2-A, P2-B.
# 寃곌낵瑜?蹂닿퀬 ?덉감瑜?諛붽씀吏 ?딅뒗?? 媛??곗? out/autopsy/<P>-<A|B>/ ???④퀬 export 源뚯? ?덈떎.
set -u
export PATH="/usr/bin:/bin:$PATH"  # Start-Process 로 띄운 비로그인 bash 는 PATH 가 비어 있다
PY=../sidecar/.venv/Scripts/python.exe
BASE=../local_models/student-base-110m
P0="data/synth.v2.jsonl data/generated.jsonl data/founder.jsonl"
P1="$P0 rejected/generated.r8-round6.jsonl"
P2="$P0 rejected/generated.r6-hardmargin.jsonl"
A="--epochs 8 --lr 3e-5 --batch 16 --cost-ratio 4 --pos-weight-cap 50"
B="--epochs 5 --lr 2e-5 --batch 16 --cost-ratio 4 --pos-weight-cap 50 --warmup 0.1 --weight-decay 0.01"
RUN="110M 遺寃 (31李??ъ쟾 ?깅줉) ??koelectra-base-v3 112M, 14M 怨?媛숈? ?좏겕?섏씠?"
export PYTHONIOENCODING=utf-8
for spec in "P0 A" "P0 B" "P1 A" "P1 B" "P2 A" "P2 B"; do
  set -- $spec; P=$1; R=$2
  case $P in P0) DATA=$P0;; P1) DATA=$P1;; P2) DATA=$P2;; esac
  case $R in A) ARGS=$A;; B) ARGS=$B;; esac
  OUT=out/autopsy/$P-$R
  mkdir -p "$OUT"
  echo "================ $P-$R  $(date +%H:%M:%S) ================"
  t0=$(date +%s)
  $PY -u train.py --data $DATA --base $BASE --out $OUT --name IRIS.v6-$P-$R --run "$RUN / $P ??$R" $ARGS > "$OUT/train.log" 2>&1; tail -6 "$OUT/train.log"
  echo "--- export $(date +%H:%M:%S) ---"
  STUDENT_OUT=$OUT $PY -u export_onnx.py > "$OUT/export.log" 2>&1; tail -4 "$OUT/export.log"
  echo "--- $P-$R ?뚯슂 $(( ($(date +%s) - t0) / 60 ))遺?---"
done
echo "ALL DONE $(date +%H:%M:%S)"
