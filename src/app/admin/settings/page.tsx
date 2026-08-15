import { notFound } from "next/navigation";
import { getUiSettings, SETTING_KEYS } from "@/server/appSettings";
import { prisma } from "@/server/db";
import { getMarketStats } from "@/server/marketStats";
import { getSessionUserId } from "@/server/session";
import { AppHeader } from "../../AppHeader";
import { MarketTicker } from "../../MarketTicker";
import { ASSET_CLASS_LABEL, ASSET_CLASSES } from "@/domain/constants";
import { getPauseState } from "@/server/judgmentPause";
import { PauseSwitch } from "./PauseSwitch";
import { SettingToggle } from "./SettingToggle";
import styles from "./adminSettings.module.css";
import shell from "../../researcher/researcher.module.css";

export const dynamic = "force-dynamic";

// 운영 설정 — 배포 없이 켜고 끄는 값들. 운영자가 아니면 존재 자체를 숨긴다 (404).
// 지금 상태를 글로 설명하는 대신 **미리보기를 같이 띄운다** — 띠지처럼 눈으로 판단할
// 대상은 "켜면 이렇게 보입니다"를 보여주는 편이 설명보다 정확하다.

export default async function AdminSettingsPage() {
  const userId = await getSessionUserId();
  if (!userId) notFound();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user?.role !== "OPERATOR") notFound();

  const settings = await getUiSettings(prisma);
  const pause = await getPauseState(prisma);
  // 미리보기는 실제 수치로 — 지금 켜면 무엇이 흐를지 그대로 보여준다
  const preview = await getMarketStats(prisma, { includeAmounts: true });

  return (
    <>
      <AppHeader title="운영 설정" backHref="/settings" />
      <main className={shell.page}>
        <p className={styles.intro}>
          배포 없이 즉시 반영됩니다. 기본값은 모두 꺼짐이고, 켜는 것은 수치가 보여줄 만해진
          뒤의 판단입니다.
        </p>

      {/* **사고 때 가장 먼저 누르는 스위치라 맨 위에 둔다.** 시세 공급자가 틀린 값을
          주기 시작하면 되돌리기보다 멈추는 것이 먼저다 — 멈추지 않고 되돌리면
          1.1초 뒤 배치가 같은 데이터로 다시 오판정한다 (server/judgmentPause) */}
        <div className={styles.section}>자동 판정 정지</div>
        <p className={styles.intro}>
          시세가 이상할 때 판정을 멈춥니다. 멈춘 동안 판정이 밀리고, 밀린 판정은 이월
          상한(14일)에 닿으면 전액 환불로 끝나므로 <strong>필요한 범위만</strong> 멈추세요.
          되돌리기는 <code>npm run judgment:bulk-revert</code>입니다 — 파괴적 행위라
          화면에 두지 않았습니다.
        </p>
        <PauseSwitch scope="ALL" label="전 자산군" initial={pause.global} />
        {ASSET_CLASSES.map((a) => (
          <PauseSwitch
            key={a}
            scope={a}
            label={ASSET_CLASS_LABEL[a]}
            initial={pause.byAssetClass[a] ?? false}
          />
        ))}

        <div className={styles.section}>시장 규모 띠지</div>
        <SettingToggle
          settingKey={SETTING_KEYS.marketTicker}
          title="띠지 표시"
          description="리더보드 상단에 마켓 현황이 흐르는 얇은 띠를 띄웁니다. 수치가 작을 때는 켜지 않는 편이 낫습니다 — 빈 마켓처럼 보이면 그 자체로 구매를 막습니다."
          initial={settings.marketTicker}
        />
        <SettingToggle
          settingKey={SETTING_KEYS.marketTickerAmounts}
          title="금액 항목 포함"
          description="누적 현금 환불·에스크로 보관액을 함께 흘립니다. 규모(장·건·명)와 금액은 민감도가 달라 따로 켭니다."
          initial={settings.marketTickerAmounts}
          disabled={!settings.marketTicker}
        />

        <div className={styles.section}>지금 켜면 이렇게 보입니다</div>
        <div className={styles.preview}>
          {preview.length > 0 ? (
            <MarketTicker stats={preview} />
          ) : (
            <p className={styles.empty}>
              아직 흐를 수치가 없습니다. 값이 0인 항목은 자동으로 빠집니다.
            </p>
          )}
        </div>
        <p className={styles.note}>
          미리보기에는 금액 항목이 항상 포함됩니다. 실제 화면은 위 스위치를 따릅니다.
        </p>
      </main>
    </>
  );
}
