// 진짜 알림 한 방 — **실제 경로를 그대로 지난다.**
//
// 알림 행을 만들고 스윕을 부른다. 지름길을 내지 않는 이유: 지름길로 성공하면
// 정작 운영에서 쓰는 길이 되는지는 여전히 모른다. 여기서 뜨면 판정·환불 알림도 뜬다.
//
// 실행: npm run push:test              (가장 최근에 알림을 켠 사람에게)
//       npm run push:test -- 계좌변경   (보안 알림 문구로)
import { PrismaClient } from '@prisma/client';
import { pushCopyFor } from '../src/domain/pushCopy';
import { flushPendingPush } from '../src/server/pushService';

const prisma = new PrismaClient();

// 종류를 골라 보내면 **문구 규칙이 실제로 도는지**까지 함께 확인된다
const TYPE = process.argv[2] === '계좌변경' ? 'PAYOUT_ACCOUNT_CHANGED' : 'JUDGMENT_RESULT';

async function main() {
  const sub = await prisma.pushSubscription.findFirst({ orderBy: { lastSeenAt: 'desc' } });
  if (!sub) {
    console.log('\n✖ 알림을 켠 기기가 아직 없습니다.');
    console.log('  폰에서 설정 → 알림 → "이 기기 알림 켜기"를 먼저 눌러 주세요.\n');
    return;
  }
  const copy = pushCopyFor(TYPE);
  console.log(`\n대상: ${sub.platform} · ${sub.label?.slice(0, 40) ?? '이름 없음'}`);
  console.log(`보낼 문구: "${copy.title}" / "${copy.body}"${copy.urgent ? ' (급함)' : ''}`);

  // 알림함에는 **금액이 들어간 진짜 본문**이 들어간다 — 푸시에는 안 나가는 것을 눈으로 보려고
  await prisma.notification.create({
    data: {
      userId: sub.userId,
      type: TYPE,
      title: '테스트 알림',
      body: '코카콜라 상승 카드 12,900원이 환불되었습니다 (이 문장은 앱 안에서만 보입니다)',
      link: '/my/notifications',
    },
  });

  const r = await flushPendingPush(prisma);
  console.log(
    `\n결과: 시도 ${r.attempted} · 배달 ${r.delivered} · 기기없음 ${r.noDevice} · 정리 ${r.pruned}`,
  );
  if (r.delivered > 0) console.log('✔ 폰을 보세요.\n');
  else if (r.attempted > 0) console.log('✖ 배달 실패 — 구독이 만료됐을 수 있습니다. 다시 켜 보세요.\n');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
