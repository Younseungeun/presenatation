#!/usr/bin/env bash
# r9 라운드 — P1 + r9 로 110M 재학습 후 게이트 전수 (35차 LL-1 등록 절차 그대로).
set -u
export PATH="/usr/bin:/bin:/c/Program Files/nodejs:$PATH"
export PYTHONIOENCODING=utf-8
ROOT="/c/Users/jooyon/Desktop/CLAUDE CODE/presenatation"
GPU=./.venv-gpu/Scripts/python.exe
CPU=../sidecar/.venv/Scripts/python.exe
PY="$ROOT/sidecar/.venv/Scripts/python.exe"
URL="http://127.0.0.1:8766"
R5=a0eaa12a29da0762
DATA="data/synth.v2.jsonl data/generated.jsonl data/founder.jsonl rejected/generated.r8-round6.jsonl r9/generated.r9-solicit.jsonl"
OUT=out/r9/P1R9
mkdir -p "$OUT"
cd "$ROOT/training"
echo "======== TRAIN P1R9  $(date +%H:%M:%S) ========"
$GPU -u train.py --data $DATA --base ../local_models/student-base-110m --out "$OUT" \
  --name IRIS.v6-P1R9 --run "r9 라운드 (35차 LL-1) — P1 + SOLICIT 60쌍, 교체 후보 재선정 시도" \
  --epochs 8 --lr 3e-5 --batch 8 --accum 2 --cost-ratio 4 --pos-weight-cap 50 > "$OUT/train.log" 2>&1
tail -4 "$OUT/train.log"
echo "--- export $(date +%H:%M:%S) ---"
STUDENT_OUT=$OUT $CPU -u export_onnx.py > "$OUT/export.log" 2>&1
tail -3 "$OUT/export.log"
EV="$OUT/eval"; mkdir -p "$EV"
echo "======== GATES  $(date +%H:%M:%S) ========"
for p in $(netstat -ano | grep ":8766 " | grep LISTENING | awk '{print $5}' | sort -u); do taskkill //PID $p //F >/dev/null 2>&1; done
(cd "$ROOT/sidecar" && STUDENT_ARTIFACT_DIR="$ROOT/training/$OUT" "$PY" -m uvicorn app:app --port 8766 --log-level warning > "$EV/sidecar.log" 2>&1) &
SCPID=$!
for i in $(seq 1 40); do curl -s $URL/health >/dev/null 2>&1 && break; sleep 2; done
curl -s $URL/health > "$EV/health.json"
SHA=$(grep -o '"model_sha":"[^"]*"' "$EV/health.json" | cut -d'"' -f4)
echo "sha=$SHA"
cd "$ROOT"
E="STUDENT_SIDECAR_URL=$URL STUDENT_MODEL_TAG=P1R9"
env $E npx tsx scripts/evalStudent.ts --sweep         > "$EV/evalStudent.txt" 2>&1
env $E STUDENT_THRESHOLD=0.7 npx tsx scripts/evalControlStudent.ts --threshold 0.7 > "$EV/dart.txt" 2>&1
env $E npm run --silent seesaw:capture                > "$EV/seesaw-capture.txt" 2>&1
npx tsx scripts/compareSeesaw.ts -- --before training/baselines/seesaw-$R5.json --after training/baselines/seesaw-$SHA.json --targets UNSUPPORTED_CLAIM,CARD_MISMATCH,SOLICIT_CONTACT --threshold 0.7 > "$EV/seesaw.txt" 2>&1
env $E npx tsx scripts/probeAdverbShortcut.ts         > "$EV/adverb.txt" 2>&1
env $E npx tsx scripts/probeDilution.ts               > "$EV/dilution.txt" 2>&1
env $E npx tsx scripts/probeScoreMedian.ts            > "$EV/score-median.txt" 2>&1
env $E npx tsx scripts/selectPings.ts                 > "$EV/pings.txt" 2>&1
env $E npx tsx scripts/probeZeroShotR6.ts             > "$EV/zeroshot-r6.txt" 2>&1
kill $SCPID 2>/dev/null
for p in $(netstat -ano | grep ":8766 " | grep LISTENING | awk '{print $5}' | sort -u); do taskkill //PID $p //F >/dev/null 2>&1; done
echo "R9 RUN DONE $(date +%H:%M:%S)"
