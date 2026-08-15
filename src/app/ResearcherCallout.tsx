import Link from "next/link";
import { showsHitRate, hitRateLabel } from "@/domain/trackRecord";
import type { ResearcherCallout as Data } from "@/server/marketQueries";
import { DefaultAvatar } from "./Avatar";
import { VerifiedBadge } from "./brand/VerifiedBadge";
import { TierChip } from "./TierChip";
import styles from "./researcherCallout.module.css";

// 리서처 명함 — 무료 시황 본문 끝에 붙는 전환 지점.
//
// 유료 리포트는 구매 전 마스킹 때문에 본문을 볼 수 없다. 무료 시황은 그 예외라 전문이
// 공개되는데, 다 읽고 나면 "이 사람이 파는 건 뭐지"로 이어질 길이 없었다.
// 글을 끝까지 읽은 직후가 이 서비스에서 신뢰가 가장 높은 순간이라, 전환은 여기서 일어난다.
//
// 실적이 없는 신규 리서처에게 특히 중요하다 — 적중률 칸이 비어 있어도 글은 남기 때문에,
// 무료 시황이 트랙레코드를 대신하는 유일한 증명 수단이 된다.
// 그래서 판정 이력이 없을 때도 명함을 감추지 않고 "판정 전"이라고 정직하게 적는다.

export function ResearcherCallout({ data }: { data: Data }) {
  if (data.sellingCount === 0) return null;

  return (
    <Link href={`/r/${data.researcherId}`} className={styles.callout}>
      <span className={styles.avatar}>
        <DefaultAvatar className={styles.avatarImg} />
      </span>

      <span className={styles.main}>
        <span className={styles.nameRow}>
          <span className={styles.name}>{data.researcherName}</span>
          {data.careerBadge && <VerifiedBadge />}
          <TierChip tier={data.tier} />
        </span>

        <span className={styles.record}>
          {!showsHitRate(data.hitRate, data.judgedCount) ? (
            hitRateLabel(data.hitRate, data.judgedCount, { none: "아직 판정된 예측이 없어요" })
          ) : (
            <>
              적중 <strong>{hitRateLabel(data.hitRate, data.judgedCount, { digits: 0 })}</strong>
              <span className={styles.sample}>{data.judgedCount}건</span>
            </>
          )}
        </span>

        {data.bio && <span className={styles.bio}>{data.bio}</span>}

        <span className={styles.cta}>
          판매 중인 예측 카드 <strong>{data.sellingCount}장</strong> 보기
          <span aria-hidden="true"> →</span>
        </span>
      </span>
    </Link>
  );
}
