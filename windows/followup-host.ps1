# FollowUp Copilot shutdown helper (Chrome "native messaging" host).
# Chrome starts this for one request: 4-byte length + JSON in, the same format out.
# It only understands: ping, shutdown (with a delay), cancel.
$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

function Read-Message {
    $lenBytes = New-Object byte[] 4
    if ($stdin.Read($lenBytes, 0, 4) -lt 4) { return $null }
    $size = [BitConverter]::ToInt32($lenBytes, 0)
    if ($size -le 0 -or $size -gt 65536) { return $null }
    $buf = New-Object byte[] $size
    $read = 0
    while ($read -lt $size) {
        $n = $stdin.Read($buf, $read, $size - $read)
        if ($n -le 0) { break }
        $read += $n
    }
    return ([Text.Encoding]::UTF8.GetString($buf, 0, $read) | ConvertFrom-Json)
}

function Send-Message($obj) {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress))
    $stdout.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

$msg = Read-Message
if ($null -eq $msg) { exit 0 }
switch ($msg.action) {
    'ping' { Send-Message @{ ok = $true; version = '1.0' } }
    'shutdown' {
        $delay = 10
        if ($msg.delaySec -ne $null) { $delay = [Math]::Max(0, [int]$msg.delaySec) }
        Start-Process -FilePath 'shutdown.exe' -ArgumentList "/s /t $delay /c `"FollowUp Copilot finished. Shutting down.`"" -WindowStyle Hidden
        Send-Message @{ ok = $true }
    }
    'cancel' {
        Start-Process -FilePath 'shutdown.exe' -ArgumentList '/a' -WindowStyle Hidden
        Send-Message @{ ok = $true }
    }
    default { Send-Message @{ ok = $false; error = 'unknown action' } }
}
