// pm2 프로세스 정의 — npm run pm2:start
//
// 스케줄러는 상시 프로세스라 터미널을 닫으면 죽고, 예외 하나로 죽으면 아무도 모른다.
// 죽어 있는 동안 마감 판정 창구(마감+5분부터 한 시간)를 놓치면 그날 판정이 통째로
// 비므로, **자동 재시작**과 **로그 보존**이 실제로 돈이 걸린 문제다.
// (기동하면 catchUpOnBoot이 밀린 판정을 따라잡는다 — 재시작이 피해를 지운다)
//
// tsx를 node로 직접 부른다. 윈도우에서 pm2가 npm.cmd를 감싸면 자식 프로세스가 남아
// 재시작·종료가 지저분해진다.

module.exports = {
  apps: [
    {
      name: 'intovill-scheduler',
      script: './node_modules/tsx/dist/cli.mjs',
      args: 'scripts/runScheduler.ts',
      interpreter: 'node',
      cwd: __dirname,
      instances: 1,
      // 한 프로세스여야 한다 — 두 개가 뜨면 KIS 토큰 발급(분당 1회)에서 서로를 죽인다
      exec_mode: 'fork',
      autorestart: true,
      // 즉시 재시작을 반복하면 KIS 호출 제한에 걸린다. 10초 쉬고 다시 뜬다
      restart_delay: 10_000,
      // 1분 안에 10번 죽으면 설정이 잘못된 것이다 — 무한 재시작 대신 멈춰서 드러낸다
      max_restarts: 10,
      min_uptime: 60_000,
      // 누수로 램을 먹으면 알아서 재기동 (판정은 멱등이라 안전하다)
      max_memory_restart: '500M',
      // **종료에 시간을 준다.** 기본값 1.6초는 진행 중인 판정 한 회차(20장 × 1.1초 ≈ 22초)를
      // 못 기다려 SIGKILL로 자르는데, 그러면 종료 훅의 clearHeartbeat이 돌지 못해
      // **멈춘 스케줄러를 헬스 엔드포인트가 15분간 "살아 있다"고 답한다.**
      // 남은 큐는 프로세스가 알아서 버리므로(runScheduler의 stopping) 이 시간을 다 쓰지 않는다
      kill_timeout: 30_000,
      // **윈도우에는 SIGTERM이 없다** — pm2가 프로세스를 그냥 끊어 종료 훅이 한 번도
      // 돌지 못했다(실측). 이 옵션을 켜면 신호 대신 IPC로 'shutdown' 메시지를 보내고,
      // runScheduler가 그것을 듣는다. 리눅스에서는 신호가 그대로 동작하므로 양쪽 다 산다
      shutdown_with_message: true,
      time: true, // 로그 각 줄에 타임스탬프
      merge_logs: true,
      out_file: './logs/scheduler-out.log',
      error_file: './logs/scheduler-error.log',
      env: { NODE_ENV: 'production', TZ: 'Asia/Seoul' },
    },
  ],
};
