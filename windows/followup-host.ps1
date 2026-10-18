# FollowUp Copilot helper (Chrome "native messaging" host).
# Chrome starts this for one request: 4-byte length + JSON in, the same format out.
# It only understands: ping, shutdown (with a delay), cancel, and saving/reading the
# name lists (.csv files only) in the folder chosen in the extension's Settings.
Add-Type -AssemblyName System.Web.Extensions
$json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$json.MaxJsonLength = [int]::MaxValue  # name lists can be several MB
$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

function Read-Message {
    $lenBytes = New-Object byte[] 4
    if ($stdin.Read($lenBytes, 0, 4) -lt 4) { return $null }
    $size = [BitConverter]::ToInt32($lenBytes, 0)
    if ($size -le 0 -or $size -gt 67108864) { return $null }
    $buf = New-Object byte[] $size
    $read = 0
    while ($read -lt $size) {
        $n = $stdin.Read($buf, $read, $size - $read)
        if ($n -le 0) { break }
        $read += $n
    }
    return $json.DeserializeObject([Text.Encoding]::UTF8.GetString($buf, 0, $read))
}

function Send-Message($obj) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($json.Serialize($obj))
    $stdout.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

# Only .csv files with a plain name, inside a full folder path like D:\FollowUp-History.
function Get-SafePath($folder, $name) {
    if ([string]::IsNullOrWhiteSpace($folder) -or -not [IO.Path]::IsPathRooted($folder)) { throw "Use a full folder path, like D:\FollowUp-History" }
    if ($name -notmatch '^[^\\/:*?"<>|]{1,120}\.csv$') { throw "Not an allowed file name: $name" }
    if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }
    return (Join-Path $folder $name)
}
$utf8 = New-Object Text.UTF8Encoding($true)

$msg = Read-Message
if ($null -eq $msg) { exit 0 }
switch ($msg.action) {
    'ping' { Send-Message @{ ok = $true; version = '1.1' } }
    'saveFile' {
        try {
            $path = Get-SafePath $msg.folder $msg.name
            $tmp = $path + '.tmp'
            [IO.File]::WriteAllText($tmp, [string]$msg.content, $utf8)
            Move-Item -LiteralPath $tmp -Destination $path -Force
            Send-Message @{ ok = $true; path = $path }
        } catch { Send-Message @{ ok = $false; error = $_.Exception.Message } }
    }
    'appendFile' {
        try {
            $path = Get-SafePath $msg.folder $msg.name
            if (-not (Test-Path -LiteralPath $path) -and $msg.header) { [IO.File]::WriteAllText($path, [string]$msg.header, $utf8) }
            [IO.File]::AppendAllText($path, [string]$msg.content, (New-Object Text.UTF8Encoding($false)))
            Send-Message @{ ok = $true; path = $path }
        } catch { Send-Message @{ ok = $false; error = $_.Exception.Message } }
    }
    'readFile' {
        try {
            $path = Get-SafePath $msg.folder $msg.name
            if (-not (Test-Path -LiteralPath $path)) { Send-Message @{ ok = $true; content = ''; more = $false; missing = $true }; break }
            $all = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
            $offset = 0
            if ($msg.offset -ne $null) { $offset = [Math]::Max(0, [int]$msg.offset) }
            $chunk = 300000  # Chrome accepts at most 1 MB per answer
            $len = [Math]::Max(0, [Math]::Min($chunk, $all.Length - $offset))
            Send-Message @{ ok = $true; content = $all.Substring([Math]::Min($offset, $all.Length), $len); more = (($offset + $len) -lt $all.Length) }
        } catch { Send-Message @{ ok = $false; error = $_.Exception.Message } }
    }
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
