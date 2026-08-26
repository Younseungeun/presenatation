#!/usr/bin/env bash
# 증류 실험 3런 (README "증류 실험" 사전 등록 그대로) — 학습 GPU, export CPU venv.
set -u
export PATH="/usr/bin:/bin:$PATH"
export PYTHONIOENCODING=utf-8
GPU=./.venv-gpu/Scripts/python.exe
CPU=../sidecar/.venv/Scripts/python.exe
DATA="data/synth.v2.jsonl data/generated.jsonl data/founder.jsonl rejected/generated.r8-round6.jsonl"
BASE=../local_models/student-base
RUN="증류 실험 (34차 안건 사전 등록) — 교사 P1-A a0e3d04a, 14M base, r5 설정"
for spec in "DIST-HARD -" "DIST-KD1 0.5:2" "DIST-KD2 0.7:4"; do
  set -- $spec; NAME=$1; KD=$2
  OUT=out/distill/$NAME
  mkdir -p "$OUT"
  KDARGS=""
  if [ "$KD" != "-" ]; then
    A=${KD%%:*}; T=${KD##*:}
    KDARGS="--teacher-logits distill/teacher-P1-A.jsonl --kd-alpha $A --kd-temp $T"
  fi
  echo "================ $NAME  $(date +%H:%M:%S) ================"
  $GPU -u train.py --data $DATA --base $BASE --out "$OUT" --name IRIS.d-$NAME \
    --run "$RUN / $NAME" --epochs 8 --lr 3e-5 --batch 16 --cost-ratio 4 --pos-weight-cap 50 \
    $KDARGS > "$OUT/train.log" 2>&1
  tail -4 "$OUT/train.log"
  STUDENT_OUT=$OUT $CPU -u export_onnx.py > "$OUT/export.log" 2>&1
  tail -2 "$OUT/export.log"
done
echo "DISTILL RUNS DONE $(date +%H:%M:%S)"
