Add-Type -Name PW -Namespace Win32 -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$CONT = [uint32]2147483648  # ES_CONTINUOUS
$HOLD = [uint32]2147483649  # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
$r = [Win32.PW]::SetThreadExecutionState($HOLD)
"hold set, prev=0x{0:X}" -f $r | Out-File -Append keep-awake.log
while (Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'train\.py|export_onnx' }) { Start-Sleep -Seconds 60 }
[Win32.PW]::SetThreadExecutionState($CONT) | Out-Null
"released $(Get-Date -Format HH:mm)" | Out-File -Append keep-awake.log