import Link from "next/link";
import type { FollowedSection } from "@/server/marketQueries";
import { DefaultAvatar } from "../Avatar";
import { VerifiedBadge } from "../brand/VerifiedBadge";
import { MaskedCard } from "../MaskedCard";
import { TierChip } from "../TierChip";
import { PinButton } from "./PinButton";
import styles from "./leaderboard.module.css";

// 팔로우한 리서처 — 카드가 아니라 **사람**이 단위인 블록.
//
// 카드를 한 줄로 섞으면 "무슨 카드가 있나"만 남는데, 팔로우의 관심사는 "이 사람이
// 뭘 냈나"다. 그래서 프로필·소개말을 머리로 세우고 그 사람의 카드를 아래 붙였다.
//
// ── 구성 (2026-08-09 재설계) ──────────────────────────────
// 블록이 답해야 하는 질문은 하나다: **이 사람 카드를 열어볼까?**
// 그 판단에 필요한 순서대로 세 층으로 나눴다.
//
//   ① 누구인가   — 아바타 + 이름 + 인증 + 등급, 그 바로 아래 소개말
//        소개말을 이름 바로 밑에 붙인 이유: 전에는 실적 줄 아래에 있어서
//        "이 사람이 누구인가"를 두 번에 나눠 읽어야 했다. 이름과 목소리는 한 덩어리다
//   ② 믿을 만한가 — 적중률·표본·팔로워. 숫자를 굵게, 없으면 "판정 전"이라고 정직하게
//   ③ 무엇이 있나 — 판매 중 N장 / 무료 글 N편, 그 아래 카드 레일
//        **무료 글로 가는 길이 여기 생긴다.** 유료 카드는 구매 전 본문을 볼 수 없어서
//        글로 판단하려면 무료 시황뿐이고, 실적이 없는 리서처일수록 그게 결정적이다
//
// 바탕은 위(사람)가 흰색, 아래(물건)가 회색이다. 작은 글자가 많은 사람 정보는 흰 바탕에서
// 읽기 쉽고, 흰 카드는 회색 위에서 뜬다 — 같은 색을 두 번 쓰지 않는다.

function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

export function FollowedSections({
  sections,
  now,
}: {
  sections: FollowedSection[];
  now: Date;
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
            {/* 고정 버튼은 머리 링크의 형제다 — 링크 안에 링크·버튼을 넣을 수 없다 */}
            <PinButton
              researcherId={s.researcherId}
              pinned={s.pinned}
              name={s.researcherName}
            />

            {/* ① 누구인가 — 이름과 소개말이 한 덩어리 */}
            <Link href={`/r/${s.researcherId}`} className={styles.prWho}>
              <span className={styles.prAvatar}>
                <DefaultAvatar className={styles.prAvatarImg} />
              </span>
              <span className={styles.prWhoText}>
                <span className={styles.prNameRow}>
                  <span className={styles.prName}>{s.researcherName}</span>
                  {s.careerBadge && <VerifiedBadge />}
                  <TierChip tier={s.tier} />
                  {/* 고정은 본인이 정한 순서라는 사실이라 말로 적는다 —
                      무게만으로는 "왜 이 사람이 맨 위인가"가 설명되지 않는다 */}
                  {s.pinned && <span className={styles.prPinned}>고정</span>}
                </span>
                {s.bio ? (
                  <span className={styles.prBio}>{s.bio}</span>
                ) : (
                  <span className={styles.prBioNone}>소개말이 아직 없어요</span>
                )}
              </span>
            </Link>

            {/* ② 믿을 만한가 — 숫자를 앞세운다 */}
            <div className={styles.prRecord}>
              {head.hitRate === null ? (
                <span className={styles.prRecordNone}>아직 판정된 예측이 없어요</span>
              ) : (
                <span className={styles.prStat}>
                  적중 <strong>{pct(head.hitRate)}</strong>
                  <span className={styles.prSample}>{head.judgedCount}건</span>
                </span>
              )}
              <span className={styles.prStat}>
                팔로워 <strong>{s.followers.toLocaleString()}</strong>
              </span>
            </div>

            {/* ③ 무엇이 있나 — 재고 요약 + 무료 글로 가는 길 */}
            <div className={styles.prShelf}>
              <div className={styles.prShelfHead}>
                <span className={styles.prShelfCount}>판매 중 {s.cards.length}장</span>
                {s.freeCount > 0 && (
                  <Link href={`/free?r=${s.researcherId}`} className={styles.prFreeLink}>
                    무료 글 {s.freeCount}편 →
                  </Link>
                )}
              </div>
              <div className={styles.prRail}>
                {s.cards.map((c) => (
                  <MaskedCard
                    key={c.reportId}
                    c={c}
                    now={now}
                    href={`/report/${c.reportId}`}
                    compact
                  />
                ))}
              </div>
            </div>
          </section>
        );
      })}
    </>
  );
}
