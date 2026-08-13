-- 우리가 판정하지 못하는 종목을 riskLevel과 **다른 칸**에 기록한다.
-- riskLevel = 거래소가 지정한 사실 / unjudgeableAt = 우리 쪽 시세 소스의 한계.
-- 처분(신규 게시 차단)이 같아도 뜻이 달라, 한 칸에 담으면 공급자를 갈아 끼울 때
-- "진짜 상폐"와 "우리가 못 구한 것"을 구분할 수 없다.
ALTER TABLE "Instrument" ADD COLUMN "unjudgeableAt" DATETIME;
ALTER TABLE "Instrument" ADD COLUMN "unjudgeableNote" TEXT;
