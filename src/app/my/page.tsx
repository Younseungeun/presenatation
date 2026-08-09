import Link from "next/link";
import type { Tier } from "@/domain/constants";
import { MAX_ACTIVE_CARDS } from "@/domain/publishReport";
import { prisma } from "@/server/db";
import {
  getBuyerPurchases,
  getResearcherFinance,
  type BuyerPurchase,
} from "@/server/financeQueries";
import { countCart } from "@/server/cartService";
import { getFollowerList, getFollowingList } from "@/server/followService";
import { getResearcherDashboard, type DashboardReport } from "@/server/reportQueries";
import { researcherSeasonScores } from "@/server/scoreService";
import { getSessionUserId } from "@/server/session";
import { AppHeader } from "../AppHeader";
import { EmptyState } from "../EmptyState";
import { cardLine, dday, fmtDate } from "../format";
import { StatusChip, outcomeStatus, type StatusKind } from "../StatusChip";
import { TierChip } from "../TierChip";
import styles from "../market.module.css";
import { WalletIcon } from "../brand/WalletIcon";
import {
  BellIcon,
  DocIcon,
  EscrowIcon,
  HitRateIcon,
  PayoutIcon,
  PenIcon,
  RefundIcon,
  ScoreIcon,
  SettingsIcon,
  SlotIcon,
} from "./icons";
import { CollapsedList } from "./CollapsedList";
import s from "./my.module.css";

export const dynamic = "force-dynamic";

// MY — 소비자(구매) 모드와 리서처(판매) 모드를 상단 헤더에서 전환한다.
// 구매: 에스크로·환불·구매 적중률 요약 + 구매한 카드(전체/검증 중/검증 완료)
// 판매: 정산 대기·누적 정산·적중률·활성 슬롯·시즌 점수 + 작성 카드(전체/판매 중/판정 완료)

type Mode = "buyer" | "seller";
type BuyerTab = "all" | "active" | "done";
type SellerTab = "all" | "live" | "settled";

const MODES: { key: Mode; label: string }[] = [
  { key: "buyer", label: "내 구매" },
  { key: "seller", label: "내 리서치" },
];

const BUYER_TABS: { key: BuyerTab; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "active", label: "검증 중" },
  { key: "done", label: "검증 완료" },
];

const SELLER_TABS: { key: SellerTab; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "live", label: "판매 중" },
  { key: "settled", label: "판정 완료" },
];

