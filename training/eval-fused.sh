#!/usr/bin/env bash
# 융합본(923921208bfc6815) 게이트 전수 — JJ-5 등록 절차의 조기 실행 (35차 안건 LL-4).
# 판정 기준: fp32 원본(P1-A)과 게이트 결과가 전 항목 동일해야 한다. 경계값 문장의
# 이진 판정이 하나라도 뒤집히면 융합본 폐기(33차 JJ-5 반증 조건).
set -u
export PATH="/usr/bin:/bin:/c/Program Files/nodejs:$PATH"
export PYTHONIOENCODING=utf-8
ROOT="/c/Users/jooyon/Desktop/CLAUDE CODE/presenatation"
PY="$ROOT/sidecar/.venv/Scripts/python.exe"
URL="http://127.0.0.1:8766"
R5=a0eaa12a29da0762
TGT=UNSUPPORTED_CLAIM,CARD_MISMATCH
DIR="$ROOT/training/out/candidates/a0e3d04aa8892cdc-fused"
EV="$DIR/eval"; mkdir -p "$EV"
echo "======== FUSED  $(date +%H:%M:%S) ========"
for p in $(netstat -ano | grep ":8766 " | grep LISTENING | awk '{print $5}' | sort -u); do taskkill //PID $p //F >/dev/null 2>&1; done
(cd "$ROOT/sidecar" && STUDENT_ARTIFACT_DIR="$DIR" "$PY" -m uvicorn app:app --port 8766 --log-level warning > "$EV/sidecar.log" 2>&1) &
SCPID=$!
for i in $(seq 1 40); do curl -s $URL/health >/dev/null 2>&1 && break; sleep 2; done
curl -s $URL/health > "$EV/health.json"
SHA=$(grep -o '"model_sha":"[^"]*"' "$EV/health.json" | cut -d'"' -f4)
echo "sha=$SHA"
cd "$ROOT"
E="STUDENT_SIDECAR_URL=$URL STUDENT_MODEL_TAG=FUSED"
env $E npx tsx scripts/evalStudent.ts --sweep         > "$EV/evalStudent.txt" 2>&1
env $E STUDENT_THRESHOLD=0.7 npx tsx scripts/evalControlStudent.ts --threshold 0.7 > "$EV/dart.txt" 2>&1
env $E npm run --silent seesaw:capture                > "$EV/seesaw-capture.txt" 2>&1
npx tsx scripts/compareSeesaw.ts -- --before training/baselines/seesaw-$R5.json --after training/baselines/seesaw-$SHA.json --targets $TGT --threshold 0.7 > "$EV/seesaw.txt" 2>&1
env $E npx tsx scripts/probeAdverbShortcut.ts         > "$EV/adverb.txt" 2>&1
env $E npx tsx scripts/probeDilution.ts               > "$EV/dilution.txt" 2>&1
env $E npx tsx scripts/probeScoreMedian.ts            > "$EV/score-median.txt" 2>&1
env $E npx tsx scripts/selectPings.ts                 > "$EV/pings.txt" 2>&1
env $E npx tsx scripts/probeZeroShotR6.ts             > "$EV/zeroshot-r6.txt" 2>&1
kill $SCPID 2>/dev/null
for p in $(netstat -ano | grep ":8766 " | grep LISTENING | awk '{print $5}' | sort -u); do taskkill //PID $p //F >/dev/null 2>&1; done
echo "FUSED EVAL DONE $(date +%H:%M:%S)"
