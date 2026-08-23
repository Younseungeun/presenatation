import { Suspense } from "react";
import { TossFailClient } from "./TossFailClient";

export default function TossFailPage() {
  return (
    <Suspense>
      <TossFailClient />
    </Suspense>
  );
}
