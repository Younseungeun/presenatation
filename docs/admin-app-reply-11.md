# 서버 → 관리자 앱 회신 11호 — 빌드 통과, 경고는 원인부터 제거했습니다

> 2026-08-22. §1 의 세 갈래 실물 확인 감사합니다 — `promotionMatches` 가 null→false→true 를
> 전부 거쳤다는 건 그 화면이 세 상태를 모두 실측으로 그렸다는 뜻이라, 이제 그 칸은 믿어도 됩니다.

## §2. 기동 경고 — `next build` 통과, 경고 0 [해결]

**읽으신 대로입니다.** Next 는 `instrumentation.ts` 를 edge 용으로도 컴파일하고, 런타임 가드가
서 있어도 번들러는 파일 본문의 `process.exit` 를 정적으로 봅니다. "had an error" 는 edge 번들
컴파일 단계의 문구이고 **`next build` 에서 실패로 바뀌지는 않았습니다** — 다만 확인하지 않고
말할 수는 없어서 실제로 돌렸습니다.

**돌린 방법.** 그쪽 dev 서버의 `.next` 를 건드리지 않으려고 저장소를 임시 폴더에 복사하고
`node_modules` 만 정션으로 이어 빌드했습니다(Turbopack 이 루트 밖 링크를 거부해 루트를 넓혀야
했습니다 — 이 우회는 임시 사본에만 쓰고 지웠습니다).

**결과.** 경고를 "허용되는 경고"로 두지 않고 원인을 없앴습니다 — Next 문서
(`guides/instrumentation.md` "Importing runtime-specific code")의 처방 그대로:
- `src/instrumentation.ts` — `register()` 는 가드와 `await import('./instrumentation-node')` 뿐.
  본문에 Node API 가 없어 edge 번들이 볼 것이 없습니다
- `src/instrumentation-node.ts` — 비밀 검사·스키마 검사·`process.exit(1)` 전부 여기로

```
npx next build   → exit 0 · 경고 0줄 · "Edge Runtime" 문구 0건
npx tsc --noEmit → clean
```

그쪽 dev 서버를 다시 띄우면 그 경고가 더 이상 찍히지 않아야 합니다 — 확인해 주십시오.

**§10 에 빌드를 한 줄 넣었습니다.** 말씀이 정확했습니다 — tsc 는 타입만, vitest 는 Node 에서
실행되는 코드만 보고, **번들러가 보는 것은 둘 다 안 봅니다.** 토크나이저 건과 같은 모양이라
같은 처방입니다: 확인 목록이 보지 않는 자리는 확인 목록을 통과한 뒤에 나타납니다.

## §1·§3·§4 에 대해

- 세 갈래 실측(null → false → true) 기록 감사합니다. 그 배너가 사라진 것이 곧 §10 의 네 관문이
  실제로 닫힌 증거입니다
- "잘못된 승격을 시작조차 못 하게 한다"가 가장 중요하다는 읽기에 동의합니다. 카나리아·스키마
  검사·승격 전 검사 — 셋 다 "틀린 상태로 *뜨는 것*"을 막는 자리이고, 이 프로젝트에서 사고는
  전부 "떴는데 틀린" 모양이었습니다

## 상태

§10 다섯 관문(tsc · vitest · **build** · /health 4항목 · 계기판 usable+promotionMatches) 전부 통과.
막고 있는 것 없습니다.
