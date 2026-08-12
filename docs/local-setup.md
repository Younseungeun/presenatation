# 로컬 개발 환경 셋업

작업 브랜치: `claude/session-start-59rfim` (모든 구현이 이 브랜치에 있음)

## 준비물

- Node.js 20 이상 (개발·검증은 v22에서 진행)
- Git

## 1. 클론 & 브랜치 체크아웃

```bash
git clone https://github.com/Younseungeun/presenatation.git
cd presenatation
git checkout claude/session-start-59rfim
npm install
```

## 2. 환경 변수 (`.env`)

`.env`는 git에 올라가지 않으므로 직접 만든다. 최소 구성:

```bash
DATABASE_URL="file:./dev.db"
```

선택 항목 (없어도 개발은 동작):

| 변수 | 용도 | 없을 때 |
|---|---|---|
| `AUTH_SECRET` | 세션 쿠키 서명 키 | 개발용 기본값 사용 |
| `IDENTITY_PEPPER` | 본인인증 CI 해시용 pepper | 개발용 기본값 사용 |
| `KIS_APP_KEY` / `KIS_APP_SECRET` | 국내·미국주식 시세·종목 상태 (한국투자증권) | KR 미등록, US는 개발 모드에서 Stooq 폴백 |
| `ANTHROPIC_API_KEY` | 게시 전 컴플라이언스 AI 검수 | 결정적 규칙만 적용 (AI 검수 생략) |

> 운영 배포 시에는 `AUTH_SECRET`·`IDENTITY_PEPPER`를 반드시 실제 난수로 설정한다.
> (미설정 시 개발 기본값이 쓰이므로 세션 위조가 가능하다.)

## 3. DB 마이그레이션 & 시드

```bash
npx prisma migrate dev          # SQLite(dev.db) 생성 + 전체 마이그레이션 적용
npm run sync:instruments -- --fixture   # 종목 마스터 오프라인 시드 (API 키 불필요)
npm run seed:real               # (권장) 실시세 기반 데모 — 기준가·목표가가 진짜 시세다
```

종목 마스터를 실데이터로 채우려면 KIS 키(KIS_APP_KEY·KIS_APP_SECRET)를 넣고 `npm run sync:instruments` (플래그 없이) 실행한다.
업비트(코인)는 키 없이 동작하고, 국내·미국주식은 KIS 키가 필요하다.

## 4. 개발 서버

```bash
npm run dev     # http://localhost:3000
```

같은 Wi-Fi의 핸드폰에서 확인하려면 PC의 사설 IP로 접속한다(`ipconfig`로 확인,
예: `http://192.168.0.10:3000`). 이때 `next.config.ts`의 `allowedDevOrigins`에 해당
대역이 포함되어 있어야 한다 — 없으면 `/_next/*` dev 리소스가 차단되어 **화면은 뜨지만
스크립트가 로드되지 않는다**(버튼·온보딩 등 클라이언트 동작 전부 무반응). 설정 변경 후에는
dev 서버를 재시작한다. 접속이 안 되면 Windows 방화벽에서 Node.js의 개인 네트워크 접근 허용.

## 5. 검증 명령

```bash
npm test                # Vitest 전체 (182건)
npx tsc --noEmit        # 타입 체크
npm run build           # 프로덕션 빌드
npx eslint src scripts  # 린트
```

## 자동 실행 (스케줄러)

```bash
npm run scheduler   # 포그라운드 — 개발 중 로그를 보며 돌릴 때
```

상시 운영은 pm2로 띄운다. 터미널을 닫아도 살아 있고, 죽으면 10초 뒤 다시 뜬다.

```bash
npm run pm2:start
```

| 명령 | 설명 |
|---|---|
| `npm run pm2:status` | 상태·재시작 횟수 (`↺`가 계속 오르면 뭔가 잘못된 것) |
| `npm run pm2:logs` | 최근 로그 (파일은 `logs/scheduler-*.log`) |
| `npm run pm2:restart` | 코드 수정 후 반영 |
| `npm run pm2:stop` | 정지 |

**부팅 시 자동 실행**은 별도 등록이 필요하다(윈도우는 `pm2 startup`을 지원하지 않는다).
레지스트리 시작 항목을 건드리므로 직접 실행한다:

```bash
npx pm2-startup install
```

| 언제 | 무엇 |
|---|---|
| 국내 15:35 KST / 미국 16:05 ET (마감 +5분) | 그 시장만 도달·기한 판정 → 판매 마감 |
| 한국 09:05 | 코인 일일 판정 (마감이 없어 고정 시각) |
| 장중 2분 | 열린 시장의 **감시 종목만** 시세 갱신 (코인은 한 번에) |
| 한국 04:00 | **DB 백업** (`backups/`에 14개 회전, 뜬 뒤 열어서 검증) |
| 한국 06:00 | 종목 마스터 동기화 + 미국 상태(나스닥 공개 파일) |
| 한국 07:00 | 컴플라이언스 보류 큐 운영 (시한 경과 초안 복귀) |
| 한국 07:10 | 국내 시장경보·거래정지 (카드 걸린 종목만) |
| 한국 07:20 | σ·앵커 결측 치유 (게시 때 시세 실패분) |
| 1·4·7·10월 1일 00:10 | 분기 시즌 재산정 (등급 승급·강등) |
| 매시 정각 | 마켓 규모 스냅샷 (띠지 24시간 증감의 기준값) |
| **기동 직후** | 밀린 판정 따라잡기 (창구에 꺼져 있었어도 놓치지 않게) |

