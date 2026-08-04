import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 같은 Wi-Fi의 실기기(핸드폰)에서 개발 서버에 접속할 때 필요.
  // 없으면 /_next/* dev 리소스가 차단돼 스크립트가 로드되지 않는다(SSR 화면만 보임).
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.16.*.*", "*.local"],
};

export default nextConfig;
