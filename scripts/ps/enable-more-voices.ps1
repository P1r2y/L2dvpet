# 把 Windows 的 OneCore 语音（微软康康 / 瑶瑶 / Susan / George 等）镜像到 SAPI 5，
# 让系统语音朗读 / Chromium speechSynthesis 也能选到它们。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\enable-more-voices.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\enable-more-voices.ps1 -Undo
#
# 只做「新增」：已存在的语音永不覆盖。卸载时只删除本脚本原样复制过来的键。
param([switch]$Undo, [switch]$Quiet)

$ErrorActionPreference = 'Stop'

$ONE    = 'SOFTWARE\Microsoft\Speech_OneCore\Voices\Tokens'
$SAPI   = 'SOFTWARE\Microsoft\Speech\Voices\Tokens'
$SAPI32 = 'SOFTWARE\WOW6432Node\Microsoft\Speech\Voices\Tokens'

# 这些是系统自带、由 SAPI 原生的语音，任何时候都不动它们。
$PROTECTED = @('TTS_MS_EN-GB_HAZEL_11.0', 'TTS_MS_EN-US_ZIRA_11.0', 'TTS_MS_ZH-CN_HUIHUI_11.0')

function Open-Key([string]$path, [bool]$writable) {
  $base = [Microsoft.Win32.Registry]::LocalMachine
  if (-not $writable) { return $base.OpenSubKey($path, $false) }
  return $base.CreateSubKey($path, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree)
}

function Get-TokenNames([string]$path) {
  $k = Open-Key $path $false
  if ($null -eq $k) { return @() }
  $names = $k.GetSubKeyNames()
  $k.Close()
  return $names
}

function Copy-RegistryKey([string]$srcPath, [string]$dstParent, [string]$name) {
  $dstPath = "$dstParent\$name"
  $dst = Open-Key $dstPath $true
  $src = Open-Key "$srcPath\$name" $false
  if ($null -eq $src) { $dst.Close(); return $false }

  foreach ($v in $src.GetValueNames()) {
    $dst.SetValue($v, $src.GetValue($v), [Microsoft.Win32.RegistryValueKind]::String)
  }
  # 只复制 Attributes 子键（SAPI 靠它读取 Name / Language / Gender）
  $srcAttr = $src.OpenSubKey('Attributes', $false)
  if ($null -ne $srcAttr) {
    $dstAttr = $dst.CreateSubKey('Attributes')
    foreach ($v in $srcAttr.GetValueNames()) {
      $dstAttr.SetValue($v, $srcAttr.GetValue($v), [Microsoft.Win32.RegistryValueKind]::String)
    }
    $dstAttr.Close(); $srcAttr.Close()
  }
  $dst.Close(); $src.Close()
  return $true
}

function Remove-IfMirrored([string]$parent, [string]$name) {
  if ($PROTECTED -contains $name) { return $false }
  $base = [Microsoft.Win32.Registry]::LocalMachine
  $p = "$parent\$name"
  $k = $base.OpenSubKey($p, $false)
  if ($null -eq $k) { return $false }
  $k.Close()
  $base.DeleteSubKeyTree($p, $false)
  return $true
}

function Get-SapiVoices {
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $list = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo }
  $synth.Dispose()
  return $list
}

# ── 卸载 ────────────────────────────────────────────────────────────────
if ($Undo) {
  $onecore = Get-TokenNames $ONE
  $n = 0
  foreach ($name in $onecore) {
    foreach ($parent in @($SAPI, $SAPI32)) {
      if (Remove-IfMirrored $parent $name) { $n++; Write-Host "  已移除 $parent\$name" }
    }
  }
  Write-Host "`n完成，共移除 $n 项。当前 SAPI 语音："
  Get-SapiVoices | ForEach-Object { Write-Host ("  {0,-34} {1}" -f $_.Name, $_.Culture.Name) }
  exit 0
}

# ── 安装 ────────────────────────────────────────────────────────────────
if (-not $Quiet) { Write-Host "=== 复制前：SAPI 语音 ===" }
$sapiNow = Get-TokenNames $SAPI
if (-not $Quiet) { $sapiNow | ForEach-Object { Write-Host "  $_" } }

$onecore = Get-TokenNames $ONE
$added = 0
foreach ($name in $onecore) {
  if (($onecore -contains $name) -and -not ($sapiNow -contains $name)) {
    if (Copy-RegistryKey $ONE $SAPI $name) { $added++; if (-not $Quiet) { Write-Host "  + $name" } }
  }
  if (-not ((Get-TokenNames $SAPI32) -contains $name)) {
    if (Copy-RegistryKey $ONE $SAPI32 $name) { if (-not $Quiet) { Write-Host "  + (32位) $name" } }
  }
}

if (-not $Quiet) { Write-Host "`n=== 复制后：SAPI 可以看到的语音 ===" }
$voices = Get-SapiVoices
$voices | ForEach-Object { Write-Host ("  {0,-36} {1,-7} {2}" -f $_.Name, $_.Culture.Name, $_.Gender) }

# 逐个验证引擎真的能出声（有些 OneCore 语音在 SAPI 下只是"列得出来但用不了"）
if (-not $Quiet) { Write-Host "`n=== 逐个试合成 ===" }
$tmp = Join-Path $env:TEMP 'pet_voice_check'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$good = @(); $bad = @()
foreach ($v in $voices) {
  $file = Join-Path $tmp (($v.Name -replace '[^\w]', '_') + '.wav')
  try {
    $synth.SelectVoice($v.Name)
    $synth.SetOutputToWaveFile($file)
    $synth.Speak('测试一二三')
    $synth.SetOutputToNull()
    $len = (Get-Item $file).Length
    if ($len -gt 20000) { $good += $v.Name } else { $bad += "$($v.Name) (只有 $len 字节)" }
    if (-not $Quiet) { Write-Host ("  {0,-36} {1,9} bytes  {2}" -f $v.Name, $len, $(if ($len -gt 20000) { 'OK' } else { '异常' })) }
  } catch {
    $bad += "$($v.Name): $($_.Exception.Message)"
    if (-not $Quiet) { Write-Host ("  {0,-36} 失败: {1}" -f $v.Name, $_.Exception.Message) }
  }
}
$synth.Dispose()

Write-Host ""
Write-Host "新增 $added 个语音键；可用语音 $($good.Count) 个，异常 $($bad.Count) 个。"
if ($bad.Count) { Write-Host "异常项："; $bad | ForEach-Object { Write-Host "  - $_" } }
Write-Host "`n如需还原：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\enable-more-voices.ps1 -Undo"
