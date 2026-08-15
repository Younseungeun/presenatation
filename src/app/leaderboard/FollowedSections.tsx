import Link from "next/link";
import { showsHitRate, hitRateLabel } from "@/domain/trackRecord";
import type { FollowedCardSort, FollowedSection } from "@/server/marketQueries";
import type { OwnedCardView } from "@/server/ownedCardViews";
import { OwnedCard } from "../OwnedCard";
import { DefaultAvatar } from "../Avatar";
import { CareerBadge } from "../brand/CareerBadge";
import { MaskedCard } from "../MaskedCard";
import { TierChip } from "../TierChip";
import { FollowedSortPicker } from "./FollowedSortPicker";
import { PinButton } from "./PinButton";
import { SpineRail } from "./SpineRail";
import styles from "./leaderboard.module.css";

// 팔로우한 리서처 — 카드가 아니라 **사람**이 단위인 블록.
//
// 카드를 한 줄로 섞으면 "무슨 카드가 있나"만 남는데, 팔로우의 관심사는 "이 사람이
// 뭘 냈나"다. 그래서 사람을 머리로 세우고 그 사람의 카드를 아래 붙였다.
//
// ── 구성 (2026-08-09 개편: 겉상자 제거) ─────────────────────
//   ① 프로필 박스 — 좌: 아바타 + 적중률·표본 / 우: 이름·배지 + 소개말
//        소개말의 첫 글자가 이름의 첫 글자와 같은 선에 선다. 둘은 한 사람의 두 마디라
//        들쭉날쭉하면 서로 다른 정보처럼 읽힌다
//   ② 선반 — 판매 중 N장 · 정렬 ▾ / 무료 글 N편 → , 그 아래 카드 레일(맨바탕) + 스파인
//        정렬 버튼이 여기 있는 이유: 바꾸는 자리는 결과가 보이는 자리여야 한다.
//        섹션 제목까지 올라가면 카드에서 눈을 떼야 하고, 바꾼 결과는 다시 내려와야 보인다
//
// 겉을 감싸던 회색 컨테이너는 없앴다 — 회색 상자 → 흰 프로필 상자 → 흰 카드로
// "담겨 있다"가 세 번 반복될 뿐 새 정보가 없었다. 그린 상자는 프로필과 카드,
// 실제로 누르는 것들만 남는다. 묶음은 상자 대신 여백과 **스파인**(레일 밑 잉크 한 획,
// SpineRail)이 말한다 — 스파인은 가로 스크롤의 진행 표시까지 겸한다.
//
// **팔로워 수는 싣지 않는다.** 이 서비스의 평판은 판정된 트랙레코드로만 쌓이는데
// (기획 §2 "팔로워 수가 아닌 실적"), 팔로워 수를 나란히 놓으면 그 원칙이 흐려지고
// 먼저 온 사람이 계속 유리해진다.
//
// 배지 배치는 브랜드 규정(§4-4)을 따른다: **이름 옆은 인증 배지만.**
// 등급 칩은 로제트가 아니라 텍스트 필이라, 같은 자리에 두면 두 신뢰 신호가 섞인다 —
// 그래서 박스 오른쪽 위로 뺐다.

