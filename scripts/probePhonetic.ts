import { prisma } from '../src/server/db';
import { findPhoneticEvasion } from '../src/domain/phoneticEvasion';

// 자모 편집거리가 음성 변형과 정상 한국어를 가르는가 (16차).
const EVASION = [
  '텔레그렘 으로 오세요', '텔렛그램 방 초대', '카카오툭 아이디 드립니다',
  '원금보쟝 해드립니다', '손실 0% 보쟝', '개인 쳇주세요', '리딩빵 운영중',
  '단톡빵 초대합니다', '수익보쟝 드립니다', '텔레 그렘 으로', '카톢 주세요',
];
const NORMAL = [
  '삼성전자 3분기 실적 발표를 앞두고 있습니다',
  '카카오뱅크와 카카오페이의 실적을 비교합니다',
  '오픈뱅킹 확대가 은행권에 미치는 영향',
  '리딩기업으로 자리잡은 반도체 소재주입니다',
  '원금손실 가능성을 반드시 확인하십시오',
  '수익구조 개선이 뚜렷하게 나타났습니다',
  '손실흡수능력이 개선되어 건전성이 좋아졌습니다',
  '텔레비전 판매가 회복세로 돌아섰습니다',
  '단기조정 이후 방향성을 다시 보겠습니다',
  '개인투자자 비중이 늘어난 점에 주목합니다',
  '그램당 단가가 하락했습니다',
  '상담역으로 영입된 인사가 있습니다',
  '기관투자자 수급이 개선되었습니다',
  '확정급여형 퇴직연금 시장이 커지고 있습니다',
  '원가절감 효과가 하반기에 반영됩니다',
  '카드사 수수료 인하가 부담입니다',
  '전기차 배터리 수요가 견조합니다',
  '톡톡한 재미를 본 투자자가 많습니다',
  '과거 수익률이 미래 수익을 보장하지 않습니다',
  '원금이 보장되지 않는 상품이므로 유의하십시오',
  '보장성 보험 판매가 늘었습니다',
  '수익성 개선이 확인되는 국면입니다',
  '단독 보도로 알려진 내용입니다',
  '개인화 추천 서비스가 매출을 견인합니다',
];
async function main() {
  const known = new Set((await prisma.instrument.findMany({ select: { name: true, ticker: true } }))
    .flatMap((r) => [r.name.toLowerCase(), r.ticker.toLowerCase()]));
  let hit = 0;
  console.log('\n[음성 변형 — 잡혀야 함]');
  for (const s of EVASION) {
    const h = findPhoneticEvasion(s, known);
    if (h.length) hit += 1;
    console.log(`  ${h.length ? '○' : '✗'}  ${h.map((x) => `${x.keyword}~"${x.quote}"(d${x.distance})`).join(' ') || '없음'}   "${s}"`);
  }
  let fp = 0;
  console.log('\n[정상 문장 — 안 걸려야 함]');
  for (const s of NORMAL) {
    const h = findPhoneticEvasion(s, known);
    if (h.length) { fp += 1; console.log(`  ✗  ${h.map((x) => `${x.keyword}~"${x.quote}"(d${x.distance})`).join(' ')}   "${s}"`); }
  }
  if (fp === 0) console.log('  (오탐 없음)');
  console.log(`\n▶ 변형 ${hit}/${EVASION.length} 탐지 · 정상 ${NORMAL.length}건 중 오탐 ${fp}건\n`);
}
main().then(() => process.exit(0));
