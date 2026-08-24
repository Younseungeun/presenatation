#!/usr/bin/env bash
# 110M 부검 — 게이트 전수 측정 (31차 사전 등록 "재는 것" 그대로). 런마다 후보 사이드카(8766)에
# 올려 채점지 스윕·핑 · DART 정제판 · 시소(기준 r5) · 부사 · 희석 · 점수 분포 · 지연 · zero-shot(P0만).
set -u
export PATH="/usr/bin:/bin:/c/Program Files/nodejs:$PATH"
export PYTHONIOENCODING=utf-8
ROOT="/c/Users/jooyon/Desktop/CLAUDE CODE/presenatation"
PY="$ROOT/sidecar/.venv/Scripts/python.exe"
URL="http://127.0.0.1:8766"
R5=a0eaa12a29da0762
for run in P0-A P0-B P1-A P1-B P2-A P2-B; do
  DIR="$ROOT/training/out/autopsy/$run"
  EV="$DIR/eval"; mkdir -p "$EV"
  # 겨냥 라벨: P1 = r8 과목(UNSUPPORTED·CM) / P2 = 하드마진 과목(PG·PRIVATE·SOLICIT) / P0 = 없음
  case $run in P1-*) TGT=UNSUPPORTED_CLAIM,CARD_MISMATCH;; P2-*) TGT=PROFIT_GUARANTEE,PRIVATE_INFO,SOLICIT_CONTACT;; *) TGT=NONE;; esac
  echo "======== $run  $(date +%H:%M:%S) ========"
  # 남은 8766 정리 후 후보 기동
  for p in $(netstat -ano | grep ":8766 " | grep LISTENING | awk '{print $5}' | sort -u); do taskkill //PID $p //F >/dev/null 2>&1; done
  (cd "$ROOT/sidecar" && STUDENT_ARTIFACT_DIR="$DIR" "$PY" -m uvicorn app:app --port 8766 --log-level warning > "$EV/sidecar.log" 2>&1) &
  SCPID=$!
  for i in $(seq 1 40); do curl -s $URL/health >/dev/null 2>&1 && break; sleep 2; done
  curl -s $URL/health > "$EV/health.json"
  SHA=$(grep -o '"model_sha":"[^"]*"' "$EV/health.json" | cut -d'"' -f4)
  echo "sha=$SHA deployed=$(grep -o '"model_file":"[^"]*"' "$EV/health.json" | cut -d'"' -f4)"
  cd "$ROOT"
  E="STUDENT_SIDECAR_URL=$URL STUDENT_MODEL_TAG=$run"
  env $E npx tsx scripts/evalStudent.ts --sweep         > "$EV/evalStudent.txt" 2>&1
  env $E STUDENT_THRESHOLD=0.7 npx tsx scripts/evalControlStudent.ts --threshold 0.7 > "$EV/dart.txt" 2>&1
  env $E npm run --silent seesaw:capture                > "$EV/seesaw-capture.txt" 2>&1
  npx tsx scripts/compareSeesaw.ts -- --before training/baselines/seesaw-$R5.json --after training/baselines/seesaw-$SHA.json --targets $TGT --threshold 0.7 > "$EV/seesaw.txt" 2>&1
  env $E npx tsx scripts/probeAdverbShortcut.ts         > "$EV/adverb.txt" 2>&1
  env $E npx tsx scripts/probeDilution.ts               > "$EV/dilution.txt" 2>&1
  env $E npx tsx scripts/probeScoreMedian.ts            > "$EV/score-median.txt" 2>&1
  env $E npx tsx scripts/probeWindowCap.ts              > "$EV/latency.txt" 2>&1
  case $run in P0-*) env $E npx tsx scripts/probeZeroShotR8.ts > "$EV/zeroshot.txt" 2>&1;; esac
  kill $SCPID 2>/dev/null
  for p in $(netstat -ano | grep ":8766 " | grep LISTENING | awk '{print $5}' | sort -u); do taskkill //PID $p //F >/dev/null 2>&1; done
  echo "$run done $(date +%H:%M:%S)"
done
echo "EVAL ALL DONE $(date +%H:%M:%S)"
