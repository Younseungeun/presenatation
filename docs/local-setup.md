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
| `FSC_API_KEY` | 금융위 국내주식 시세·종목 목록 | KR 자산군 공급자 미등록 |
| `TWELVEDATA_API_KEY` | 미국주식 시세·종목 목록 | 개발 모드에선 Stooq로 폴백 |

> 운영 배포 시에는 `AUTH_SECRET`·`IDENTITY_PEPPER`를 반드시 실제 난수로 설정한다.
> (미설정 시 개발 기본값이 쓰이므로 세션 위조가 가능하다.)

## 3. DB 마이그레이션 & 시드

```bash
npx prisma migrate dev          # SQLite(dev.db) 생성 + 전체 마이그레이션 적용
npm run sync:instruments -- --fixture   # 종목 마스터 오프라인 시드 (API 키 불필요)
npm run seed:demo               # (선택) 데모 리서처·리포트·판정 이력
```

종목 마스터를 실데이터로 채우려면 API 키를 넣고 `npm run sync:instruments` (플래그 없이) 실행한다.
업비트(코인)는 키 없이 동작하고, 국내·미국주식은 위 API 키가 필요하다.

## 4. 개발 서버

```bash
npm run dev     # http://localhost:3000
```

## 5. 검증 명령

```bash
npm test                # Vitest 전체 (182건)
npx tsc --noEmit        # 타입 체크
npm run build           # 프로덕션 빌드
npx eslint src scripts  # 린트
```

## 주요 스크립트

| 명령 | 설명 |
|---|---|
| `npm run batch:judge` | 시한 도래 카드 판정 → 점수 → 3분기 정산 (멱등) |
| `npm run batch:season` | 분기 시즌 재산정 (등급 승급·강등) |
| `npm run sync:instruments` | 종목 마스터 동기화 (`-- --fixture`로 오프라인 시드) |
| `npm run op:grant -- <email>` | 운영자 권한 부여 (`--revoke`로 회수) |
| `npm run seed:dev` / `seed:demo` | 개발·데모 데이터 시드 |

## 운영자 화면 접근

운영자 전용 화면(`/admin/judgments`, `/admin/settlements`)은 `role=OPERATOR`가 아니면 404다.

```bash
# 1) 로그인 화면(/login)에서 본인인증(스텁)으로 계정 생성
# 2) 해당 계정 이메일로 권한 부여
npm run op:grant -- <가입된 이메일>
```

가입 계정의 이메일은 본인인증 스텁이 자동 생성한다(`<해시>@identity.local`).
Prisma Studio(`npx prisma studio`)에서 User 테이블을 열어 확인하면 편하다.

## 참고

- 기획·구현 현황: 루트 `CLAUDE.md` (단일 기준 문서)
- 판정 데이터 설계: `docs/market-data.md`
- 법률 상담 정리: `docs/legal-consultation.md`
- 약관 문구 교체 지점: `src/domain/legalDocs.ts` (변호사 확정본 오면 `sections`·`version`·`draft` 수정)
