# LLM 실측 작업 동안 절전 방지 — training/llm2/results/ALL_DONE 파일이 생기면 풀린다.
# (안전판: 6시간 지나면 무조건 풀린다)
Add-Type -Name PW -Namespace Win32 -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$CONT = [uint32]2147483648  # ES_CONTINUOUS
$HOLD = [uint32]2147483649  # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
$marker = "C:\Users\jooyon\Desktop\CLAUDE CODE\presenatation\training\llm2\results\ALL_DONE"
$log = "C:\Users\jooyon\Desktop\CLAUDE CODE\presenatation\training\llm2\results\keep-awake.log"
[Win32.PW]::SetThreadExecutionState($HOLD) | Out-Null
"hold set $(Get-Date -Format 'MM-dd HH:mm')" | Out-File -Append $log
$deadline = (Get-Date).AddHours(6)
while (-not (Test-Path $marker) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 60 }
[Win32.PW]::SetThreadExecutionState($CONT) | Out-Null
"released $(Get-Date -Format 'MM-dd HH:mm') (marker=$(Test-Path $marker))" | Out-File -Append $log
