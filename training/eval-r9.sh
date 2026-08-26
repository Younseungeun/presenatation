#!/usr/bin/env bash
# P1R9 게이트 전수 (r9-run.sh 의 게이트 단계 재실행 — 상대 경로 사고 수정판, 전부 절대 경로)
set -u
export PATH="/usr/bin:/bin:/c/Program Files/nodejs:$PATH"
export PYTHONIOENCODING=utf-8
ROOT="/c/Users/jooyon/Desktop/CLAUDE CODE/presenatation"
PY="$ROOT/sidecar/.venv/Scripts/python.exe"
URL="http://127.0.0.1:8766"
R5=a0eaa12a29da0762
DIR="$ROOT/training/out/r9/P1R9"
EV="$DIR/eval"; mkdir -p "$EV"
echo "======== P1R9 GATES  $(date +%H:%M:%S) ========"
for p in $(netstat -ano | grep ":8766 " | grep LISTENING | awk '{print $5}' | sort -u); do taskkill //PID $p //F >/dev/null 2>&1; done
(cd "$ROOT/sidecar" && STUDENT_ARTIFACT_DIR="$DIR" "$PY" -m uvicorn app:app --port 8766 --log-level warning > "$EV/sidecar.log" 2>&1) &
SCPID=$!
for i in $(seq 1 60); do curl -s $URL/health >/dev/null 2>&1 && break; sleep 2; done
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
echo "P1R9 GATES DONE $(date +%H:%M:%S)"