export function FollowedSections({
  sections,
  now,
  showPin = true,
  ownedViews,
  sort,
  sortHrefs,
}: {
  sections: FollowedSection[];
  now: Date;
  /** 고정 버튼 노출 — 리더보드는 한 명만 보여주므로 고정할 이유가 없다 */
  showPin?: boolean;
  /** 이미 산 카드의 공개 뷰 — 있으면 구성이 다른 카드(OwnedCard)로 그린다 */
  ownedViews?: Map<string, OwnedCardView>;
  /**
   * 레일 카드 정렬 — 선반 머리("판매 중 N장" 옆)에서 바꾼다.
   * **레일마다 붙는다.** 값은 전 레일 공통이라 화면당 한 번만 두는 편이 짧지만,
   * 그러면 정렬을 바꾸려고 카드에서 눈을 떼고 섹션 제목까지 올라가야 한다 —
   * 순서를 바꾸는 자리는 순서가 보이는 자리여야 한다.
   * hrefs가 함수가 아니라 값인 이유는 FollowedSortPicker 주석 참고
   */
  sort?: FollowedCardSort;
  sortHrefs?: Record<FollowedCardSort, string>;
}) {
  return (
    <>
      {sections.map((s) => {
        const head = s.cards[0];
        return (
          <section
            key={s.researcherId}
            className={`${styles.prBlock} ${s.pinned ? styles.prBlockPinned : ""}`}
          >
            {/* ① 프로필 박스 */}
            <div className={styles.prCardWrap}>
              {showPin && (
                <PinButton
                  researcherId={s.researcherId}
                  pinned={s.pinned}
                  name={s.researcherName}
                />
              )}

              <Link href={`/r/${s.researcherId}`} className={styles.prCard}>
                <span className={styles.prCardLeft}>
                  <span className={styles.prAvatar}>
                    <DefaultAvatar className={styles.prAvatarImg} />
                  </span>
                  {/* 적중률은 표본과 함께 읽어야 뜻이 산다 — 100%(1건)과 62%(47건)은 다른 이야기다 */}
                  {!showsHitRate(head.hitRate, head.judgedCount) ? (
                    <span className={styles.prNoRecord}>
                      {hitRateLabel(head.hitRate, head.judgedCount)}
                    </span>
                  ) : (
                    <>
                      <span className={styles.prHit}>
                        적중 {hitRateLabel(head.hitRate, head.judgedCount, { digits: 0 })}
                      </span>
                      <span className={styles.prSample}>{head.judgedCount}건</span>
                    </>
                  )}
                </span>

                <span className={styles.prCardRight}>
                  <span className={styles.prNameRow}>
                    <span className={styles.prName}>{s.researcherName}</span>
                    <CareerBadge careerBadge={s.careerBadge} />
                  </span>
                  {s.bio ? (
                    <span className={styles.prBio}>{s.bio}</span>
                  ) : (
                    <span className={styles.prBioNone}>소개말이 아직 없어요</span>
                  )}
                </span>

                {/* 등급 칩은 이름 옆이 아니라 박스 우측 (브랜드 §4-4 배치 규칙) */}
                <span className={`${styles.prTier} ${showPin ? styles.prTierShifted : ""}`}>
                  <TierChip tier={s.tier} />
                  {s.pinned && <span className={styles.prPinned}>고정</span>}
                </span>
              </Link>
            </div>

            {/* ② 선반 — 무엇이 있나 */}
            <div className={styles.prShelf}>
              <div className={styles.prShelfHead}>
                <span className={styles.prShelfLead}>
                  <span className={styles.prShelfCount}>판매 중 {s.cards.length}장</span>
                  {/* 카드가 한 장뿐인 레일에서는 정렬이 아무 일도 하지 않으므로 그리지 않는다.
                      단 **기본값이 아닐 때는 항상 그린다** — 기본이 아닌 상태에서 버튼이
                      사라지면 되돌릴 길이 없어진다(hideOwned 칩과 같은 규칙) */}
                  {sort && sortHrefs && (s.cards.length > 1 || sort !== "NEW") && (
                    <>
                      <span className={styles.prShelfDot} aria-hidden="true">
                        ·
                      </span>
                      <FollowedSortPicker sort={sort} hrefs={sortHrefs} />
                    </>
                  )}
                </span>
                {s.freeCount > 0 && (
                  <Link href={`/free?r=${s.researcherId}`} className={styles.prFreeLink}>
                    무료 글 {s.freeCount}편 →
                  </Link>
                )}
              </div>
              <SpineRail>
                {s.cards.map((c) => {
                  const mine = ownedViews?.get(c.reportId);
                  return mine ? (
                    <OwnedCard key={c.reportId} v={mine} now={now} compact />
                  ) : (
                    <MaskedCard
                      key={c.reportId}
                      c={c}
                      now={now}
                      href={`/report/${c.reportId}`}
                      compact
                    />
                  );
                })}
              </SpineRail>
            </div>
          </section>
        );
      })}
    </>
  );
}
