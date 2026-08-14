import { PrismaClient } from '@prisma/client';
import { JudgmentRevertBlocked, revertJudgment } from '../src/server/judgmentRevertService';

// 판정 되돌리기:
//   npm run judgment:revert -- <judgmentId> <운영자 이메일> "사유" --source   (시세 소스 오류)
//   npm run judgment:revert -- <judgmentId> <운영자 이메일> "사유" --logic    (판정 로직 버그)
//   npm run judgment:revert -- --card <predictionCardId>   (그 카드의 판정 id 찾기)
//
// **사유 갈래가 필수인 이유**: 되돌리기만 하고 자동 배치에 다시 던지면, 원인이 시세
// 소스였을 때 같은 소스로 같은 오답이 나온다 — 사람이 또 되돌리는 무한 반복이 된다.
//   --source: 자동 판정을 막고 운영자 판정 큐로 보낸다 (사람이 시세를 직접 넣는다)
//   --logic:  자동 배치가 다시 매긴다 — **코드를 먼저 고친 뒤** 되돌릴 것
//
// **UI를 만들지 않는 이유**: 이 일은 자주 일어나면 안 되고, 자주 일어나지 않는 일에
// 화면을 붙이면 화면이 먼저 낡는다. 대신 안전장치는 함수 안에 있다 — 돈이 이미
// 밖으로 나갔으면(리서처 지급·구매자 환불 실행) 거부하고 회계 처리로 넘긴다.

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--card') {
    const cardId = args[1];
    if (!cardId) {
      console.error('사용법: npm run judgment:revert -- --card <predictionCardId>');
      process.exitCode = 1;
      return;
    }
    const j = await prisma.judgment.findUnique({
      where: { predictionCardId: cardId },
      select: { id: true, outcome: true, score: true, judgedAt: true, dataSource: true },
    });
    if (!j) {
      console.log('이 카드에는 판정이 없습니다.');
      return;
    }
    console.log(
      `${j.id}  ${j.outcome}  ${j.score ?? '—'}점  ${j.judgedAt.toISOString()}  (${j.dataSource ?? '—'})`,
    );
    return;
  }

  const [judgmentId, operatorEmail, reason] = args.filter((a) => !a.startsWith('--'));
  const source = args.includes('--source');
  const logic = args.includes('--logic');
  if (!judgmentId || !operatorEmail || !reason || source === logic) {
    console.error(
      '사용법: npm run judgment:revert -- <judgmentId> <운영자 이메일> "사유" (--source | --logic)',
    );
    console.error('        npm run judgment:revert -- --card <predictionCardId>');
    console.error('\n사유는 필수입니다 — JudgmentRevert에 영구 기록됩니다.');
    console.error('갈래도 필수입니다 — 무엇이 틀렸는지에 따라 재판정 주체가 갈립니다:');
    console.error('  --source  시세 소스 오류 → 자동 판정을 막고 운영자 큐로 (같은 소스는 같은 답을 낸다)');
    console.error('  --logic   판정 로직 버그 → 자동 배치가 재판정 (코드를 먼저 고칠 것)');
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
    const r = await revertJudgment(prisma, {
      judgmentId,
      operatorUserId: operator.id,
      reason,
      cause: source ? 'DATA_SOURCE' : 'PLATFORM_LOGIC',
    });
    console.log(`판정 취소 완료 — ${r.outcome} / ${Math.round(r.score ?? 0)}점 회수`);
    console.log(`  정산 ${r.settlements}건 삭제, 에스크로 HELD로 복귀`);
    console.log(`  카드 ${r.predictionCardId}`);
    for (const f of r.followUps) console.log(`  ⚠ ${f}`);
  } catch (e) {
    if (e instanceof JudgmentRevertBlocked) {
      console.error(`되돌릴 수 없습니다 [${e.code}]\n${e.message}`);
      process.exitCode = 1;
      return;
    }
    throw e;
  }
}

main().finally(() => prisma.$disconnect());
