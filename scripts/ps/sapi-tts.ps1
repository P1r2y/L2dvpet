# SAPI 5 语音合成小工具，供桌宠主进程调用。
#
#   列出所有可用语音：
#     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sapi-tts.ps1 -List
#
#   合成一段语音（请求为 UTF-8 JSON 的 Base64）：
#     powershell ... -File scripts\sapi-tts.ps1 -Request <base64> -Out <wav路径>
#     JSON 字段：{ text, voice, rate, pitch, volume }
#       rate/pitch 为相对百分比字符串，如 "+20%" / "-15%"（pitch 走 SSML）
#       volume 为 0-100 整数
#
# 成功时向 stdout 打印 "OK <字节数>"，失败打印 "ERR <原因>"。
param(
  [switch]$List,
  [string]$Request,
  [string]$Out
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Fail([string]$msg) { [Console]::Out.WriteLine("ERR $msg"); exit 1 }

function Escape-Xml([string]$s) {
  return $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;').Replace("'", '&apos;')
}

try {
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
} catch {
  Fail "无法初始化 SAPI: $($_.Exception.Message)"
}

if ($List) {
  $synth.GetInstalledVoices() | ForEach-Object {
    $i = $_.VoiceInfo
    [Console]::Out.WriteLine(("{0}|{1}|{2}|{3}" -f $i.Name, $i.Culture.Name, $i.Gender, $i.Age))
  }
  $synth.Dispose()
  exit 0
}

if (-not $Request) { $synth.Dispose(); Fail '缺少 -Request' }
if (-not $Out)     { $synth.Dispose(); Fail '缺少 -Out' }

try {
  $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request))
  $req  = $json | ConvertFrom-Json
} catch {
  $synth.Dispose(); Fail "请求解析失败: $($_.Exception.Message)"
}

$text = [string]$req.text
if ([string]::IsNullOrWhiteSpace($text)) { $synth.Dispose(); Fail '文本为空' }
# Edge/OpenAI 的风格是长文本一次读完；SAPI 对超长文本不友好，做个上限。
if ($text.Length -gt 1200) { $text = $text.Substring(0, 1200) }

if ($req.voice) {
  try { $synth.SelectVoice([string]$req.voice) }
  catch { $synth.Dispose(); Fail "找不到语音「$($req.voice)」: $($_.Exception.Message)" }
}

if ($null -ne $req.volume) {
  $synth.Volume = [Math]::Max(0, [Math]::Min(100, [int]$req.volume))
}

$rate  = if ($req.rate)  { [string]$req.rate }  else { '+0%' }
$pitch = if ($req.pitch) { [string]$req.pitch } else { '+0%' }
$lang  = $synth.Voice.Culture.Name

# 用 SSML 控制语速与音调：这是唯一能改「声线」的旋钮（SAPI 本身没有 pitch 属性）。
$ssml = @"
<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='$lang'>
<prosody rate='$rate' pitch='$pitch'>$(Escape-Xml $text)</prosody>
</speak>
"@

try {
  $dir = Split-Path -Parent $Out
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  if (Test-Path $Out) { Remove-Item $Out -Force }

  $synth.SetOutputToWaveFile($Out)
  $synth.SpeakSsml($ssml)
  $synth.SetOutputToNull()
  $synth.Dispose()

  if (-not (Test-Path $Out)) { Fail '合成后没有生成文件' }
  $len = (Get-Item $Out).Length
  if ($len -lt 1024) { Fail "生成的音频过短 ($len 字节)" }
  [Console]::Out.WriteLine("OK $len")
  exit 0
} catch {
  try { $synth.Dispose() } catch { }
  Fail "合成失败: $($_.Exception.Message)"
}