// 금액은 반올림하지 않고 그대로 보여준다(요약 타일이라도 돈은 정확해야 한다).
// 자리수가 지나치게 길어질 때만 억 단위로 축약한다.
function formatKrw(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}억원`;
  return `${n.toLocaleString()}원`;
}

function outcomeBadge(outcome: string) {
  return <StatusChip status={outcomeStatus(outcome)} />;
}

function Tile({
  href,
  icon,
  value,
  label,
  dot,
}: {
  href: string;
  icon: React.ReactNode;
  value?: string;
  label: string;
  dot?: boolean;
}) {
  return (
    <Link href={href} className={s.tile}>
      <span className={s.tileIcon}>
        {icon}
        {dot && <span className={s.tileDot} />}
      </span>
      {value && <span className={s.tileValue}>{value}</span>}
      <span className={s.tileLabel}>{label}</span>
    </Link>
  );
}

/** 구매한 리포트의 예측 카드 */
function PurchasedCard({ p, now }: { p: BuyerPurchase; now: Date }) {
  const card = p.report.predictionCard;
  const judgment = card?.judgment;
  const researcher = p.report.researcher.user.penName ?? p.report.researcher.user.email;

  return (
    <Link href={`/report/${p.report.id}`} className={styles.reportCard}>
      <div className={styles.reportTitle}>
        {p.report.title}
        {judgment && outcomeBadge(judgment.outcome)}
      </div>
      <div className={styles.meta}>
        <span>{researcher}</span>
        {card && <span>{cardLine(card)}</span>}
      </div>
      <div className={styles.meta}>
        <span>{p.amountKrw.toLocaleString()}원</span>
        {judgment ? (
          <>
            {judgment.realizedReturnPct != null && (
              <span>
                실현 {judgment.realizedReturnPct >= 0 ? "+" : ""}
                {judgment.realizedReturnPct.toFixed(1)}%
              </span>
            )}
            {p.settlement && p.settlement.buyerRefundKrw > 0 && (
              <span className={styles.pill}>
                환불 {p.settlement.buyerRefundKrw.toLocaleString()}원
              </span>
            )}
          </>
        ) : (
          <>
            {card && <span>{dday(card.deadline, now)}</span>}
            {card && <span>시한 {fmtDate(card.deadline)}</span>}
            <StatusChip status="VERIFYING" label="검증 중 · 에스크로" />
          </>
        )}
      </div>
    </Link>
  );
}

/** 내가 작성한 리포트의 예측 카드 */
function AuthoredCard({ r, now }: { r: DashboardReport; now: Date }) {
  const card = r.predictionCard;
  const judgment = card?.judgment;
  const status: StatusKind =
    r.status === "DRAFT" ? "DRAFT" : r.status === "PUBLISHED" ? "SELLING" : "ENDED";

  return (
    <Link href={`/report/${r.id}`} className={styles.reportCard}>
      <div className={styles.reportTitle}>
        {r.title}
        {judgment ? outcomeBadge(judgment.outcome) : <StatusChip status={status} />}
      </div>
      <div className={styles.meta}>
        {card ? <span>{cardLine(card)}</span> : <span>예측 카드 없음</span>}
        {card?.withdrawnAt && <StatusChip status="WITHDRAWN" />}
      </div>
      <div className={styles.meta}>
        <span>{r.priceKrw.toLocaleString()}원</span>
        <span>판매 {r._count.purchases}건</span>
        {card &&
          (judgment ? (
            <span>판정 {fmtDate(judgment.judgedAt)}</span>
          ) : (
            <span>
              {dday(card.deadline, now)} · 시한 {fmtDate(card.deadline)}
            </span>
          ))}
      </div>
    </Link>
  );
}

function MenuRow({
  href,
  label,
  sub,
  hardNav,
}: {
  href: string;
  label: string;
  sub?: string;
  /** 전체 페이지 로드가 필요한 경우(앱 실행 화면 재생) — 소프트 내비게이션은 재실행되지 않는다 */
  hardNav?: boolean;
}) {
  const body = (
    <>
      <div className={styles.rowMain}>
        <div className={styles.rowName}>{label}</div>
        {sub && <div className={styles.rowSub}>{sub}</div>}
      </div>
      <span className={styles.rowArrow} aria-hidden="true">
        ›
      </span>
    </>
  );
  return hardNav ? (
    <a href={href} className={styles.row}>
      {body}
    </a>
  ) : (
    <Link href={href} className={styles.row}>
      {body}
    </Link>
  );
}

async function loadMe(mode: Mode) {
  const userId = await getSessionUserId();
  if (!userId) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      penName: true,
      email: true,
      role: true,
      identityVerified: true,
      researcherProfile: { select: { id: true, tier: true } },
    },
  });
  if (!user) return null;

  const researcherId = user.researcherProfile?.id ?? null;
  const sellerMode = mode === "seller" && researcherId !== null;
  const [
    unreadCount,
    cartCount,
    purchases,
    dashboard,
    finance,
    seasonScores,
    following,
    followers,
  ] = await Promise.all([
    prisma.notification.count({ where: { userId, readAt: null } }),
    countCart(prisma, userId),
    getBuyerPurchases(prisma, userId),
    sellerMode ? getResearcherDashboard(prisma, researcherId!) : Promise.resolve(null),
    sellerMode ? getResearcherFinance(prisma, researcherId!) : Promise.resolve(null),
    sellerMode ? researcherSeasonScores(prisma, researcherId!) : Promise.resolve(null),
    // 팔로잉은 누구나 가질 수 있다 (구매자 관점) — '내 구매'에서 본다
    sellerMode ? Promise.resolve([]) : getFollowingList(prisma, userId),
    // 팔로워는 리서처만 가진다 (Follow는 사용자→리서처) — '내 리서치'에서 본다
    sellerMode ? getFollowerList(prisma, researcherId!) : Promise.resolve([]),
  ]);

  const judged = purchases.filter((p) => p.report.predictionCard?.judgment);
  const decided = judged.filter((p) =>
    ["HIT", "MISS"].includes(p.report.predictionCard!.judgment!.outcome),
  );
  const hits = decided.filter((p) => p.report.predictionCard!.judgment!.outcome === "HIT");

  // 판매자 지표 — 내가 쓴 카드 기준
  const authored = dashboard?.reports ?? [];
  const myJudged = authored.filter((r) => r.predictionCard?.judgment);
  const myDecided = myJudged.filter((r) =>
    ["HIT", "MISS"].includes(r.predictionCard!.judgment!.outcome),
  );
  const myHits = myDecided.filter((r) => r.predictionCard!.judgment!.outcome === "HIT");
  // 활성 카드 = 게시됨 · 미판정 · 미철회 (슬롯을 점유하는 상태)
  const activeCards = authored.filter(
    (r) =>
      r.status === "PUBLISHED" &&
      r.predictionCard != null &&
      !r.predictionCard.judgment &&
      !r.predictionCard.withdrawnAt,
  );
  const tier = (user.researcherProfile?.tier ?? "BRONZE") as Tier;

  return {
    ...user,
    researcherId,
    unreadCount,
    cartCount,
    following,
    followers,
    purchases,
    active: purchases.filter((p) => !p.report.predictionCard?.judgment),
    done: judged,
    authored,
    heldKrw: purchases
      .filter((p) => p.escrowStatus === "HELD")
      .reduce((a, p) => a + p.amountKrw, 0),
    refundedKrw: purchases.reduce((a, p) => a + (p.settlement?.buyerRefundKrw ?? 0), 0),
    buyHitRate: decided.length > 0 ? hits.length / decided.length : null,
    seller: {
      pendingKrw: finance?.totals.heldKrw ?? 0,
      payoutKrw: finance?.totals.payoutKrw ?? 0,
      salesCount: finance?.totals.salesCount ?? 0,
      hitRate: myDecided.length > 0 ? myHits.length / myDecided.length : null,
      activeCount: activeCards.length,
      maxActive: MAX_ACTIVE_CARDS[tier],
      // 자산군별로 나뉜 시즌 점수의 합 — 타일에는 총합만 보여준다
      seasonScore: seasonScores
        ? Object.values(seasonScores).reduce((a, b) => a + b, 0)
        : 0,
      publishedCount: authored.filter((r) => r.status === "PUBLISHED").length,
      judgedCount: myJudged.length,
    },
  };
}

function ModeSwitch({ mode }: { mode: Mode }) {
  return (
    <div className={s.modeSwitch}>
      {MODES.map((m, i) => (
        <span key={m.key} style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
          {i > 0 && <span className={s.modeDivider} />}
          <Link
            href={`/my?mode=${m.key}`}
            className={`${s.mode} ${m.key === mode ? s.modeActive : ""}`}
            aria-current={m.key === mode ? "page" : undefined}
          >
            {m.label}
          </Link>
        </span>
      ))}
    </div>
  );
}

/** MY 상단 헤더 — 좌: 설정, 가운데: 모드 전환, 우: 장바구니(담은 건수 배지) */
function MyHeader({ mode, cartCount }: { mode: Mode; cartCount: number }) {
  return (
    <AppHeader
      seamless
      center={<ModeSwitch mode={mode} />}
      left={
        <Link href="/settings" className="appbarIconBtn" aria-label="설정">
          <SettingsIcon />
        </Link>
      }
      right={
        <Link href="/cart" className="appbarIconBtn" aria-label="장바구니">
          {/* 인투빌 장바구니(카드지갑) — 담긴 상태는 min(개수,2), 실제 개수는 배지 */}
          <WalletIcon count={cartCount} />
          {cartCount > 0 && (
            <span className="appbarBadge">{cartCount > 99 ? "99+" : cartCount}</span>
          )}
        </Link>
      }
    />
  );
}

export default async function MyPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; tab?: string }>;
}) {
  const sp = await searchParams;
  const mode = (MODES.find((m) => m.key === sp.mode)?.key ?? "buyer") as Mode;
  // tab 값은 모드마다 다른 집합을 쓴다 (구매: all/active/done, 판매: all/live/settled)
  const tab = (BUYER_TABS.find((t) => t.key === sp.tab)?.key ?? "all") as BuyerTab;
  const sellerTab = (SELLER_TABS.find((t) => t.key === sp.tab)?.key ?? "all") as SellerTab;
  const me = await loadMe(mode);
  const now = new Date();

  if (!me) {
    return (
      <>
        <MyHeader mode={mode} cartCount={0} />
        <main className={styles.page}>
          <h1 className="srOnly">MY</h1>
          <p className={styles.sub}>
            로그인하면 구매한 예측 카드의 검증 현황과 판정 결과를 확인할 수 있습니다.
          </p>
          <div className={styles.list}>
            <MenuRow href="/login" label="로그인 / 시작하기" sub="휴대폰 본인 인증 (1인 1계정)" />
            <MenuRow href="/leaderboard" label="리더보드 둘러보기" sub="로그인 없이도 볼 수 있어요" />
          </div>
        </main>
      </>
    );
  }

  const name = me.penName ?? me.email;
  const counts: Record<BuyerTab, number> = {
    all: me.purchases.length,
    active: me.active.length,
    done: me.done.length,
  };
  const shown =
    tab === "active" ? me.active : tab === "done" ? me.done : me.purchases;

  // 판매자 목록 필터 — 판매 중(게시·미판정) / 판정 완료 / 전체
  const authoredLive = me.authored.filter(
    (r) => r.status === "PUBLISHED" && !r.predictionCard?.judgment,
  );
  const authoredSettled = me.authored.filter((r) => r.predictionCard?.judgment);
  const sellerCounts: Record<SellerTab, number> = {
    all: me.authored.length,
    live: authoredLive.length,
    settled: authoredSettled.length,
  };
  const sellerShown =
    sellerTab === "live" ? authoredLive : sellerTab === "settled" ? authoredSettled : me.authored;

  return (
    <>
      <MyHeader mode={mode} cartCount={me.cartCount} />
      <main className={styles.page}>
      <div className={s.profile}>
        <div className={s.avatar} aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </div>
        <div className={s.profileMain}>
          <h1 className={s.profileName}>{name}</h1>
          <div className={s.profileMeta}>
            {me.researcherProfile && <TierChip tier={me.researcherProfile.tier} />}
            {me.identityVerified && <span className={styles.pill}>본인 인증</span>}
            {!me.researcherProfile && (
              <span className={styles.rowSub} style={{ marginTop: 0 }}>
                구매자 계정
              </span>
            )}
          </div>
        </div>
      </div>

      <div className={s.profileBtns}>
        {me.researcherId ? (
          <>
            <Link href={`/researcher/${me.researcherId}`} className={s.profileBtn}>
              내 리포트·정산
            </Link>
            <Link href={`/r/${me.researcherId}`} className={s.profileBtn}>
              공개 프로필
            </Link>
          </>
        ) : (
          <>
            <Link href="/researcher/start" className={s.profileBtn}>
              리서처로 시작하기
            </Link>
            {/* 앱 실행 화면(AppLaunch)은 루트 레이아웃에 있어 소프트 내비게이션으로는
                다시 마운트되지 않는다 → 전체 페이지 로드가 필요해 <a>를 의도적으로 쓴다 */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/?tour=1" className={s.profileBtn}>
              앱 사용 안내
            </a>
          </>
        )}
      </div>

      {mode === "buyer" ? (
        <>
          <div className={s.grid}>
            <Tile
              href="/purchases"
              icon={<EscrowIcon />}
              value={formatKrw(me.heldKrw)}
              label="에스크로 보관"
            />
            <Tile
              href="/purchases"
              icon={<RefundIcon />}
              value={formatKrw(me.refundedKrw)}
              label="누적 환불"
            />
            <Tile
              href="/my?mode=buyer&tab=done"
              icon={<HitRateIcon />}
              value={
                me.buyHitRate === null ? "—" : `${(me.buyHitRate * 100).toFixed(0)}%`
              }
              label="구매 적중률"
            />
            <Tile
              href="/notifications"
              icon={<BellIcon />}
              value={`${me.unreadCount}`}
              label="새 알림"
              dot={me.unreadCount > 0}
            />
            <Tile
              href={me.researcherId ? `/researcher/${me.researcherId}` : "/researcher/start"}
              icon={<PenIcon />}
              label={me.researcherId ? "내 리포트" : "리서처 되기"}
            />
            <Tile href="/terms" icon={<DocIcon />} label="약관·정책" />
          </div>

          <div className={s.stripTitle}>구매 내역</div>
          <div className={s.strip}>
            {BUYER_TABS.map((t) => (
              <Link
                key={t.key}
                href={`/my?mode=buyer&tab=${t.key}`}
                className={`${s.stripItem} ${t.key === tab ? s.stripActive : ""}`}
                aria-current={t.key === tab ? "true" : undefined}
              >
                <span className={s.stripValue}>{counts[t.key]}</span>
                <span className={s.stripLabel}>{t.label}</span>
              </Link>
            ))}
          </div>

          {shown.length === 0 ? (
            tab === "done" ? (
              <EmptyState
                compact
                title="아직 판정이 끝난 카드가 없어요"
                body="검증 시한이 도래하면 시장 데이터로 자동 판정되어 이곳에 쌓입니다."
              />
            ) : tab === "active" ? (
              <EmptyState
                compact
                title="검증을 기다리는 카드가 없어요"
                body="구매한 예측 카드는 판정 전까지 여기에서 검증 중으로 표시됩니다."
              />
            ) : (
              <EmptyState
                compact
                title="아직 구매한 예측 카드가 없어요"
                actionHref="/leaderboard"
                actionLabel="리더보드에서 리서처 살펴보기"
              />
            )
          ) : (
            <CollapsedList limit={3}>
              {shown.map((p) => (
                <PurchasedCard key={p.id} p={p} now={now} />
              ))}
            </CollapsedList>
          )}

          {/* 팔로잉 — 새 카드 알림을 받는 리서처들. 구매자 관점이라 '내 구매'에 둔다 */}
          <div className={s.stripTitle}>팔로잉 {me.following.length}</div>
          {me.following.length === 0 ? (
            <EmptyState
              compact
              title="아직 팔로우한 리서처가 없어요"
              body="팔로우하면 새 예측 카드가 올라올 때 알림을 받고, 리더보드에서 모아 볼 수 있어요."
              actionHref="/ranking"
              actionLabel="랭킹에서 리서처 찾기"
            />
          ) : (
            <CollapsedList limit={3}>
              {me.following.map((f) => (
                <Link key={f.researcherId} href={`/r/${f.researcherId}`} className={styles.row}>
                  <div className={styles.rowMain}>
                    <span className={styles.rowName}>
                      {f.name}
                      <TierChip tier={f.tier} />
                      {f.careerBadge && <span className={styles.pill}>인증</span>}
                    </span>
                    <span className={styles.rowSub}>{fmtDate(f.followedAt)}부터 팔로우</span>
                  </div>
                </Link>
              ))}
            </CollapsedList>
          )}
        </>
      ) : (
        <>
          {me.researcherId ? (
            <>
              <div className={s.grid}>
                <Tile
                  href={`/researcher/${me.researcherId}`}
                  icon={<EscrowIcon />}
                  value={formatKrw(me.seller.pendingKrw)}
                  label="정산 대기"
                />
                <Tile
                  href={`/researcher/${me.researcherId}`}
                  icon={<PayoutIcon />}
                  value={formatKrw(me.seller.payoutKrw)}
                  label="누적 정산액"
                />
                <Tile
                  href={`/r/${me.researcherId}`}
                  icon={<HitRateIcon />}
                  value={
                    me.seller.hitRate === null
                      ? "—"
                      : `${(me.seller.hitRate * 100).toFixed(0)}%`
                  }
                  label="내 적중률"
                />
                <Tile
                  href="/my?mode=seller&tab=live"
                  icon={<SlotIcon />}
                  value={`${me.seller.activeCount}/${me.seller.maxActive}`}
                  label="활성 카드"
                />
                <Tile
                  href="/leaderboard"
                  icon={<ScoreIcon />}
                  value={Math.round(me.seller.seasonScore).toLocaleString()}
                  label="시즌 점수"
                />
                <Tile
                  href={`/researcher/${me.researcherId}/new`}
                  icon={<PenIcon />}
                  label="새 리포트"
                />
              </div>

              <div className={s.stripTitle}>내가 작성한 카드</div>
              <div className={s.strip}>
                {SELLER_TABS.map((t) => (
                  <Link
                    key={t.key}
                    href={`/my?mode=seller&tab=${t.key}`}
                    className={`${s.stripItem} ${t.key === sellerTab ? s.stripActive : ""}`}
                    aria-current={t.key === sellerTab ? "true" : undefined}
                  >
                    <span className={s.stripValue}>{sellerCounts[t.key]}</span>
                    <span className={s.stripLabel}>{t.label}</span>
                  </Link>
                ))}
              </div>

              {sellerShown.length === 0 ? (
                sellerTab === "live" ? (
                  <EmptyState
                    compact
                    title="판매 중인 카드가 없어요"
                    actionHref={`/researcher/${me.researcherId}/new`}
                    actionLabel="새 리포트 쓰기"
                  />
                ) : sellerTab === "settled" ? (
                  <EmptyState
                    compact
                    title="아직 판정이 끝난 카드가 없어요"
                    body="게시한 카드가 검증 시한에 도달하면 자동 판정됩니다."
                  />
                ) : (
                  <EmptyState
                    compact
                    title="아직 작성한 예측 카드가 없어요"
                    actionHref={`/researcher/${me.researcherId}/new`}
                    actionLabel="첫 리포트 쓰기"
                  />
                )
              ) : (
                sellerShown.map((r) => <AuthoredCard key={r.id} r={r} now={now} />)
              )}

              {/* 팔로워 — 내 새 카드 알림을 받는 사람들. 리서처에게만 존재한다 */}
              <div className={s.stripTitle}>팔로워 {me.followers.length}</div>
              {me.followers.length === 0 ? (
                <EmptyState
                  compact
                  title="아직 팔로워가 없어요"
                  body="카드를 꾸준히 게시하면 팔로워가 쌓이고, 새 카드마다 알림이 전해집니다."
                />
              ) : (
                <CollapsedList limit={3}>
                  {me.followers.map((f, i) => (
                    <div key={i} className={styles.row}>
                      <div className={styles.rowMain}>
                        <span className={styles.rowName}>{f.name}</span>
                        <span className={styles.rowSub}>{fmtDate(f.followedAt)}부터 팔로우</span>
                      </div>
                    </div>
                  ))}
                </CollapsedList>
              )}
            </>
          ) : (
            <>
              <div className={s.banner}>
                <span className={s.bannerText}>
                  리서처로 전환하면 예측 카드를 붙여 리포트를 판매할 수 있어요.
                </span>
                <Link href="/researcher/start" className={s.bannerGo}>
                  전환 →
                </Link>
              </div>
              <p className={styles.sub}>
                아직 리서처가 아닙니다. 전환하면 이 화면에서 작성한 카드와 판정·정산 현황을
                볼 수 있습니다.
              </p>
            </>
          )}
        </>
      )}

      {/* 운영자 메뉴·약관·로그아웃은 헤더 좌측 톱니바퀴(/settings)로 옮겼다 */}
      </main>
    </>
  );
}
