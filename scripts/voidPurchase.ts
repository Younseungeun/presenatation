import { PrismaClient } from '@prisma/client';
import {
  markDisputed,
  PurchaseVoidError,
  resolveDispute,
  retryCsRefund,
  voidPurchase,
} from '../src/server/purchaseVoidService';
import { VelocityLimitExceeded } from '../src/server/payoutVelocity';
import { SettlementOpsError } from '../src/server/settlementOpsService';

// CS 도구 — **런칭 첫날부터 있어야 하는 것.**
//   npm run cs:void      -- <purchaseId> <운영자 이메일> "사유"      구매 무효화 + 전액 환불
//   npm run cs:void      -- --find <구매자 이메일>                    그 사람의 구매 목록
//   npm run cs:void      -- --dispute <purchaseId>                    차지백 접수 표시(지급 보류)
//   npm run cs:void      -- --resolve <purchaseId> won|lost           분쟁 확정
//
// "결제했는데 안 보여요", "실수로 두 번 눌렀어요"는 오픈 한 시간 만에 들어온다.
// 그때 psql로 DB만 고치고 토스 콘솔에서 따로 취소하면 **장부가 갈라진다** —
// 우리 쪽에는 환불 기록이 없고 PG에는 있어서 대조 배치가 매일 경보를 울리게 된다.

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--find') {
    const email = args[1];
    if (!email) {
      console.error('사용법: npm run cs:void -- --find <구매자 이메일>');
      process.exitCode = 1;
      return;
    }
    const rows = await prisma.purchase.findMany({
      where: { buyer: { email } },
      include: { report: { select: { title: true } } },
      orderBy: { paidAt: 'desc' },
      take: 20,
    });
    if (rows.length === 0) {
      console.log('구매 내역이 없습니다.');
      return;
    }
    for (const p of rows) {
      console.log(
        `${p.id}  ${p.escrowStatus.padEnd(9)} ${p.amountKrw.toLocaleString().padStart(9)}원  ` +
          `${p.paidAt.toISOString().slice(0, 16)}  ${p.report.title}` +
          `${p.paymentKey ? '' : '  [결제키 없음 — PG 취소 불가]'}`,
      );
    }
    return;
  }

  if (args[0] === '--retry') {
    const attemptId = args[1];
    if (!attemptId) {
      console.error('사용법: npm run cs:void -- --retry <시도 id>');
      process.exitCode = 1;
      return;
    }
    await retryCsRefund(prisma, attemptId);
    console.log('재시도 완료 — 같은 멱등키로 나갔으므로 두 번 빠지지 않습니다.');
    return;
  }

  if (args[0] === '--dispute') {
    const purchaseId = args[1];
    if (!purchaseId) {
      console.error('사용법: npm run cs:void -- --dispute <purchaseId>');
      process.exitCode = 1;
      return;
    }
    await markDisputed(prisma, purchaseId);
    console.log('분쟁 표시 완료 — 이 구매만 정산에서 빠집니다 (카드 판정과 다른 구매는 그대로).');
    console.log('  리서처에게 "해당 건 지급 보류" 알림이 나갔습니다.');
    console.log('  PG 대시보드에서 결과가 나오면: npm run cs:void -- --resolve <id> won|lost');
    return;
  }

  if (args[0] === '--resolve') {
    const [purchaseId, verdict] = args.slice(1);
    if (!purchaseId || (verdict !== 'won' && verdict !== 'lost')) {
      console.error('사용법: npm run cs:void -- --resolve <purchaseId> won|lost');
      console.error('  won  = 플랫폼 승 (돈이 남는다) → 에스크로 복귀');
      console.error('  lost = 구매자 승 (돈이 나갔다) → 구매 취소');
      process.exitCode = 1;
      return;
    }
    const op = await prisma.user.findFirst({ where: { role: 'OPERATOR' } });
    const r = await resolveDispute(prisma, {
      purchaseId,
      resolution: verdict === 'won' ? 'WON' : 'LOST',
      operatorUserId: op?.id ?? 'unknown',
    });
    console.log(`분쟁 확정: ${verdict.toUpperCase()}`);
    if (r.settlementNeeded) {
      console.log(
        '  ⚠ 이 카드는 **이미 판정됐습니다.** 판정 배치는 다시 돌지 않으므로 이 구매의 정산이 비어 있습니다.\n' +
          '    /admin/settlements 에서 수동으로 정산해야 리서처 몫이 나갑니다 — 두면 그 돈은 사라집니다.',
      );
    }
    return;
  }

  const [purchaseId, operatorEmail, reason] = args;
  if (!purchaseId || !operatorEmail || !reason) {
    console.error('사용법: npm run cs:void -- <purchaseId> <운영자 이메일> "사유"');
    console.error('        npm run cs:void -- --find <구매자 이메일>');
    console.error('        npm run cs:void -- --retry <시도 id>        (응답 못 받은 취소 이어받기)');
    console.error('        npm run cs:void -- --dispute <purchaseId>');
    console.error('        npm run cs:void -- --resolve <purchaseId> won|lost');
    console.error('\n사유는 토스 콘솔과 구매자 카드 명세서에 그대로 남습니다.');
    process.exitCode = 1;
    return;
  }

  const operator = await prisma.user.findUnique({ where: { email: operatorEmail } });
  if (!operator || operator.role !== 'OPERATOR') {
    console.error(`운영자 계정이 아닙니다: ${operatorEmail} (npm run op:grant로 부여)`);
    process.exitCode = 1;
    return;
  }

  try {
    const r = await voidPurchase(prisma, {
      purchaseId,
      operatorUserId: operator.id,
      reason,
    });
    console.log(`구매 무효화 완료 — ${r.amountKrw.toLocaleString()}원 전액 취소 (시도 ${r.attemptId})`);
    console.log('  구매자에게 알림이 나갔고, 해당 리포트 열람은 즉시 닫혔습니다.');
    console.log('  ⚠ 같은 사람이 이 리포트를 다시 살 수는 없습니다 — 의도된 동작입니다');
    console.log('    (구매 → 열람 → 무효화 → 재구매의 공짜 열람 고리를 막습니다).');
  } catch (e) {
    if (e instanceof PurchaseVoidError) {
      console.error(`무효화할 수 없습니다 [${e.code}]\n${e.message}`);
      process.exitCode = 1;
      return;
    }
    // **PG 취소가 실패한 경우도 사람이 읽을 수 있어야 한다.** cancelViaPg가 던지는
    // SettlementOpsError에는 "다시 시도하라"인지 "응답을 못 받았으니 이어받으라"인지가
    // 이미 적혀 있다 — 그걸 스택 트레이스로 내보내면 CS 도구인 의미가 없다
    if (e instanceof SettlementOpsError) {
      console.error(`PG 취소가 끝나지 않았습니다\n${e.message}`);
      console.error('\n  이어받기: npm run cs:void -- --retry <시도 id>');
      console.error('  (구매 상태는 그대로입니다 — 취소가 확정될 때까지 열람도 닫히지 않습니다)');
      process.exitCode = 1;
      return;
    }
    // 일일 출금 한도에 막힌 경우 (2026-08-18 CS 무효화도 한도를 지나게 되면서 생겼다).
    // 위 둘과 같은 이유로 스택 트레이스로 내보내지 않는다 — 메시지에 "얼마 남았는지"와
    // "먼저 감사 로그를 보라"가 이미 적혀 있다
    if (e instanceof VelocityLimitExceeded) {
      console.error(`일일 출금 한도에 막혔습니다\n${e.message}`);
      console.error('\n  아무것도 나가지 않았고 구매도 그대로입니다 — 내일 다시 실행하면 됩니다.');
      console.error('  급하면 한도를 올려야 하는데, 그건 화면이 아니라 배포로만 바뀝니다');
      console.error('  (DAILY_OUTFLOW_LIMIT_KRW — 탈취된 세션이 벽을 스스로 올리지 못하게).');
      process.exitCode = 1;
      return;
    }
    throw e;
  }
}

main().finally(() => prisma.$disconnect());