**크론으로 배치를 각각 걸지 않는다.** KIS 토큰 발급이 분당 1회라 두 배치가 같은 분에
뜨면 하나가 실패하고, 초당 호출 제한도 계정 합산이라 큐가 분리되면 서로를 모르고
겹쳐 나간다. 한 프로세스의 순차 큐가 두 문제를 함께 없앤다.

### 거래일 달력

휴장일은 `src/domain/marketCalendar.ts`에 **손으로** 적는다. 현재 범위는 2026-12-31까지고,
끝나기 30일 전부터 주 1회 운영자 알림이 뜬다. 범위를 넘기면 공휴일도 거래일로 취급해
배치가 헛돈다(오판정은 나지 않는다 — 시세가 없으면 이월된다).

- **미국 콜럼버스의 날·재향군인의 날은 넣지 않는다** — 연방 공휴일이지만 주식시장은 연다
- **조기 마감(추수감사절 다음날·성탄 전야 13:00 ET)도 넣지 않는다** — 판정을 앞당기면
  장중가를 종가로 읽을 위험이 생긴다. 정규 시각에 판정해도 일봉은 이미 확정되어 있다
- **늦게 닫는 날(수능일 등)은 반드시 넣는다** — 안 넣으면 장중에 판정한다 (`LATE_CLOSE_DAYS`)

### DB 백업

```bash
npm run db:backup   # 수동 1회 (스케줄러가 매일 04:00에 같은 함수를 부른다)
```

SQLite `VACUUM INTO`로 뜬다 — 실행 중인 파일을 복사하면 쓰기 도중 페이지가 섞여 열리지
않는 파일이 나올 수 있어서다. 뜬 뒤 **열어서 `PRAGMA integrity_check`와 리포트 수를 확인**하고,
통과한 것만 세어 14개를 남긴다. 기본 위치는 `backups/`(git 제외) — DB와 같은 디스크라
디스크가 죽으면 함께 죽으므로, 실서비스에서는 `DB_BACKUP_DIR`로 다른 드라이브나
동기화 폴더를 지정한다.

## 주요 스크립트

| 명령 | 설명 |
|---|---|
| `npm run batch:judge` | 시한 도래 카드 판정 → 점수 → 3분기 정산 (멱등) |
| `npm run batch:season` | 분기 시즌 재산정 (등급 승급·강등) |
| `npm run risk:us` | 미국 종목 상태 — 나스닥 공개 파일(상장요건·거래정지·ETF) |
| `npm run risk:sync` | 국내 종목 시장경보·관리종목 갱신 (검증 중 카드의 종목만) |
| `npm run sync:instruments` | 종목 마스터 동기화 (`-- --fixture`로 오프라인 시드) |
| `npm run op:grant -- <email>` | 운영자 권한 부여 (`--revoke`로 회수) |
| `npm run db:backup` | DB 백업 1회 (검증 포함, 14개 회전) |
| `npm run batch:quotes` | 장중 시세 갱신 — **감시 대상 종목만** (2분 주기 권장) |
| `npm run batch:salesclose` | 판매 마감 기록 (시간 규칙 + 역방향 목표폭 이탈 — 시세 조회 필요) |
| `npm run seed:dev` / `seed:demo` | 개발·데모 데이터 시드 |
| `npm run seed:login` | **로그인 가능한 데모 계정** 생성 (휴대폰 `010-1234-5678`, 필명 데모유저) |
| `npm run anchor:backfill` | 액면분할 감지 앵커 채우기 — **시드 뒤 한 번 돌린다** |
| `npm run sigma:backfill` | 카드의 종목 실현 변동성(σ) 채우기 — **시드 뒤 한 번 돌린다** |

시드 스크립트는 카드에 σ를 넣지 않는다(시세 호출이 필요해서다). 그대로 두면 안정성
별점이 "—"로 뜨고 p₀가 자산군 평균으로 계산되므로, 데모 데이터를 만든 뒤에는
`npm run sigma:backfill`을 한 번 돌린다 (종목 단위로 한 번씩만 조회한다).

## 운영자 화면 접근

운영자 전용 화면(`/admin/judgments`, `/admin/settlements`)은 `role=OPERATOR`가 아니면 404다.

```bash
# 1) 로그인 화면(/login)에서 본인인증(스텁)으로 계정 생성
# 2) 해당 계정 이메일로 권한 부여
npm run op:grant -- <가입된 이메일>
```

가입 계정의 이메일은 본인인증 스텁이 자동 생성한다(`<해시>@identity.local`).
Prisma Studio(`npx prisma studio`)에서 User 테이블을 열어 확인하면 편하다.

## 로그인 데모 계정

본인인증 스텁은 휴대폰 번호로 결정적 CI를 만들어 **같은 번호 = 같은 계정**으로 연결한다.
화면 확인용 계정은 `npm run seed:login`으로 만든다 (구매·판정·환불·작성 카드까지 채워진다).

```
/login → 이름 아무거나 / 휴대폰 010-1234-5678 → "데모유저"로 로그인
```

`seed:demo`가 먼저 실행되어 있어야 한다(구매 대상 리포트를 그 리서처가 쓴다).
이미 계정이 있으면 다시 만들지 않고 안내만 출력한다.

## 참고

- 기획·구현 현황: 루트 `CLAUDE.md` (단일 기준 문서)
- 판정 데이터 설계: `docs/market-data.md`
- 법률 상담 정리: `docs/legal-consultation.md`
- 약관 문구 교체 지점: `src/domain/legalDocs.ts` (변호사 확정본 오면 `sections`·`version`·`draft` 수정)
