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
// 뭘 냈나"다. 그래서 프로필·소개말을 머리로 세우고 그 사람의 카드를 아래 붙였다
// (언론사 채널 구독 화면의 구성).
//
// 소개말은 리서처가 자기를 파는 유일한 자유 서술 공간이다. 다만 구매 전 마스킹을
// 우회하는 통로가 될 수 있어(종목명 한 줄이면 무력화) 저장 단계에서 검증한다 —
// domain/researcherBio.ts.

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
      {sections.map((s) => (
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
          {/* 프로필 머리 — 누르면 공개 프로필로 */}
          <Link href={`/r/${s.researcherId}`} className={styles.prHead}>
            <span className={styles.prAvatar}>
              <DefaultAvatar className={styles.prAvatarImg} />
            </span>
            <span className={styles.prMain}>
              <span className={styles.prNameRow}>
                <span className={styles.prName}>{s.researcherName}</span>
                {s.careerBadge && <VerifiedBadge />}
                <TierChip tier={s.tier} />
                {/* 고정은 본인이 정한 순서라는 사실이라 말로 적는다 — 무게만으로는
                    "왜 이 사람이 맨 위인가"가 설명되지 않는다 */}
                {s.pinned && <span className={styles.prPinned}>고정</span>}
              </span>
              <span className={styles.prMeta}>
                팔로워 <strong>{s.followers.toLocaleString()}</strong>
                <span className={styles.prDot} />
                적중률 <strong>{pct(s.cards[0].hitRate)}</strong>
                <span className={styles.prDot} />
                판매 중 <strong>{s.cards.length}</strong>장
              </span>
            </span>
          </Link>

          {/* 소개말 — 없으면 줄 자체를 그리지 않는다 (빈 따옴표는 없느니만 못하다) */}
          {s.bio && <p className={styles.prBio}>{s.bio}</p>}

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
        </section>
      ))}
    </>
  );
}
