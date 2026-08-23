import { Suspense } from "react";
import { TossSuccessClient } from "./TossSuccessClient";

export default function TossSuccessPage() {
  return (
    <Suspense>
      <TossSuccessClient />
    </Suspense>
  );
}
