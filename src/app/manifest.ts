import type { MetadataRoute } from "next";

// PWA 매니페스트 — 홈 화면에 추가하면 브라우저 UI 없이 앱처럼 실행된다(standalone).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "INTOVILL",
    short_name: "INTOVILL",
    description:
      "인투빌(INTOVILL) — 성과 검증형 리서치 마켓플레이스. 예측이 시장 데이터로 자동 검증되는 리포트 플랫폼",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    lang: "ko",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
