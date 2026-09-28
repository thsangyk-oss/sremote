# S-remote screen agent - JSONL protocol on stdin/stdout.
# Ops in:  shot {w,q} | info | click {x,y,btn,dbl} | down {x,y,btn} | up {x,y,btn}
#          move {x,y} | scroll {x,y,d} | type {text} | key {k} | ping
# Ops out: ready | info {w,h} | frame {b64,w,h} | ack | err {msg} | pong
# x,y are fractions (0..1) of the virtual screen. Windows-only (GDI+ capture).
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::ASCII
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class U32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
}
'@

function Say($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)) }
function VScreen { [System.Windows.Forms.SystemInformation]::VirtualScreen }
function ToScreen($fx, $fy) {
  $v = VScreen
  return @([int]($v.Left + $fx * $v.Width), [int]($v.Top + $fy * $v.Height))
}

function Shot($w, $q) {
  $v = VScreen
  $sw = [int]$v.Width; $sh = [int]$v.Height
  $w = [int]$w; $q = [int]$q
  if ($w -lt 160 -or $w -gt $sw) { $w = $sw }
  if ($q -lt 10 -or $q -gt 95) { $q = 55 }
  $h = [int]($sh * $w / $sw)
  $full = New-Object System.Drawing.Bitmap $sw, $sh
  $gf = [System.Drawing.Graphics]::FromImage($full)
  $gf.CopyFromScreen($v.Left, $v.Top, 0, 0, $full.Size)
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBilinear'
  $g.DrawImage($full, 0, 0, $w, $h)
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter -ArgumentList ([System.Drawing.Imaging.Encoder]::Quality), ([long]$q)
  $jpg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, $jpg, $ep)
  $b64 = [Convert]::ToBase64String($ms.ToArray())
  $ms.Dispose(); $g.Dispose(); $bmp.Dispose(); $gf.Dispose(); $full.Dispose()
  return @{ op = 'frame'; b64 = $b64; w = $w; h = $h }
}

function Click-At($fx, $fy, $btn, $dbl, $only) {
  $p = ToScreen $fx $fy
  [U32]::SetCursorPos($p[0], $p[1]) | Out-Null
  $dn, $up = switch ($btn) { 'r' { 0x08, 0x10 } 'm' { 0x20, 0x40 } default { 0x02, 0x04 } }
  if ($only -eq 'down') { [U32]::mouse_event($dn, 0, 0, 0, [IntPtr]::Zero); return }
  if ($only -eq 'up')   { [U32]::mouse_event($up, 0, 0, 0, [IntPtr]::Zero); return }
  $n = if ($dbl -eq $true) { 2 } else { 1 }
  for ($i = 0; $i -lt $n; $i++) {
    [U32]::mouse_event($dn, 0, 0, 0, [IntPtr]::Zero)
    [U32]::mouse_event($up, 0, 0, 0, [IntPtr]::Zero)
  }
}

function Send-Text($t) {
  # escape SendKeys specials, map newlines to {ENTER}
  $e = ($t -replace '([+^%~(){}\[\]])', '{$1}') -replace "`r`n|`n|`r", '{ENTER}'
  [System.Windows.Forms.SendKeys]::SendWait($e)
}

Say @{ op = 'ready' }
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    $m = $line | ConvertFrom-Json
    switch ($m.op) {
      'ping'   { Say @{ op = 'pong' } }
      'info'   { $v = VScreen; Say @{ op = 'info'; w = $v.Width; h = $v.Height } }
      'shot'   { Say (Shot $m.w $m.q) }
      'click'  { Click-At $m.x $m.y $m.btn $m.dbl; Say @{ op = 'ack' } }
      'down'   { Click-At $m.x $m.y $m.btn $false 'down'; Say @{ op = 'ack' } }
      'up'     { Click-At $m.x $m.y $m.btn $false 'up'; Say @{ op = 'ack' } }
      'move'   { $p = ToScreen $m.x $m.y; [U32]::SetCursorPos($p[0], $p[1]) | Out-Null; Say @{ op = 'ack' } }
      'scroll' { $p = ToScreen $m.x $m.y; [U32]::SetCursorPos($p[0], $p[1]) | Out-Null
                 [U32]::mouse_event(0x0800, 0, 0, [uint32]$m.d, [IntPtr]::Zero); Say @{ op = 'ack' } }
      'type'   { Send-Text $m.text; Say @{ op = 'ack' } }
      'key'    { [System.Windows.Forms.SendKeys]::SendWait([string]$m.k); Say @{ op = 'ack' } }
      default  { Say @{ op = 'err'; msg = "unknown op $($m.op)" } }
    }
  } catch { Say @{ op = 'err'; msg = $_.Exception.Message } }
}
