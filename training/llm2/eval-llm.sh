#!/usr/bin/env bash
# 로컬 LLM 하네스 러너 (36차 MM-1) — 전부 절대 경로 (r9 상대 경로 사고의 교훈).
#   bash training/llm2/eval-llm.sh <gguf파일명> <tag> [shots] [extra-args...]
# 예: bash training/llm2/eval-llm.sh Qwen3-4B-Instruct-2507-Q4_K_M.gguf qwen3-4b 0
set -u
export PATH="/usr/bin:/bin:/c/Program Files/nodejs:$PATH"
ROOT="/c/Users/jooyon/Desktop/CLAUDE CODE/presenatation"
LLM="$ROOT/local_models/llm2"
SRV="$LLM/llama.cpp-cuda/llama-server.exe"   # 정확도 실측 = GPU (판정은 장치 무관)
PORT=8788
MODEL="$1"; TAG="$2"; SHOTS="${3:-0}"; shift 3 || true
LOG="$LLM/results/server-$TAG.log"
mkdir -p "$LLM/results"

for p in $(netstat -ano | grep ":$PORT " | grep LISTENING | awk '{print $5}' | sort -u); do taskkill //PID $p //F >/dev/null 2>&1; done
# --reasoning-budget 0: Qwen3 류 하이브리드 모델의 생각 모드를 끈다 (안 끄면 content 가 비어 나옴 — 스모크 실측)
# NOJINJA=1 → 내장 템플릿 사용 (Kanana: jinja 의 peg 출력 파서가 문법 강제와 충돌 — 실측)
JFLAGS="--jinja --reasoning-budget 0"; [ "${NOJINJA:-0}" = "1" ] && JFLAGS=""
"$SRV" -m "$LLM/$MODEL" --port $PORT -ngl 99 --ctx-size 4096 $JFLAGS > "$LOG" 2>&1 &
SPID=$!
# /health 는 로딩 중에도 503 으로 응답한다 — 반드시 200 을 확인 (스모크에서 실측한 함정)
for i in $(seq 1 90); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health" 2>/dev/null)" = "200" ] && break
  sleep 2
done
echo "======== $TAG (shots=$SHOTS)  $(date +%H:%M:%S) ========"
cd "$ROOT"
npx tsx scripts/evalLocalLlm.ts --tag "$TAG" --shots "$SHOTS" --base "http://127.0.0.1:$PORT" "$@"
RC=$?
kill $SPID 2>/dev/null
for p in $(netstat -ano | grep ":$PORT " | grep LISTENING | awk '{print $5}' | sort -u); do taskkill //PID $p //F >/dev/null 2>&1; done
echo "DONE $TAG rc=$RC $(date +%H:%M:%S)"
exit $RC
