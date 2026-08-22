import { AdminHead } from "../../AdminHead";
import a from "../../admin.module.css";
import { IrisDetail } from "./IrisDetail";

/**
 * **IRIS 상세** — 계기판의 박스를 누르면 오는 자리.
 *
 * 계기판은 매일 보는 화면이라 `IRIS.v5 ✓` 두 조각만 남겼다. 나머지(도장·지문·승격
 * 기록·회차 기록)는 지운 것이 아니라 여기로 옮겼다 — 되짚을 때만 필요한 값이라
 * 상시로 자리를 차지할 이유가 없다.
 *
 * 값은 계기판과 **같은 엔드포인트**에서 읽는다(IrisDetail 주석) — 여기서 다시 계산하면
 * 같은 질문의 답이 두 곳에서 나오고 언젠가 갈라진다.
 */
export default function IrisPage() {
  return (
    <>
      <AdminHead title="IRIS" sub="검수 모델 상세" backHref="/admin/compliance" />
      <main className={a.page}>
        <IrisDetail />
      </main>
    </>
  );
}
