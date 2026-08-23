import Link from "next/link";
import { prisma } from "@/server/db";
import { AdminIcon } from "./AdminIcons";
import styles from "./admin.module.css";

// 관리 화면의 머리 — 제목(+부제) 왼쪽, **확성기 오른쪽**.
//
// 확성기가 여섯 번째 탭이 아닌 이유: 아래 탭 다섯은 **재료**로 갈린 큐인데
// (글·돈·이력·기계), 문의와 공지는 재료가 아니라 **방향**이다 — 사람이 나에게 온 말,
// 내가 사람에게 갈 말. 다른 축을 탭 줄에 끼우면 두 기준이 섞인다.
// 그래서 모든 화면의 **같은 자리**에 둔다: 어느 큐를 보다가도 말은 걸 수 있어야 하고,
// 자리가 매번 같아야 찾지 않아도 손이 간다.

export async function AdminHead({
  title,
  sub,
  backHref,
  inbox: given,
}: {
  title: string;
  sub?: string;
  /** 하위 화면에서만 — 최상위 5화면은 탭바가 이동을 맡는다 */
  backHref?: string;
  /**
   * 답을 기다리는 이용자 문의 수. **생략하면 스스로 센다.**
   * 화면마다 배선하면 화면마다 낡고, 낡는 순간 같은 확성기가 화면마다 다른 숫자를
   * 말한다 — 그 불일치는 "어느 쪽이 맞나"를 매번 되묻게 만든다.
   * 이미 큐 집계를 부른 화면은 그 값을 넘겨 질의 한 번을 아낀다.
   */
  inbox?: number;
}) {
  const inbox = given ?? (await prisma.supportTicket.count({ where: { status: "OPEN" } }));

  return (
    <div className={styles.apphead}>
      <div className={styles.headLeft}>
        {backHref && (
          <Link href={backHref} className={styles.back} aria-label="돌아가기">
            ‹
          </Link>
        )}
        <div>
          <h1>{title}</h1>
          {sub && <div className={styles.sub}>{sub}</div>}
        </div>
      </div>
      <Link
        href="/admin/inbox"
        className={styles.ahbtn}
        aria-label={`소통 열기 — 답을 기다리는 문의 ${inbox}건`}
      >
        {/* 배지는 **기다리는 사람 수**만 센다 — 안 보낸 공지는 밀린 일이 아니다 */}
        {inbox > 0 && <span className={styles.ahbtnCount}>{inbox}</span>}
        {AdminIcon.announce}
      </Link>
    </div>
  );
}
