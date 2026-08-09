import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// 이 저장소는 상위 폴더(CLAUDE CODE) 안에 들어 있고, 그 상위에도 package-lock.json이 있다.
// Next는 락파일로 워크스페이스 루트를 추론하므로 그대로 두면 바깥 폴더를 루트로 잡고
// mobile/·server/·바깥 node_modules까지 전부 감시한다 — 감시 대상이 부풀면 dev 서버가
// 메모리 한계에 닿아 스스로 재시작하고, 그 순간 브라우저는 "network error"를 띄운다.
// 루트를 이 폴더로 못박아 감시 범위를 프로젝트 안으로 한정한다.
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  turbopack: { root: projectRoot },
  // 같은 Wi-Fi의 실기기(핸드폰)에서 개발 서버에 접속할 때 필요.
  // 없으면 /_next/* dev 리소스가 차단돼 스크립트가 로드되지 않는다(SSR 화면만 보임).
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.16.*.*", "*.local"],
  // 개발 모드 화면의 "Rendering…" 라우트 표시기 숨김 (컴파일·런타임 에러는 계속 표시됨)
  devIndicators: false,
};

export default nextConfig;
