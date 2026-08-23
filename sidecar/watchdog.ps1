<#
.SYNOPSIS
  학생 모델 사이드카를 띄우고, **죽으면 앱 밖으로 알린다** (10차 검토 I-1·I-5).

.DESCRIPTION
  ── 왜 이게 필요한가 ────────────────────────────────────────────────
  사이드카 장애는 이 설계에서 **게시 중단이 아니라 검수 약화**로 나타난다. 학생이
  통째로 빠지고 규칙 단독으로 돌아가므로 게시는 계속되고, 리서처도 구매자도 차이를
  못 느끼고, 패러프레이즈 탐지율만 조용히 0%가 된다. **증상이 없는 고장**이다.

  9차에 웹 쪽에 상태 엣지 알림을 붙였지만 그것으로 닫히지 않는 자리가 둘 남는다:
    ① 웹 프로세스도 함께 죽으면 알릴 사람이 없다
    ② 사이드카가 재부팅 뒤 아예 안 뜨면 "끊겼다"는 전이 자체가 안 생긴다

  검토의 답: **감시자의 감시는 애플리케이션 계층이 아니라 운영체제 계층에서 멈춘다.**
  이 스크립트가 그 층이다 — 사이드카의 부모로 앉아 자식이 죽으면 알리고 자기도 끝난다.
  자기가 죽으면? **작업 스케줄러(OS)가 다시 띄운다.** 되물음은 거기서 멈춘다.

  ── NSSM이 아니라 작업 스케줄러인 이유 ──────────────────────────────
  검토는 NSSM을 지목했다. 맞는 도구지만 **내려받아야 하는 서드파티 실행 파일**이고,
  이 저장소는 지금 그 결정을 하지 않았다. 윈도우에 이미 있는 작업 스케줄러가 같은
  세 가지를 준다: 부팅 시 자동 시작 · 웹과 독립된 수명 · 실패 시 자동 재시작.
  차이는 서비스 목록에 안 보인다는 것 하나다(`schtasks /query`로 본다).
  NSSM을 쓰기로 하면 install-task.ps1만 바꾸면 되고 이 파일은 그대로다.

.PARAMETER AlertSink
  경보를 밖으로 보내는 대신 이 파일에 적는다. **시험 전용** — 실제 채널로 나가면
  종단간 지연을 재려다 창업자 폰에 가짜 경보가 간다(2026-08-18에 실제로 그랬다).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File sidecar/watchdog.ps1
#>
param(
    [int]$Port = 8765,
    [string]$AlertSink = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$sidecar = Join-Path $root "sidecar"
$python = Join-Path $sidecar ".venv\Scripts\python.exe"

# .env 는 이 스크립트가 **런타임에** 읽는다. 값을 여기 적어 두면 저장소에 비밀이 남는다.
function Read-DotEnv {
    $path = Join-Path $root ".env"
    $map = @{}
    if (Test-Path $path) {
        foreach ($line in Get-Content $path -Encoding UTF8) {
            if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
                $map[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
            }
        }
    }
    return $map
}

function Send-Alert([string]$title, [string]$body) {
    $text = "$title`n$body"
    if ($AlertSink) {
        # 시험 경로 — 밖으로 한 통도 내보내지 않는다
        Add-Content -Path $AlertSink -Value $text -Encoding UTF8
        return
    }
    # `$env` 로 받지 않는다 — PowerShell 예약 드라이브 변수라 덮어쓰면
    # 이 스코프의 `$env:VAR` 접근이 통째로 망가진다
    $cfg = Read-DotEnv
    $sent = $false
    if ($cfg.TELEGRAM_BOT_TOKEN -and $cfg.TELEGRAM_CHAT_ID) {
        try {
            # parse_mode를 주지 않는다 — 마크다운 모드는 본문의 *·_ 하나에 메시지 전체가
            # 거절된다(opsAlert.ts가 같은 이유로 평문을 쓴다)
            Invoke-RestMethod -Method Post -TimeoutSec 5 `
                -Uri "https://api.telegram.org/bot$($cfg.TELEGRAM_BOT_TOKEN)/sendMessage" `
                -ContentType "application/json; charset=utf-8" `
                -Body ([System.Text.Encoding]::UTF8.GetBytes((@{
                    chat_id = $cfg.TELEGRAM_CHAT_ID; text = $text
                } | ConvertTo-Json -Compress))) | Out-Null
            $sent = $true
        } catch {
            Write-Host "텔레그램 경보 실패: $_"
        }
    }
    if ($cfg.OPS_WEBHOOK_URL) {
        try {
            Invoke-RestMethod -Method Post -TimeoutSec 5 -Uri $cfg.OPS_WEBHOOK_URL `
                -ContentType "application/json; charset=utf-8" `
                -Body ([System.Text.Encoding]::UTF8.GetBytes((@{ text = $text } | ConvertTo-Json -Compress))) | Out-Null
            $sent = $true
        } catch {
            Write-Host "웹훅 경보 실패: $_"
        }
    }
    # **채널이 없으면 그 사실을 남긴다.** 조용히 넘어가면 "경보가 안 온다"와
    # "사고가 없다"가 구별되지 않는다 — 이 스크립트가 막으려는 바로 그 실패다
    if (-not $sent) { Write-Host "경보 채널이 설정되지 않았습니다 (.env: TELEGRAM_* / OPS_WEBHOOK_URL)" }
}

if (-not (Test-Path $python)) { throw "가상환경이 없습니다: $python" }

Write-Host "사이드카를 띄웁니다 — 포트 $Port"
$startedAt = Get-Date
$proc = Start-Process -FilePath $python -PassThru -NoNewWindow `
    -ArgumentList @("-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", "$Port") `
    -WorkingDirectory $sidecar
# **핸들을 미리 붙잡는다.** 이 줄이 없으면 종료 뒤 ExitCode 가 빈 값으로 나온다
# (.NET Process 는 핸들을 놓친 뒤에는 종료 코드를 못 읽는다 — 실측으로 확인).
# 경보에 '종료 코드 ' 만 적히면 *죽었다* 와 *스스로 끝났다* 가 구별되지 않는다.
$null = $proc.Handle
$proc.WaitForExit()

$uptime = [int]((Get-Date) - $startedAt).TotalSeconds
Send-Alert "[검수] 학생 모델 사이드카 종료 — 지금 규칙 단독으로 검수 중입니다" @"
종료 코드 $($proc.ExitCode) · 가동 $uptime 초 · 포트 $Port
게시는 계속되지만 패러프레이즈 탐지율이 0%입니다(규칙이 못 잡는 자리).
작업 스케줄러가 곧 다시 띄웁니다. 반복되면 sidecar 로그를 보십시오.
"@

# **0이 아닌 코드로 끝난다** — 스케줄러가 "실패"로 보고 재시작 정책을 태운다.
exit 1
