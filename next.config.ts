import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 같은 Wi-Fi의 실기기(핸드폰)에서 개발 서버에 접속할 때 필요.
  // 없으면 /_next/* dev 리소스가 차단돼 스크립트가 로드되지 않는다(SSR 화면만 보임).
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.16.*.*", "*.local"],
  // 개발 모드 화면의 "Rendering…" 라우트 표시기 숨김 (컴파일·런타임 에러는 계속 표시됨)
  devIndicators: false,
};

export default nextConfig;
