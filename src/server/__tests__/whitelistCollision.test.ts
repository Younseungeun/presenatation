import { describe, expect, it } from 'vitest';
import { collidesWithRules } from '../whitelistCollision';

// 종목 마스터는 표기 회피 탐지의 화이트리스트라, 금지어와 충돌하는 이름이 상장되면
// 그 규칙이 그 종목에서 조용히 꺼진다. 매일 06:00 동기화가 이걸 훑는다 (14차 R-4).

describe('화이트리스트 충돌 검사', () => {
  it('정상 종목명은 걸리지 않는다', () => {
    for (const n of ['삼성전자', 'SK하이닉스', 'POSCO홀딩스', 'LG화학', 'NAVER', 'KT&G', '카카오']) {
      expect(collidesWithRules(n), n).toEqual([]);
    }
  });

  it('실제로 충돌하는 이름을 잡는다 — 2026-08-20 마스터에서 발견된 2건', () => {
    // 둘 다 ②층(공백 제거) 정규화가 만든 우연이다. `복원. 금보장`과 같은 부류인데,
    // 이쪽은 **상장 종목명**이라 그 종목을 분석하는 리서처가 전부 걸린다
    expect(collidesWithRules('올 인 퓨처테크 얼라이언스')).toContain('RISK_INDUCEMENT');
    // `루시드 다이어…` → `루시드다이어…` 안의 "시드다"가 `시드\s*(전부|다)`에 걸린다
    expect(collidesWithRules('루시드 다이어그노스틱스')).toContain('RISK_INDUCEMENT');
  });

  it('표기 훼손 신호는 세지 않는다 — 이름 한 토막에는 문맥이 없다', () => {
    // 여기서 묻는 것은 "이 이름이 금지 표현인가"이지 "훼손됐는가"가 아니다
    expect(collidesWithRules('삼성SDI')).not.toContain('SCREENING_EVASION');
  });
});
