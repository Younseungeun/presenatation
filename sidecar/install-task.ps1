<#
.SYNOPSIS
  사이드카를 **부팅 때 저절로 뜨는 OS 작업**으로 등록한다 (10차 검토 I-5).

.DESCRIPTION
  ── 왜 웹의 자식으로 띄우지 않는가 ──────────────────────────────────
  같은 프로세스 트리에 두면 수명이 붙어 편하지만, 그것이 정확히 **5차에 정한 자원 분리
  원칙을 깨는 방식**이다. 사이드카를 파이썬으로 뺀 이유가 ① Node 토크나이저 패리티
  위험 회피 ② SQLite 쓰기 락 경쟁 회피였는데, 자식으로 띄우면 웹이 메모리 한계로
  죽을 때 검수 모델도 함께 죽는다 — 고립이 필요한 순간에 정확히 고립이 사라진다.

  ── 무엇을 등록하는가 ───────────────────────────────────────────────
  `watchdog.ps1`을 등록한다. 사이드카를 직접 등록하면 죽었을 때 아무도 모른다 —
  감시자가 부모로 앉아야 종료를 관측하고 밖으로 알릴 수 있다(I-1).

  ── 이 스크립트는 시스템 설정을 바꾼다. 사람이 직접 실행한다 ─────────
  등록하면 이 기계가 켜질 때마다 프로세스가 하나 뜬다 — 되돌리려면 `-Remove`.

.PARAMETER Remove
  등록을 해제한다.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File sidecar/install-task.ps1
  powershell -ExecutionPolicy Bypass -File sidecar/install-task.ps1 -Remove
#>
param(
    [switch]$Remove,
    [string]$TaskName = "intovill-student-sidecar"
)

$ErrorActionPreference = "Stop"
$watchdog = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "watchdog.ps1"

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "등록 해제: $TaskName"
    return
}

if (-not (Test-Path $watchdog)) { throw "watchdog.ps1 이 없습니다: $watchdog" }

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdog`""

# 부팅 시 + 로그온 시 둘 다. 로그온 트리거가 있어야 개발 중에 재로그인해도 살아난다
$triggers = @(
    (New-ScheduledTaskTrigger -AtStartup),
    (New-ScheduledTaskTrigger -AtLogOn)
)

# 감시자가 종료 코드 1로 끝나면 스케줄러가 다시 띄운다.
# RestartInterval 1분 — 사이드카 기동이 수 초라 그보다 짧게 잡을 이유가 없고,
# 못 뜨는 상태에서 초 단위로 재시도하면 로그가 폭우가 된다.
$settings = New-ScheduledTaskSettingsSet `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -RestartCount 999 `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Settings $settings -Description "INTOVILL 학생 모델 검수 사이드카 (watchdog)" -Force | Out-Null

Write-Host @"
등록했습니다: $TaskName

  지금 바로 띄우기   schtasks /run /tn $TaskName
  상태 보기          schtasks /query /tn $TaskName /v /fo list
  등록 해제          powershell -File sidecar/install-task.ps1 -Remove
"@

# **읽고 나서 말한다.** 무조건 찍으면 이미 넣은 사람에게 매번 거짓말을 하게 되고,
# 매번 거짓말하는 경고는 곧 아무도 안 읽는다 — 이 저장소가 경보 피로를 다루는 방식과 같다.
$envPath = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) ".env"
$needed = @("STUDENT_SIDECAR_URL", "STUDENT_THRESHOLD", "STUDENT_MODE")
$have = @()
if (Test-Path $envPath) {
    $text = Get-Content $envPath -Raw -Encoding UTF8
    $have = $needed | Where-Object { $text -match "(?m)^\s*$_\s*=" }
}
$missing = $needed | Where-Object { $have -notcontains $_ }

if ($missing.Count -eq 0) {
    Write-Host "`n.env 확인 — 학생 검수 설정 세 줄이 모두 있습니다. 바로 쓸 수 있습니다."
} else {
    Write-Host "`n⚠ 등록만으로는 아직 반쪽입니다. .env 에 다음이 없습니다:"
    foreach ($m in $missing) {
        $line = switch ($m) {
            "STUDENT_SIDECAR_URL" { "STUDENT_SIDECAR_URL=http://127.0.0.1:8765" }
            "STUDENT_THRESHOLD"   { "STUDENT_THRESHOLD=0.5" }
            default               { "STUDENT_MODE=live" }
        }
        Write-Host "  $line"
    }
}
