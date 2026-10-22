"use strict";

/**
 * Remote desktop dari IDE (mirip VNC) tanpa dependency tambahan.
 *
 * Server menangkap layar host secara berkala (JPEG) dan mengirimnya lewat WebSocket
 * /desktop; klien mengirim event mouse/keyboard yang disuntikkan ke desktop.
 *
 *   Windows : helper PowerShell persisten (System.Drawing + user32 SendInput/keybd_event)
 *   Linux   : ImageMagick `import` / `scrot` untuk tangkap layar, `xdotool` untuk input.
 *             Tanpa desktop (VPS headless): Xvfb + XFCE virtual (:99) bisa dipasang & dijalankan.
 *   macOS   : `screencapture` untuk tangkap layar, `cliclick` untuk input (osascript untuk ketik).
 *
 * Koordinat dari klien berupa fraksi 0..1 dari layar; server memetakan ke piksel layar.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync, execFile } = require("child_process");
const Instructions = require("./agent-instructions"); // tool descriptions live in one file

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const VIRTUAL_DISPLAY = ":99";
const MOVE_MIN_MS = 8; // jarak minimal antar perintah pindah kursor (lihat queueMove)
// Jeda setelah sebuah aksi desktop sebelum screenshot diambil: cukup lama agar UI sempat
// menggambar hasilnya, cukup pendek agar agent tidak menunggu setengah detik per langkah.
// Aplikasi yang lebih lambat ditangani agent lewat desktop_wait.
const UI_SETTLE_MS = 180;

function which(bin) {
  try {
    const r = spawnSync(IS_WIN ? "where" : "which", [bin], { encoding: "utf8", windowsHide: true, timeout: 4000 });
    if (r.status !== 0) return "";
    return String(r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || "";
  } catch (e) { return ""; }
}

// ---------------------------------------------------------------- Windows helpers (PowerShell)
// Dua proses terpisah agar tiap skrip tetap "jinak" untuk Defender/AMSI: skrip yang menangkap layar
// SEKALIGUS menyuntik mouse+keyboard cocok dengan tanda tangan RAT dan sering diblokir.
//   Capture (System.Drawing saja): baris "frame <maxW> <q>" -> "F sw sh fw fh <b64jpeg>"; "R sw sh" saat start.
//   Input   (user32 saja):         baris move/down/up/wheel/hwheel/key/text.
// Bentuk sengaja dijaga "polos" (PrimaryScreen + ImageFormat::Jpeg, tanpa Encoder-quality/
// VirtualScreen/gambar kursor/SetProcessDPIAware) karena kombinasi itu memicu AMSI. Kualitas
// diatur lewat penurunan resolusi (maxW), bukan parameter kualitas JPEG.
const PS_CAPTURE = String.raw`
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$bmp = $null; $gfx = $null; $lastW = 0; $lastH = 0
$b0 = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
[Console]::Out.WriteLine("R $($b0.Width) $($b0.Height)")
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  if ($p[0] -eq 'quit') { break }
  if ($p[0] -ne 'frame') { continue }
  try {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $sw = $b.Width; $sh = $b.Height
    if ($sw -ne $lastW -or $sh -ne $lastH -or $bmp -eq $null) { if ($gfx) { $gfx.Dispose() }; if ($bmp) { $bmp.Dispose() }; $bmp = New-Object System.Drawing.Bitmap $sw, $sh; $gfx = [System.Drawing.Graphics]::FromImage($bmp); $lastW = $sw; $lastH = $sh }
    # Konteks grafis bisa jadi tidak valid setelah lock/unlock, ganti resolusi, atau sesi RDP
    # tersambung ulang ("The handle is invalid"). Kalau gagal, buang & buat ulang sekali lalu ulangi.
    try { $gfx.CopyFromScreen(0, 0, 0, 0, $bmp.Size) }
    catch {
      if ($gfx) { $gfx.Dispose() }; if ($bmp) { $bmp.Dispose() }
      $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $sw = $b.Width; $sh = $b.Height
      $bmp = New-Object System.Drawing.Bitmap $sw, $sh; $gfx = [System.Drawing.Graphics]::FromImage($bmp); $lastW = $sw; $lastH = $sh
      $gfx.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
    }
    $maxW = [int]$p[1]
    $out = $bmp; $fw = $sw; $fh = $sh
    if ($maxW -gt 0 -and $sw -gt $maxW) { $fw = $maxW; $fh = [int][Math]::Round($sh * $maxW / $sw); $out = New-Object System.Drawing.Bitmap $fw, $fh; $g2 = [System.Drawing.Graphics]::FromImage($out); $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear; $g2.DrawImage($bmp, 0, 0, $fw, $fh); $g2.Dispose() }
    # CopyFromScreen tidak menyertakan kursor. Gambar panah putih (ujung = titik klik) agar agent dan pengguna melihat mouse.
    # $ax/$ay = posisi kursor dalam piksel layar, dikirim ke Node supaya agent tahu persis di mana pointer berada.
    $ax = -1; $ay = -1
    try {
      $cp = [System.Windows.Forms.Cursor]::Position
      $ax = $cp.X; $ay = $cp.Y
      $cx = [int](($cp.X - $b.X) * $fw / [Math]::Max(1, $sw))
      $cy = [int](($cp.Y - $b.Y) * $fh / [Math]::Max(1, $sh))
      $cg = if ($out -eq $bmp) { $gfx } else { [System.Drawing.Graphics]::FromImage($out) }
      $pts = [System.Drawing.Point[]]@(
        (New-Object System.Drawing.Point $cx, $cy),
        (New-Object System.Drawing.Point $cx, ($cy + 28)),
        (New-Object System.Drawing.Point ($cx + 8), ($cy + 20)),
        (New-Object System.Drawing.Point ($cx + 12), ($cy + 32)),
        (New-Object System.Drawing.Point ($cx + 17), ($cy + 30)),
        (New-Object System.Drawing.Point ($cx + 11), ($cy + 18)),
        (New-Object System.Drawing.Point ($cx + 22), ($cy + 18)),
        (New-Object System.Drawing.Point $cx, $cy)
      )
      $cg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
      $cg.FillPolygon([System.Drawing.Brushes]::White, $pts)
      $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Black), 2.2
      $cg.DrawPolygon($pen, $pts); $pen.Dispose()
      if ($out -ne $bmp) { $cg.Dispose() }
    } catch {}
    $ms = New-Object System.IO.MemoryStream
    $out.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    if ($out -ne $bmp) { $out.Dispose() }
    [Console]::Out.WriteLine("F $sw $sh $fw $fh $ax $ay " + [Convert]::ToBase64String($ms.ToArray()))
    $ms.Dispose()
  } catch {
    # Paksa buat ulang bitmap/graphics di frame berikutnya; konteks lama mungkin sudah basi.
    try { if ($gfx) { $gfx.Dispose() } } catch {}
    try { if ($bmp) { $bmp.Dispose() } } catch {}
    $gfx = $null; $bmp = $null; $lastW = 0; $lastH = 0
    [Console]::Out.WriteLine("E " + ($_.Exception.Message -replace "[\r\n]+", " "))
  }
}
`;
const PS_INPUT = String.raw`
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$sig = 'using System; using System.Runtime.InteropServices; public static class VrIn {' +
  ' [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);' +
  ' [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e);' +
  ' [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e); }'
Add-Type -TypeDefinition $sig
$z = [UIntPtr]::Zero
[Console]::Out.WriteLine("READY")
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  try {
    switch ($p[0]) {
      'move'  { [VrIn]::SetCursorPos([int]$p[1], [int]$p[2]) | Out-Null }
      'down'  { $f = switch ($p[1]) { '2' { 8 } '1' { 32 } default { 2 } }; [VrIn]::mouse_event([uint32]$f, 0, 0, 0, $z) }
      'up'    { $f = switch ($p[1]) { '2' { 16 } '1' { 64 } default { 4 } }; [VrIn]::mouse_event([uint32]$f, 0, 0, 0, $z) }
      'wheel' { [VrIn]::mouse_event([uint32]2048, 0, 0, [int]$p[1], $z) }
      'hwheel'{ [VrIn]::mouse_event([uint32]4096, 0, 0, [int]$p[1], $z) }
      'key'   { $vk = [int]$p[1]; $ext = 0; if (@(0x21,0x22,0x23,0x24,0x25,0x26,0x27,0x28,0x2D,0x2E,0x5B,0x5C,0xA3,0xA5) -contains $vk) { $ext = 1 }; if ($p[2] -eq 'up') { [VrIn]::keybd_event([byte]$vk, 0, [uint32]($ext -bor 2), $z) } else { [VrIn]::keybd_event([byte]$vk, 0, [uint32]$ext, $z) } }
      'text'  { $t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1])); $esc = ($t -replace '([+^%~(){}\[\]])', '{$1}'); [System.Windows.Forms.SendKeys]::SendWait($esc) }
      'quit'  { break }
    }
  } catch {}
}
`;

// Helper ketiga (Windows): UI Automation, hanya membaca pohon elemen — tidak menangkap layar,
// tidak menyuntik input, jadi tetap terpisah dari dua helper lain demi AMSI.
//   Baris "find <max> <b64query>" -> 'U {"focusedWindow":...,"items":[{name,type,x,y,w,h,enabled,window}]}'
// Jendela yang fokus dipindai penuh (substring pada Name/AutomationId); jendela lain hanya
// dicocokkan nama persis lewat PropertyCondition supaya tetap cepat.
const PS_UIA = String.raw`
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
function Esc($s) { if ($s -eq $null) { return '' }; $s = [string]$s; return ($s -replace '\\', '\\\\' -replace '"', '\"' -replace "[\r\n\t]+", ' ') }
function Row($e, $win) {
  try {
    $r = $e.Current.BoundingRectangle
    if ($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { return $null }
    $t = $e.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    $n = $e.Current.Name
    if ([string]::IsNullOrWhiteSpace($n)) { $n = $e.Current.AutomationId }
    $en = if ($e.Current.IsEnabled) { 'true' } else { 'false' }
    return ('{"name":"' + (Esc $n) + '","type":"' + (Esc $t) + '","x":' + [int]($r.X + $r.Width / 2) + ',"y":' + [int]($r.Y + $r.Height / 2) + ',"w":' + [int]$r.Width + ',"h":' + [int]$r.Height + ',"enabled":' + $en + ',"window":"' + (Esc $win) + '"}')
  } catch { return $null }
}
function Matches($e, $q) {
  try {
    if ($e.Current.IsOffscreen) { return $false }
    $n = [string]$e.Current.Name; $a = [string]$e.Current.AutomationId
    if ($q -eq '') { return ($n -ne '') }
    return ($n.ToLowerInvariant().Contains($q) -or ($a -ne '' -and $a.ToLowerInvariant().Contains($q)))
  } catch { return $false }
}
[Console]::Out.WriteLine("READY")
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ', 3)
  if ($p[0] -eq 'quit') { break }
  if ($p[0] -ne 'find' -or $p.Length -lt 3) { continue }
  try {
    $max = [Math]::Max(1, [Math]::Min(60, [int]$p[1]))
    $q = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[2])).ToLowerInvariant().Trim()
    $rows = New-Object System.Collections.Generic.List[string]
    $seen = New-Object System.Collections.Generic.HashSet[string]
    $root = $AE::RootElement
    $fgWin = $null
    try {
      $cur = $AE::FocusedElement
      while ($cur -ne $null) { $par = $walker.GetParent($cur); if ($par -eq $null -or $par -eq $root) { break }; $cur = $par }
      if ($cur -ne $null -and $cur -ne $root) { $fgWin = $cur }
    } catch {}
    $fgName = ''
    if ($fgWin -ne $null) {
      $fgName = [string]$fgWin.Current.Name
      $all = $fgWin.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($e in $all) {
        if ($rows.Count -ge $max) { break }
        if (-not (Matches $e $q)) { continue }
        $row = Row $e $fgName
        if ($row -ne $null -and $seen.Add($row)) { $rows.Add($row) }
      }
    }
    if ($rows.Count -lt $max -and $q -ne '') {
      $cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $q, [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase)
      $wins = $root.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($w in $wins) {
        if ($rows.Count -ge $max) { break }
        try {
          if ($fgWin -ne $null -and $w.Equals($fgWin)) { continue }
          if ($w.Current.IsOffscreen) { continue }
          $wt = [string]$w.Current.Name
          $hits = $w.FindAll($TS::Subtree, $cond)
          foreach ($e in $hits) { if ($rows.Count -ge $max) { break }; $row = Row $e $wt; if ($row -ne $null -and $seen.Add($row)) { $rows.Add($row) } }
        } catch {}
      }
    }
    [Console]::Out.WriteLine('U {"focusedWindow":"' + (Esc $fgName) + '","items":[' + ($rows -join ',') + ']}')
  } catch { [Console]::Out.WriteLine("E " + ($_.Exception.Message -replace "[\r\n]+", " ")) }
}
`;

// Linux: AT-SPI lewat pyatspi (bila ada). Argumen: query, maks. Keluaran JSON satu baris.
const PY_ATSPI = String.raw`
import sys, json
q = sys.argv[1].lower().strip(); mx = int(sys.argv[2])
try:
    import pyatspi
except Exception:
    print(json.dumps({"error": "pyatspi unavailable"})); sys.exit(0)
out = []
def walk(node, win, depth):
    if len(out) >= mx or depth > 40: return
    try:
        for i in range(node.childCount):
            c = node.getChildAtIndex(i)
            if c is None: continue
            name = c.name or ""
            try: st = c.getState()
            except Exception: st = None
            visible = st is None or (st.contains(pyatspi.STATE_VISIBLE) and st.contains(pyatspi.STATE_SHOWING))
            if visible and (q == "" or q in name.lower()) and name:
                try:
                    ext = c.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
                    if ext.width > 0 and ext.height > 0:
                        out.append({"name": name, "type": c.getRoleName(), "x": int(ext.x + ext.width / 2), "y": int(ext.y + ext.height / 2),
                                    "w": int(ext.width), "h": int(ext.height), "enabled": st is None or st.contains(pyatspi.STATE_ENABLED), "window": win})
                except Exception: pass
            walk(c, win, depth + 1)
            if len(out) >= mx: return
    except Exception: pass
desk = pyatspi.Registry.getDesktop(0)
for a in desk:
    if a is None: continue
    for w in a:
        if w is None: continue
        walk(w, (w.name or a.name or ""), 0)
print(json.dumps({"items": out}))
`;

// macOS: System Events. Argumen: query, maks. Keluaran: baris TSV name\ttype\tx\ty\tw\th.
const AS_FIND = String.raw`
on run argv
  set q to item 1 of argv
  set mx to (item 2 of argv) as integer
  set out to ""
  set n to 0
  tell application "System Events"
    set fp to first application process whose frontmost is true
    set els to entire contents of window 1 of fp
    repeat with e in els
      if n >= mx then exit repeat
      try
        set nm to name of e
        if nm is missing value then set nm to description of e
        if nm is not missing value and (q is "" or nm contains q) then
          set p to position of e
          set s to size of e
          set out to out & nm & tab & (role of e) & tab & ((item 1 of p) + (item 1 of s) / 2) & tab & ((item 2 of p) + (item 2 of s) / 2) & tab & (item 1 of s) & tab & (item 2 of s) & linefeed
          set n to n + 1
        end if
      end try
    end repeat
  end tell
  return out
end run
`;

// Peta e.code (browser) -> Virtual-Key Windows.
const VK = {
  Enter: 0x0D, Tab: 0x09, Backspace: 0x08, Escape: 0x1B, Space: 0x20, Delete: 0x2E, Insert: 0x2D,
  Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22, ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  ShiftLeft: 0x10, ShiftRight: 0x10, ControlLeft: 0x11, ControlRight: 0x11, AltLeft: 0x12, AltRight: 0x12, MetaLeft: 0x5B, MetaRight: 0x5C,
  CapsLock: 0x14, NumLock: 0x90, ScrollLock: 0x91, PrintScreen: 0x2C, Pause: 0x13, ContextMenu: 0x5D,
  Semicolon: 0xBA, Equal: 0xBB, Comma: 0xBC, Minus: 0xBD, Period: 0xBE, Slash: 0xBF, Backquote: 0xC0,
  BracketLeft: 0xDB, Backslash: 0xDC, BracketRight: 0xDD, Quote: 0xDE,
  NumpadEnter: 0x0D, NumpadAdd: 0x6B, NumpadSubtract: 0x6D, NumpadMultiply: 0x6A, NumpadDivide: 0x6F, NumpadDecimal: 0x6E,
};
for (let i = 0; i < 26; i++) VK["Key" + String.fromCharCode(65 + i)] = 0x41 + i;
for (let i = 0; i <= 9; i++) { VK["Digit" + i] = 0x30 + i; VK["Numpad" + i] = 0x60 + i; }
for (let i = 1; i <= 12; i++) VK["F" + i] = 0x6F + i;

// Peta e.code -> keysym X11 (xdotool) & nama tombol cliclick (macOS).
const XKEY = {
  Enter: "Return", Tab: "Tab", Backspace: "BackSpace", Escape: "Escape", Space: "space", Delete: "Delete", Insert: "Insert",
  Home: "Home", End: "End", PageUp: "Prior", PageDown: "Next", ArrowLeft: "Left", ArrowUp: "Up", ArrowRight: "Right", ArrowDown: "Down",
  ShiftLeft: "Shift_L", ShiftRight: "Shift_R", ControlLeft: "Control_L", ControlRight: "Control_R", AltLeft: "Alt_L", AltRight: "Alt_R", MetaLeft: "Super_L", MetaRight: "Super_R",
  CapsLock: "Caps_Lock", NumLock: "Num_Lock", PrintScreen: "Print", Pause: "Pause", ContextMenu: "Menu",
  Semicolon: "semicolon", Equal: "equal", Comma: "comma", Minus: "minus", Period: "period", Slash: "slash", Backquote: "grave",
  BracketLeft: "bracketleft", Backslash: "backslash", BracketRight: "bracketright", Quote: "apostrophe",
  NumpadEnter: "KP_Enter", NumpadAdd: "KP_Add", NumpadSubtract: "KP_Subtract", NumpadMultiply: "KP_Multiply", NumpadDivide: "KP_Divide", NumpadDecimal: "KP_Decimal",
};
for (let i = 0; i < 26; i++) XKEY["Key" + String.fromCharCode(65 + i)] = String.fromCharCode(97 + i);
for (let i = 0; i <= 9; i++) { XKEY["Digit" + i] = String(i); XKEY["Numpad" + i] = "KP_" + i; }
for (let i = 1; i <= 12; i++) XKEY["F" + i] = "F" + i;

class DesktopRemote {
  constructor(opts) {
    opts = opts || {};
    this.dataDir = opts.dataDir || path.join(process.cwd(), "data");
    this.log = typeof opts.log === "function" ? opts.log : () => {};
    this.helper = null;        // Windows: proses capture PowerShell
    this.helperQueue = [];     // penunggu balasan frame (FIFO)
    this.helperBuf = "";
    this.winInput = null;      // Windows: proses input PowerShell (terpisah)
    this.winInputBlocked = false;
    this.winUia = null;        // Windows: proses UI Automation (hanya membaca pohon elemen)
    this.uiaQueue = [];
    this.uiaBuf = "";
    this.screen = { w: 0, h: 0 };
    this.pointer = { x: 0, y: 0 }; // posisi kursor terakhir (piksel layar)
    this._movePos = null;      // gerakan tertunda yang digabung (lihat queueMove)
    this._moveTimer = null;
    this._moveAt = 0;
    this.display = "";         // Linux: DISPLAY yang dipakai
    this.virtual = null;       // Linux: { xvfb, session } proses desktop virtual
    this.clients = new Set();
    this.busy = false;         // satu penangkapan layar pada satu waktu
    this.setup = { running: false, log: [], ok: null };
    this.shots = new Map(); // callId tool agent -> URL /api/ai/desktop/shot/<id>.jpg
    this.lastShot = "";
    // Windows: keadaan sesi tempat VRCloud berjalan (active/disconnected/...). Di-refresh
    // secara async supaya status() tetap cepat; lihat winSessionState()/refreshWinSession().
    this.winSession = IS_WIN ? "unknown" : "active";
    this.winSessionAt = 0;
  }

  // Keadaan sesi Windows tempat proses ini berjalan. "disconnected" (mis. tidak ada yang
  // login RDP, atau sesi RDP ditutup tanpa logout) berarti tidak ada desktop yang digambar:
  // CopyFromScreen menghasilkan layar hitam dan input tidak sampai ke mana-mana. qwinsta
  // menandai sesi pemanggil dengan ">"; STATE "Active" = baik, "Disc" = terputus.
  refreshWinSession() {
    if (!IS_WIN) return;
    const now = Date.now();
    if (this._winSessionBusy || (this.winSessionAt && now - this.winSessionAt < 4000)) return;
    this._winSessionBusy = true;
    let done = false;
    const finish = (state) => {
      if (done) return; done = true;
      this._winSessionBusy = false; this.winSessionAt = Date.now();
      if (state) this.winSession = state;
    };
    try {
      const child = execFile("qwinsta.exe", { encoding: "utf8", timeout: 4000, windowsHide: true }, (err, stdout) => {
        if (err) return finish(null); // qwinsta tak ada (SKU tertentu): jangan ubah keadaan
        const line = String(stdout || "").split(/\r?\n/).find((l) => /^\s*>/.test(l)) || "";
        let state = "unknown";
        if (/\bActive\b/i.test(line)) state = "active";
        else if (/\bDisc\b/i.test(line)) state = "disconnected";
        else if (/\bConn(ected|Query)?\b/i.test(line)) state = "connected";
        else if (/\bListen\b/i.test(line)) state = "listen";
        finish(state);
      });
      child.on("error", () => finish(null));
    } catch (e) { finish(null); }
  }
  // Simpan JPEG ke disk dan kembalikan URL pendek. Event Cursor membawa byte mentah
  // (bukan base64); menaruhnya di stream chat menghasilkan gambar rusak dan baris JSON raksasa.
  rememberShot(callId, jpeg) {
    if (!Buffer.isBuffer(jpeg) || jpeg.length < 80 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return;
    const id = (String(callId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64))
      || ("s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    const dir = path.join(this.dataDir, "desktop-shots");
    const file = id + ".jpg";
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), jpeg);
    } catch (e) {
      this.lastShot = "data:image/jpeg;base64," + jpeg.toString("base64");
      if (callId) this.shots.set(String(callId), this.lastShot);
      return;
    }
    const url = "/api/ai/desktop/shot/" + file;
    this.lastShot = url;
    this.shots.set(String(callId || id), url);
    while (this.shots.size > 80) {
      const old = this.shots.keys().next().value;
      const oldUrl = this.shots.get(old);
      this.shots.delete(old);
      const m = /\/([^/]+\.jpg)$/.exec(String(oldUrl || ""));
      if (m) { try { fs.unlinkSync(path.join(dir, m[1])); } catch (e2) {} }
    }
  }
  shotFor(callId) {
    if (callId && this.shots.has(String(callId))) return this.shots.get(String(callId));
    return this.lastShot || "";
  }
  shotFile(name) {
    const base = path.basename(String(name || ""));
    if (!/^[a-zA-Z0-9_-]{1,80}\.jpg$/.test(base)) return "";
    const abs = path.join(this.dataDir, "desktop-shots", base);
    return fs.existsSync(abs) ? abs : "";
  }

  // ---------------------------------------------------------------- status/deteksi
  linuxTools() {
    return {
      import: which("import"), scrot: which("scrot"), ffmpeg: which("ffmpeg"),
      xdotool: which("xdotool"), xvfb: which("Xvfb"), xfce: which("startxfce4") || which("xfce4-session"), xdpyinfo: which("xdpyinfo"),
    };
  }
  detectDisplay() {
    if (this.display) return this.display;
    if (process.env.DISPLAY && this.displayAlive(process.env.DISPLAY)) return this.display = process.env.DISPLAY;
    if (this.displayAlive(":0")) return this.display = ":0";
    if (this.displayAlive(VIRTUAL_DISPLAY)) return this.display = VIRTUAL_DISPLAY;
    return "";
  }
  displayAlive(d) {
    try {
      const r = spawnSync("xdpyinfo", ["-display", d], { encoding: "utf8", timeout: 3000, env: Object.assign({}, process.env, this.xEnv(d)) });
      return r.status === 0;
    } catch (e) { return false; }
  }
  xEnv(d) {
    const env = { DISPLAY: d };
    // Desktop asli (:0) biasanya milik pengguna login; coba XAUTHORITY yang lazim.
    if (d === ":0" && !process.env.XAUTHORITY) {
      const cands = [];
      try { fs.readdirSync("/run/user").forEach((u) => { cands.push("/run/user/" + u + "/gdm/Xauthority"); cands.push("/run/user/" + u + "/.mutter-Xwaylandauth"); }); } catch (e) {}
      try { fs.readdirSync("/home").forEach((u) => cands.push("/home/" + u + "/.Xauthority")); } catch (e) {}
      cands.push("/root/.Xauthority");
      const hit = cands.find((f) => { try { return fs.existsSync(f); } catch (e) { return false; } });
      if (hit) env.XAUTHORITY = hit;
    }
    return env;
  }
  status() {
    const out = { platform: process.platform, ok: false, reason: "", canSetup: false, setup: { running: this.setup.running, ok: this.setup.ok }, screen: this.screen, clients: this.clients.size };
    if (IS_WIN) {
      out.ok = !!which("powershell");
      if (!out.ok) out.reason = "PowerShell tidak ditemukan.";
      out.inputBlocked = this.winInputBlocked;
      out.captureBlocked = !!this.winCaptureBlocked;
      if (this.winCaptureBlocked) { out.ok = false; out.reason = "Antivirus (Defender/AMSI) memblokir tangkap layar PowerShell. Tambahkan pengecualian Defender untuk powershell.exe / folder data VRCloud agar Remote Desktop aktif di Windows ini."; return out; }
      // Sesi tempat VRCloud berjalan harus aktif agar ada desktop yang digambar & bisa dikendalikan.
      // Tanpa login (RDP ditutup / belum pernah login) sesi "disconnected": layar hitam, klik tak sampai.
      this.refreshWinSession();
      out.sessionState = this.winSession;
      if (this.winSession === "disconnected") {
        out.ok = false;
        out.needsConsole = true;
        out.reason = "Sesi Windows terputus (tidak ada yang login). Remote Desktop butuh sesi konsol yang aktif. " +
          "Agar jalan tanpa harus login RDP, siapkan auto-logon konsol: jalankan (sebagai Administrator) " +
          "scripts\\windows-headless-desktop.ps1 \u2014 lalu desktop tetap hidup meski RDP ditutup.";
        return out;
      }
      out.note = this.winInputBlocked
        ? "Tampilan berjalan, tetapi kendali mouse/keyboard diblokir antivirus (AMSI). Tambahkan pengecualian Defender untuk PowerShell agar bisa mengontrol."
        : "Menampilkan desktop sesi pengguna tempat VRCloud berjalan (Scheduled Task saat login).";
      return out;
    }
    if (IS_MAC) {
      out.ok = !!which("screencapture");
      out.input = !!which("cliclick");
      if (!out.input) out.reason = "Tangkap layar tersedia; untuk kendali mouse/keyboard pasang cliclick (brew install cliclick).";
      out.note = "Izinkan Screen Recording & Accessibility untuk proses node/Terminal di System Settings.";
      return out;
    }
    const t = this.linuxTools();
    const cap = t.import || t.scrot || t.ffmpeg;
    const disp = this.detectDisplay();
    out.tools = { capture: !!cap, xdotool: !!t.xdotool, xvfb: !!t.xvfb, xfce: !!t.xfce };
    out.display = disp;
    out.canSetup = process.getuid && process.getuid() === 0;
    if (!cap || !t.xdotool) { out.reason = "Butuh ImageMagick (import) atau scrot, dan xdotool."; return out; }
    const anyWm = t.xfce || ["xfwm4", "openbox", "fluxbox", "icewm", "twm"].some((b) => which(b));
    if (!disp && !(t.xvfb && anyWm)) { out.reason = "Server ini tidak punya desktop. Pasang desktop virtual (Xvfb + XFCE) untuk mengendalikannya dari sini."; return out; }
    out.ok = true;
    if (!disp) out.note = "Desktop virtual (" + VIRTUAL_DISPLAY + ") akan dijalankan saat dibuka.";
    else if (disp === VIRTUAL_DISPLAY && !this.wmAlive(disp)) out.note = anyWm ? "Sesi desktop belum berjalan; akan dijalankan saat dibuka." : "Display hidup tetapi tidak ada window manager (pasang xfce4).";
    return out;
  }

  // ---------------------------------------------------------------- setup desktop virtual (Linux, root)
  startSetup() {
    if (this.setup.running) return this.setup;
    if (IS_WIN || IS_MAC) throw new Error("Pemasangan desktop virtual hanya untuk Linux.");
    if (!(process.getuid && process.getuid() === 0)) throw new Error("Butuh root untuk memasang paket.");
    const script = path.join(__dirname, "..", "scripts", "desktop-setup.sh");
    if (!fs.existsSync(script)) throw new Error("scripts/desktop-setup.sh tidak ditemukan.");
    this.setup = { running: true, log: ["memasang Xvfb, XFCE, xdotool, ImageMagick\u2026"], ok: null };
    const child = spawn("bash", [script], { env: Object.assign({}, process.env, { DEBIAN_FRONTEND: "noninteractive" }), stdio: ["ignore", "pipe", "pipe"] });
    const push = (d) => { String(d).split(/\r?\n/).forEach((l) => { if (l.trim()) { this.setup.log.push(l); if (this.setup.log.length > 400) this.setup.log.shift(); } }); };
    child.stdout.on("data", push); child.stderr.on("data", push);
    child.on("close", (code) => { this.setup.running = false; this.setup.ok = code === 0; this.setup.log.push(code === 0 ? "\u2714 selesai" : "\u2716 gagal (exit " + code + ")"); this.display = ""; });
    child.on("error", (e) => { this.setup.running = false; this.setup.ok = false; this.setup.log.push("gagal menjalankan: " + e.message); });
    return this.setup;
  }

  // ---------------------------------------------------------------- Linux: desktop virtual
  // Layar hitam = X server hidup tetapi tidak ada sesi desktop (window manager) yang menggambar.
  // Ini terjadi bila Xvfb selamat dari restart server sementara sesi XFCE-nya mati, atau
  // sesi gagal start (HOME/XDG_RUNTIME_DIR/dbus tidak ada). Jadi: cek WM, (re)start bila perlu.
  wmAlive(d) {
    const env = Object.assign({}, process.env, this.xEnv(d));
    try {
      if (which("xprop")) {
        const r = spawnSync("xprop", ["-root", "-display", d, "_NET_SUPPORTING_WM_CHECK"], { encoding: "utf8", timeout: 3000, env });
        if (r.status === 0 && /window id/i.test(r.stdout || "")) return true;
        if (r.status === 0) return false; // properti tidak ada: tidak ada WM
      }
    } catch (e) {}
    try {
      // Tanpa xprop: ada jendela terlihat berarti ada sesuatu yang menggambar.
      const r = spawnSync("xdotool", ["search", "--onlyvisible", "--name", "."], { encoding: "utf8", timeout: 3000, env });
      return r.status === 0 && String(r.stdout || "").trim().length > 0;
    } catch (e) { return false; }
  }
  // Lingkungan yang dibutuhkan sesi desktop saat dijalankan dari service (systemd/root).
  sessionEnv(d) {
    const env = Object.assign({}, process.env, this.xEnv(d));
    env.DISPLAY = d;
    if (!env.HOME) { try { env.HOME = os.homedir() || "/root"; } catch (e) { env.HOME = "/root"; } }
    if (!env.USER) { try { env.USER = os.userInfo().username; } catch (e) {} }
    const uid = process.getuid ? process.getuid() : 0;
    let xdg = env.XDG_RUNTIME_DIR;
    try { if (!xdg || !fs.existsSync(xdg)) { xdg = path.join(os.tmpdir(), "vrcloud-xdg-" + uid); fs.mkdirSync(xdg, { recursive: true, mode: 0o700 }); } } catch (e) {}
    if (xdg) env.XDG_RUNTIME_DIR = xdg;
    env.XDG_SESSION_TYPE = "x11";
    if (!env.XDG_CURRENT_DESKTOP) env.XDG_CURRENT_DESKTOP = "XFCE";
    if (!env.LANG) env.LANG = "C.UTF-8";
    env.NO_AT_BRIDGE = "1";                 // tanpa a11y bus (tidak ada di server)
    delete env.WAYLAND_DISPLAY;
    return env;
  }
  // Compositor xfwm4 di atas Xvfb membuat tangkapan `import -window root` hitam: matikan lewat
  // konfigurasi per-channel sebelum sesi jalan (hanya bila pengguna belum punya konfigurasinya).
  disableXfwmCompositing(env) {
    try {
      const dir = path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || "/root", ".config"), "xfce4", "xfconf", "xfce-perchannel-xml");
      const file = path.join(dir, "xfwm4.xml");
      if (fs.existsSync(file)) {
        const cur = fs.readFileSync(file, "utf8");
        if (/use_compositing/.test(cur)) { if (/name="use_compositing"[^>]*value="true"/.test(cur)) fs.writeFileSync(file, cur.replace(/(name="use_compositing"[^>]*value=)"true"/, '$1"false"')); return; }
        fs.writeFileSync(file, cur.replace(/<\/channel>\s*$/, '  <property name="general" type="empty">\n    <property name="use_compositing" type="bool" value="false"/>\n  </property>\n</channel>\n'));
        return;
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, '<?xml version="1.0" encoding="UTF-8"?>\n<channel name="xfwm4" version="1.0">\n  <property name="general" type="empty">\n    <property name="use_compositing" type="bool" value="false"/>\n  </property>\n</channel>\n');
    } catch (e) { this.log("[desktop] xfwm4 config: " + e.message); }
  }
  sessionLog() {
    try { fs.mkdirSync(this.dataDir, { recursive: true }); return fs.openSync(path.join(this.dataDir, "desktop-session.log"), "a"); } catch (e) { return "ignore"; }
  }
  // Jalankan sesi desktop pada display d: XFCE lengkap bila ada, kalau tidak WM apa pun yang tersedia.
  startLinuxSession(d) {
    const now = Date.now();
    if (this.sessionStartedAt && now - this.sessionStartedAt < 20000) return false; // jangan spam restart
    this.sessionStartedAt = now;
    const t = this.linuxTools();
    const env = this.sessionEnv(d);
    const log = this.sessionLog();
    const stdio = ["ignore", log, log];
    const run = (bin, args) => { const p = spawn(bin, args || [], { env, stdio, detached: true }); p.on("error", () => {}); p.unref(); return p; };
    try { if (log !== "ignore") fs.writeSync(log, "\n[" + new Date().toISOString() + "] starting desktop session on " + d + "\n"); } catch (e) {}
    // Latar root tidak hitam pekat: terlihat bahwa display hidup walau sesi masih memuat.
    if (which("xsetroot")) { try { spawnSync("xsetroot", ["-display", d, "-solid", "#1f2430"], { env, timeout: 2000 }); } catch (e) {} }
    this.notifyClients({ t: "note", message: "Menjalankan sesi desktop di " + d + "\u2026" });
    let sess = null;
    if (t.xfce) {
      this.disableXfwmCompositing(env);
      const dbus = which("dbus-launch");
      sess = dbus ? run(dbus, ["--exit-with-session", t.xfce]) : run(t.xfce, []);
    } else {
      // Fallback: window manager sederhana + terminal, agar ada yang bisa dikendalikan.
      const wm = ["xfwm4", "openbox", "fluxbox", "icewm", "twm"].map((b) => which(b)).find(Boolean);
      if (!wm) return false;
      sess = /xfwm4$/.test(wm) ? run(wm, ["--compositor=off"]) : run(wm, []);
      const term = ["xfce4-terminal", "x-terminal-emulator", "xterm"].map((b) => which(b)).find(Boolean);
      if (term) setTimeout(() => { try { run(term, []); } catch (e) {} }, 1200);
    }
    this.virtual = Object.assign({}, this.virtual || {}, { session: sess, display: d });
    return true;
  }
  async ensureLinuxDisplay() {
    let d = this.detectDisplay();
    const t = this.linuxTools();
    if (!d) {
      if (!t.xvfb) throw new Error("Tidak ada desktop. Pasang desktop virtual dulu.");
      const xvfb = spawn(t.xvfb, [VIRTUAL_DISPLAY, "-screen", "0", "1440x900x24", "-nolisten", "tcp", "-ac", "+extension", "RANDR"], { stdio: "ignore", detached: true });
      xvfb.on("error", () => {}); xvfb.unref();
      for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 150)); if (this.displayAlive(VIRTUAL_DISPLAY)) break; }
      if (!this.displayAlive(VIRTUAL_DISPLAY)) throw new Error("Xvfb tidak mau berjalan.");
      this.virtual = { xvfb, display: VIRTUAL_DISPLAY };
      this.display = d = VIRTUAL_DISPLAY;
      this.screen = { w: 0, h: 0 };
    }
    // Display hidup tetapi tanpa window manager (Xvfb lama, sesi mati, atau baru dibuat): jalankan sesi.
    // Hanya untuk display virtual/tanpa pemilik — desktop :0 milik pengguna login dibiarkan.
    const virtual = d === VIRTUAL_DISPLAY || (this.virtual && this.virtual.display === d);
    const lastCheck = this.wmCheckAt || 0;
    if (virtual && Date.now() - lastCheck > 5000) {
      this.wmCheckAt = Date.now();
      if (!this.wmAlive(d)) {
        const started = this.startLinuxSession(d);
        if (started) {
          this.sessionStarting = true;
          for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); if (this.wmAlive(d)) break; }
          this.sessionStarting = false;
          if (!this.wmAlive(d)) this.log("[desktop] desktop session did not come up on " + d + " (see data/desktop-session.log)");
        }
      }
    }
    return d;
  }
  linuxScreenSize(d) {
    try {
      const r = spawnSync("xdotool", ["getdisplaygeometry"], { encoding: "utf8", timeout: 3000, env: Object.assign({}, process.env, this.xEnv(d)) });
      const m = /(\d+)\s+(\d+)/.exec(r.stdout || "");
      if (m) return { w: +m[1], h: +m[2] };
    } catch (e) {}
    try {
      const r = spawnSync("xdpyinfo", ["-display", d], { encoding: "utf8", timeout: 3000, env: Object.assign({}, process.env, this.xEnv(d)) });
      const m = /dimensions:\s+(\d+)x(\d+)/.exec(r.stdout || "");
      if (m) return { w: +m[1], h: +m[2] };
    } catch (e) {}
    return { w: 0, h: 0 };
  }
  captureLinux(maxW, q) {
    return new Promise(async (resolve, reject) => {
      let d;
      try { d = await this.ensureLinuxDisplay(); } catch (e) { return reject(e); }
      if (!this.screen.w) this.screen = this.linuxScreenSize(d);
      const env = Object.assign({}, process.env, this.xEnv(d));
      const t = this.linuxTools();
      const done = (err, buf) => {
        if (err || !buf) return reject(new Error("Tangkap layar gagal: " + ((err && err.message) || err || "kosong")));
        const sw = this.screen.w || 0, sh = this.screen.h || 0;
        let fw = sw, fh = sh;
        if (maxW && sw > maxW) { fw = maxW; fh = Math.round(sh * maxW / sw); }
        const pt = this.linuxPointer(d, env);
        const sx = pt && sw ? pt.x * fw / sw : null, sy = pt && sh ? pt.y * fh / sh : null;
        this.stampPointer(buf, sx, sy).then((jpeg) => resolve({ jpeg, sw, sh, fw, fh })).catch(() => resolve({ jpeg: buf, sw, sh, fw, fh }));
      };
      if (t.import) {
        // -screen: ambil isi layar sesungguhnya (termasuk jendela yang di-redirect compositor), bukan hanya root.
        const args = ["-display", d, "-window", "root", "-screen", "-silent", "-quality", String(q)];
        if (maxW && this.screen.w > maxW) args.push("-resize", String(maxW));
        args.push("jpg:-");
        execFile(t.import, args, { env, encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 8000 }, done);
      } else if (t.scrot) {
        const tmp = path.join(os.tmpdir(), "vrcloud-desk-" + process.pid + ".jpg");
        execFile(t.scrot, ["-o", "-q", String(q), tmp], { env, timeout: 8000 }, (err) => {
          if (err) return done(err);
          fs.readFile(tmp, (e2, buf) => done(e2, buf));
        });
      } else if (t.ffmpeg) {
        const args = ["-loglevel", "error", "-f", "x11grab", "-video_size", this.screen.w + "x" + this.screen.h, "-i", d, "-frames:v", "1", "-q:v", String(Math.max(2, Math.round((100 - q) / 8))), "-f", "image2", "-vcodec", "mjpeg", "-"];
        execFile(t.ffmpeg, args, { env, encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 8000 }, done);
      } else reject(new Error("Tidak ada alat tangkap layar (pasang imagemagick atau scrot)."));
    });
  }
  linuxPointer(d, env) {
    try {
      const r = spawnSync("xdotool", ["getmouselocation", "--shell"], { encoding: "utf8", timeout: 2000, env: env || Object.assign({}, process.env, this.xEnv(d)) });
      const x = /X=(\d+)/.exec(r.stdout || ""), y = /Y=(\d+)/.exec(r.stdout || "");
      if (x && y) return { x: +x[1], y: +y[1] };
    } catch (e) {}
    return null;
  }
  // Gambar panah kursor di JPEG (Linux). Ujung panah = koordinat klik. Windows menggambar di helper; macOS memakai screencapture -C.
  stampPointer(buf, x, y) {
    return new Promise((resolve) => {
      if (!buf || x == null || y == null || IS_WIN) return resolve(buf);
      const bin = which("magick") || which("convert");
      if (!bin || /\\convert\.exe$/i.test(bin)) return resolve(buf);
      const xi = Math.round(x), yi = Math.round(y);
      const pts = [[0, 0], [0, 28], [8, 20], [12, 32], [17, 30], [11, 18], [22, 18], [0, 0]].map((p) => (xi + p[0]) + "," + (yi + p[1])).join(" ");
      const draw = "fill white stroke black stroke-width 1.4 polyline " + pts;
      const args = /magick$/i.test(bin) ? ["convert", "-", "-draw", draw, "jpg:-"] : ["-", "-draw", draw, "jpg:-"];
      let child;
      try { child = spawn(bin, args, { stdio: ["pipe", "pipe", "ignore"] }); } catch (e) { return resolve(buf); }
      const chunks = [];
      child.stdout.on("data", (c) => chunks.push(c));
      const finish = (ok) => { const out = Buffer.concat(chunks); resolve(ok && out.length > 80 ? out : buf); };
      child.on("error", () => finish(false));
      child.on("close", (code) => finish(code === 0));
      try { child.stdin.end(buf); } catch (e) { finish(false); }
    });
  }
  xdo(args) {
    const d = this.display || this.detectDisplay(); if (!d) return;
    try { spawn("xdotool", args, { env: Object.assign({}, process.env, this.xEnv(d)), stdio: "ignore" }).on("error", () => {}); } catch (e) {}
  }

  // ---------------------------------------------------------------- macOS
  captureMac(maxW, q) {
    return new Promise((resolve, reject) => {
      const tmp = path.join(os.tmpdir(), "vrcloud-desk-" + process.pid + ".jpg");
      execFile("screencapture", ["-x", "-C", "-t", "jpg", tmp], { timeout: 8000 }, (err) => {
        if (err) return reject(new Error("screencapture gagal (izinkan Screen Recording): " + err.message));
        fs.readFile(tmp, (e2, buf) => {
          if (e2) return reject(e2);
          if (!this.screen.w) {
            try {
              const r = spawnSync("system_profiler", ["SPDisplaysDataType"], { encoding: "utf8", timeout: 5000 });
              const m = /Resolution:\s+(\d+)\s*x\s*(\d+)/.exec(r.stdout || ""); if (m) this.screen = { w: +m[1], h: +m[2] };
            } catch (e) {}
          }
          resolve({ jpeg: buf, sw: this.screen.w, sh: this.screen.h, fw: 0, fh: 0 });
        });
      });
    });
  }
  macInput(cmd) {
    const cc = which("cliclick"); if (!cc) return;
    try { spawn(cc, cmd, { stdio: "ignore" }).on("error", () => {}); } catch (e) {}
  }

  // ---------------------------------------------------------------- Windows
  ensureWinHelper() {
    if (this.helper && !this.helper.killed && this.helper.exitCode == null) return this.helper;
    const script = path.join(this.dataDir, "desktop-capture.ps1");
    try { fs.mkdirSync(this.dataDir, { recursive: true }); fs.writeFileSync(script, "\uFEFF" + PS_CAPTURE, "utf8"); } catch (e) {}
    const h = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.helper = h; this.helperBuf = ""; this.helperQueue = [];
    h.stdout.setEncoding("utf8");
    h.stdout.on("data", (chunk) => {
      this.helperBuf += chunk;
      let i;
      while ((i = this.helperBuf.indexOf("\n")) !== -1) {
        const line = this.helperBuf.slice(0, i).replace(/\r$/, ""); this.helperBuf = this.helperBuf.slice(i + 1);
        if (!line) continue;
        if (line[0] === "R") { const p = line.split(" "); this.screen = { w: +p[1] || 0, h: +p[2] || 0 }; continue; }
        const waiter = this.helperQueue.shift();
        if (!waiter) continue;
        if (line[0] === "E") waiter.reject(new Error(line.slice(2)));
        else if (line[0] === "F") {
          const p = line.split(" "); // base64 tidak berisi spasi: F sw sh fw fh cx cy <b64> = 8 bagian
          this.screen = { w: +p[1], h: +p[2] };
          const cx = +p[5], cy = +p[6];
          if (cx >= 0 && cy >= 0) this.pointer = { x: cx, y: cy };
          waiter.resolve({ jpeg: Buffer.from(p[7] || "", "base64"), sw: +p[1], sh: +p[2], fw: +p[3], fh: +p[4] });
        } else waiter.reject(new Error(line));
      }
    });
    this.helperStarted = Date.now(); this.helperErr = "";
    h.stderr.on("data", (d) => { this.helperErr += d; this.log("[desktop] " + String(d).trim()); });
    h.on("close", () => {
      if (Date.now() - this.helperStarted < 1500 && /malicious|blocked|AMSI|antivirus/i.test(this.helperErr)) this.winCaptureBlocked = true;
      const reason = this.winCaptureBlocked
        ? "Tangkap layar diblokir antivirus (Defender/AMSI). Tambahkan pengecualian untuk PowerShell agar Remote Desktop bisa berjalan di Windows ini."
        : "Helper desktop berhenti.";
      const q = this.helperQueue; this.helperQueue = []; q.forEach((w) => w.reject(new Error(reason)));
      if (this.helper === h) this.helper = null;
    });
    return h;
  }
  // Proses input Windows (user32) terpisah; kalau diblokir antivirus, tandai agar UI memberi tahu.
  ensureWinInput() {
    if (this.winInput && !this.winInput.killed && this.winInput.exitCode == null) return this.winInput;
    if (this.winInputBlocked) return null;
    const script = path.join(this.dataDir, "desktop-input.ps1");
    try { fs.mkdirSync(this.dataDir, { recursive: true }); fs.writeFileSync(script, "\uFEFF" + PS_INPUT, "utf8"); } catch (e) {}
    const h = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    this.winInput = h; this.winInputStarted = Date.now();
    let errBuf = "";
    h.stderr.on("data", (d) => { errBuf += d; });
    h.on("close", () => {
      // Mati < 1.5 dtk + pesan AMSI => input diblokir antivirus; jangan coba lagi.
      if (Date.now() - this.winInputStarted < 1500 && /malicious|blocked|AMSI|antivirus/i.test(errBuf)) { this.winInputBlocked = true; this.log("[desktop] input Windows diblokir antivirus (AMSI). Tampilan tetap jalan; kendali dinonaktifkan."); }
      if (this.winInput === h) this.winInput = null;
    });
    h.on("error", () => { if (this.winInput === h) this.winInput = null; });
    return h;
  }
  winSend(line) {
    const h = this.ensureWinInput();
    if (!h) return;
    try { h.stdin.write(line + "\n"); } catch (e) {}
  }
  // Helper UI Automation (Windows), protokol baris dengan antrean penunggu seperti capture.
  ensureWinUia() {
    if (this.winUia && !this.winUia.killed && this.winUia.exitCode == null) return this.winUia;
    const script = path.join(this.dataDir, "desktop-uia.ps1");
    try { fs.mkdirSync(this.dataDir, { recursive: true }); fs.writeFileSync(script, "\uFEFF" + PS_UIA, "utf8"); } catch (e) {}
    const h = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.winUia = h; this.uiaBuf = ""; this.uiaQueue = [];
    h.stdout.setEncoding("utf8");
    h.stdout.on("data", (chunk) => {
      this.uiaBuf += chunk;
      let i;
      while ((i = this.uiaBuf.indexOf("\n")) !== -1) {
        const line = this.uiaBuf.slice(0, i).replace(/\r$/, ""); this.uiaBuf = this.uiaBuf.slice(i + 1);
        if (!line || line === "READY") continue;
        const waiter = this.uiaQueue.shift();
        if (!waiter) continue;
        if (line[0] === "U") { try { waiter.resolve(JSON.parse(line.slice(2))); } catch (e) { waiter.reject(new Error("UIA: balasan rusak")); } }
        else waiter.reject(new Error(line.replace(/^E\s*/, "")));
      }
    });
    h.stderr.on("data", (d) => this.log("[desktop-uia] " + String(d).trim()));
    h.on("close", () => { const q = this.uiaQueue; this.uiaQueue = []; q.forEach((w) => w.reject(new Error("Helper UI Automation berhenti."))); if (this.winUia === h) this.winUia = null; });
    h.on("error", () => { if (this.winUia === h) this.winUia = null; });
    return h;
  }
  findWin(query, max) {
    return new Promise((resolve, reject) => {
      const h = this.ensureWinUia();
      const t = setTimeout(() => { const i = this.uiaQueue.indexOf(w); if (i >= 0) this.uiaQueue.splice(i, 1); reject(new Error("UI Automation timeout (jendela terlalu besar?)")); }, 20000);
      const w = { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } };
      this.uiaQueue.push(w);
      try { h.stdin.write("find " + (max | 0) + " " + Buffer.from(String(query || ""), "utf8").toString("base64") + "\n"); }
      catch (e) { this.uiaQueue.pop(); w.reject(e); }
    });
  }
  findLinux(query, max) {
    const d = this.display || this.detectDisplay();
    const env = Object.assign({}, process.env, d ? this.xEnv(d) : {});
    const run = (bin, args, input) => new Promise((resolve) => {
      let out = "";
      let child;
      try { child = spawn(bin, args, { env, stdio: ["pipe", "pipe", "ignore"] }); } catch (e) { return resolve(""); }
      const t = setTimeout(() => { try { child.kill(); } catch (e) {} resolve(out); }, 15000);
      child.stdout.on("data", (c) => { out += c; });
      child.on("error", () => { clearTimeout(t); resolve(""); });
      child.on("close", () => { clearTimeout(t); resolve(out); });
      try { child.stdin.end(input || ""); } catch (e) {}
    });
    return (async () => {
      const py = which("python3") || which("python");
      if (py) {
        const out = await run(py, ["-", String(query || ""), String(max | 0)], PY_ATSPI);
        try { const j = JSON.parse(out.trim().split(/\r?\n/).pop() || "{}"); if (Array.isArray(j.items)) return { items: j.items, source: "at-spi" }; } catch (e) {}
      }
      // Fallback: hanya jendela tingkat atas lewat xdotool.
      if (!which("xdotool")) return { items: [], source: "none", note: "Neither pyatspi (AT-SPI) nor xdotool is available." };
      const ids = (await run("xdotool", ["search", "--onlyvisible", "--name", String(query || ".")])).split(/\s+/).filter(Boolean).slice(0, max | 0);
      const items = [];
      for (const id of ids) {
        const name = (await run("xdotool", ["getwindowname", id])).trim();
        const geo = await run("xdotool", ["getwindowgeometry", "--shell", id]);
        const g = {}; geo.split(/\r?\n/).forEach((l) => { const m = /^(\w+)=(\d+)/.exec(l); if (m) g[m[1]] = +m[2]; });
        if (g.WIDTH > 0 && g.HEIGHT > 0) items.push({ name, type: "window", x: (g.X | 0) + (g.WIDTH >> 1), y: (g.Y | 0) + (g.HEIGHT >> 1), w: g.WIDTH, h: g.HEIGHT, enabled: true, window: name });
      }
      return { items, source: "xdotool", note: "pyatspi is not installed, so only top-level windows can be found (apt install python3-pyatspi for controls)." };
    })();
  }
  findMac(query, max) {
    return new Promise((resolve) => {
      let out = "";
      let child;
      try { child = spawn("osascript", ["-", String(query || ""), String(max | 0)], { stdio: ["pipe", "pipe", "ignore"] }); } catch (e) { return resolve({ items: [], source: "none" }); }
      const t = setTimeout(() => { try { child.kill(); } catch (e) {} resolve({ items: [], source: "none", note: "System Events timed out" }); }, 15000);
      child.stdout.on("data", (c) => { out += c; });
      child.on("error", () => { clearTimeout(t); resolve({ items: [], source: "none" }); });
      child.on("close", () => {
        clearTimeout(t);
        const items = out.split(/\r?\n/).filter(Boolean).map((l) => {
          const p = l.split("\t"); if (p.length < 6) return null;
          return { name: p[0], type: String(p[1]).replace(/^AX/, ""), x: Math.round(+p[2]), y: Math.round(+p[3]), w: Math.round(+p[4]), h: Math.round(+p[5]), enabled: true, window: "" };
        }).filter(Boolean);
        resolve({ items, source: "system-events" });
      });
      try { child.stdin.end(AS_FIND); } catch (e) {}
    });
  }
  // Cari elemen UI yang terlihat berdasarkan nama (substring, tanpa peduli huruf besar).
  // Mengembalikan { items: [{ name, type, px, py, w, h, x, y, enabled, window }], source, focusedWindow, note }.
  async findElements(query, max) {
    max = Math.max(1, Math.min(60, max | 0 || 20));
    let res;
    if (IS_WIN) res = await this.findWin(query, max);
    else if (IS_MAC) res = await this.findMac(query, max);
    else res = await this.findLinux(query, max);
    const w = this.screen.w || 0, h = this.screen.h || 0;
    const items = (res.items || []).slice(0, max).map((it) => ({
      name: String(it.name || ""), type: String(it.type || ""), window: String(it.window || ""),
      px: it.x | 0, py: it.y | 0, w: it.w | 0, h: it.h | 0, enabled: it.enabled !== false,
      x: w ? Math.max(0, Math.min(1, it.x / w)) : 0, y: h ? Math.max(0, Math.min(1, it.y / h)) : 0,
    }));
    return { items, source: res.source || (IS_WIN ? "ui-automation" : ""), focusedWindow: res.focusedWindow || "", note: res.note || "" };
  }
  captureWin(maxW, q) {
    return new Promise((resolve, reject) => {
      const h = this.ensureWinHelper();
      const t = setTimeout(() => { const i = this.helperQueue.indexOf(w); if (i >= 0) this.helperQueue.splice(i, 1); reject(new Error("Tangkap layar timeout (desktop tidak tersedia di sesi ini?)")); }, 8000);
      const w = { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => {
        clearTimeout(t);
        // "The handle is invalid" setelah helper gagal membuat ulang konteks: biasanya sesi tak
        // punya desktop aktif (terputus/terkunci/secure desktop). Beri pesan yang menuntun.
        if (e && /handle is invalid/i.test(String(e.message || e))) {
          this.refreshWinSession();
          e = new Error("Desktop tidak bisa ditangkap (handle layar tidak valid). Ini terjadi saat sesi Windows terputus/terkunci (mis. RDP ditutup) atau sedang di secure desktop (UAC). " +
            "Agar Remote Desktop jalan tanpa login RDP, siapkan auto-logon konsol: jalankan sebagai Administrator scripts\\windows-headless-desktop.ps1 (atau: vrcloud.ps1 headless).");
        }
        reject(e);
      } };
      this.helperQueue.push(w);
      try { h.stdin.write("frame " + (maxW | 0) + " " + (q | 0) + "\n"); } catch (e) { this.helperQueue.pop(); w.reject(e); }
    });
  }

  // ---------------------------------------------------------------- umum
  capture(maxW, q) {
    q = Math.max(20, Math.min(95, q | 0 || 60));
    if (IS_WIN) return this.captureWin(maxW, q);
    if (IS_MAC) return this.captureMac(maxW, q);
    return this.captureLinux(maxW, q);
  }
  // Pindahkan kursor ke piksel (px, py) sekarang juga. Satu lompatan, tanpa animasi:
  // SetCursorPos / xdotool mousemove / cliclick m: semuanya menempatkan kursor seketika.
  sendMove(px, py) {
    this.pointer = { x: px, y: py };
    if (IS_WIN) this.winSend("move " + px + " " + py);
    else if (IS_MAC) this.macInput(["m:" + px + "," + py]);
    else this.xdo(["mousemove", String(px), String(py)]);
  }
  // Panel Remote Desktop mengirim satu pesan per mousemove browser (ratusan per detik saat
  // mouse disapu). Menulis semuanya ke stdin helper membuat antrean panjang dan kursor
  // tertinggal beberapa detik di belakang pointer asli. Hanya posisi terakhir yang berarti,
  // jadi event digabung: kirim segera bila jendela MOVE_MIN_MS sudah lewat, selebihnya
  // simpan posisi terbaru dan kirim satu kali saat jendela berikutnya tiba.
  queueMove(px, py) {
    this._movePos = { x: px, y: py };
    const wait = MOVE_MIN_MS - (Date.now() - (this._moveAt || 0));
    if (wait <= 0) return this.flushMove();
    if (!this._moveTimer) {
      this._moveTimer = setTimeout(() => { this._moveTimer = null; this.flushMove(); }, wait);
      if (this._moveTimer.unref) this._moveTimer.unref();
    }
  }
  flushMove() {
    if (this._moveTimer) { clearTimeout(this._moveTimer); this._moveTimer = null; }
    const p = this._movePos;
    if (!p) return;
    this._movePos = null;
    this._moveAt = Date.now();
    this.sendMove(p.x, p.y);
  }
  // Posisi kursor terakhir yang diketahui, dalam piksel dan fraksi layar. Di Windows nilainya
  // dibaca ulang dari helper tangkap layar setiap frame; di platform lain dilacak dari
  // perintah yang dikirim (membaca posisi asli berarti satu proses xdotool tambahan per aksi).
  pointerAt() {
    const w = this.screen.w || 0, h = this.screen.h || 0;
    const p = this.pointer || { x: 0, y: 0 };
    return { px: p.x, py: p.y, x: w ? p.x / w : 0, y: h ? p.y / h : 0 };
  }

  // Event input dari klien: { t: move|down|up|wheel|key|text, x, y (fraksi 0..1), b (0 kiri,1 tengah,2 kanan), dy, code, down, text }
  input(ev) {
    if (!ev || typeof ev !== "object") return;
    const sx = this.screen.w || 0, sh = this.screen.h || 0;
    const px = Math.max(0, Math.min(sx - 1, Math.round((+ev.x || 0) * sx)));
    const py = Math.max(0, Math.min(sh - 1, Math.round((+ev.y || 0) * sh)));
    // Gerakan boleh digabung; klik tidak. Buang gerakan yang masih tertunda sebelum menekan
    // tombol, kalau tidak klik bisa mendahului perpindahan dan mendarat di tempat lama.
    if (ev.t === "move") return this.queueMove(px, py);
    if ((ev.t === "down" || ev.t === "up") && ev.x != null) { this._movePos = null; this._moveAt = Date.now(); this.pointer = { x: px, y: py }; }
    else if (this._movePos) this.flushMove();

    if (IS_WIN) {
      if (ev.t === "down" || ev.t === "up") { if (ev.x != null) this.winSend("move " + px + " " + py); this.winSend(ev.t + " " + (ev.b | 0)); }
      else if (ev.t === "wheel") this.winSend((ev.h ? "hwheel " : "wheel ") + (ev.dy > 0 ? -120 : 120) * Math.max(1, Math.min(5, Math.round(Math.abs(ev.dy) / 100) || 1)));
      else if (ev.t === "key") { const vk = VK[ev.code]; if (vk) this.winSend("key " + vk + " " + (ev.down ? "down" : "up")); }
      else if (ev.t === "text" && ev.text) this.winSend("text " + Buffer.from(String(ev.text).slice(0, 2000), "utf8").toString("base64"));
      return;
    }
    if (IS_MAC) {
      if (ev.t === "down") this.macInput([ev.b === 2 ? "rd:" + px + "," + py : "dd:" + px + "," + py]);
      else if (ev.t === "up") this.macInput([ev.b === 2 ? "ru:" + px + "," + py : "du:" + px + "," + py]);
      else if (ev.t === "key") { const k = ({ Enter: "return", Escape: "esc", Tab: "tab", Backspace: "delete", Delete: "fwd-delete", ArrowUp: "arrow-up", ArrowDown: "arrow-down", ArrowLeft: "arrow-left", ArrowRight: "arrow-right", Space: "space", Home: "home", End: "end", PageUp: "page-up", PageDown: "page-down" })[ev.code]; if (k) { if (ev.down) this.macInput(["kp:" + k]); } else if (ev.down && /^Key[A-Z]$|^Digit\d$/.test(ev.code)) this.macInput(["t:" + ev.code.slice(-1).toLowerCase()]); }
      else if (ev.t === "text" && ev.text) this.macInput(["t:" + String(ev.text).slice(0, 500)]);
      else if (ev.t === "wheel") { try { spawn("osascript", ["-e", 'tell application "System Events" to scroll ' + (ev.dy > 0 ? "down" : "up")], { stdio: "ignore" }).on("error", () => {}); } catch (e) {} }
      return;
    }
    // Linux (xdotool)
    const btn = ev.b === 2 ? "3" : ev.b === 1 ? "2" : "1";
    if (ev.t === "down") { if (ev.x != null) this.xdo(["mousemove", String(px), String(py), "mousedown", btn]); else this.xdo(["mousedown", btn]); }
    else if (ev.t === "up") { if (ev.x != null) this.xdo(["mousemove", String(px), String(py), "mouseup", btn]); else this.xdo(["mouseup", btn]); }
    else if (ev.t === "wheel") { const n = Math.max(1, Math.min(5, Math.round(Math.abs(ev.dy) / 100) || 1)); const b = ev.h ? (ev.dy > 0 ? "7" : "6") : (ev.dy > 0 ? "5" : "4"); this.xdo(["click", "--repeat", String(n), "--delay", "10", b]); }
    else if (ev.t === "key") { const k = XKEY[ev.code]; if (k) this.xdo([ev.down ? "keydown" : "keyup", k]); }
    else if (ev.t === "text" && ev.text) this.xdo(["type", "--delay", "5", "--", String(ev.text).slice(0, 2000)]);
  }

  // Seret dari satu titik ke titik lain (fraksi 0..1). Di Linux seluruh gerakan dikirim
  // sebagai SATU pemanggilan xdotool berantai: satu proses per langkah antara membuat
  // seretan tersendat dan memakan ratusan milidetik yang tidak perlu.
  async dragFrac(x0, y0, x1, y1) {
    const w = this.screen.w || 0, h = this.screen.h || 0;
    const toPx = (f, max) => Math.max(0, Math.min(max - 1, Math.round(f * max)));
    const ax = toPx(x0, w), ay = toPx(y0, h), bx = toPx(x1, w), by = toPx(y1, h);
    const steps = 10;
    if (!IS_WIN && !IS_MAC) {
      const args = ["mousemove", String(ax), String(ay), "mousedown", "1"];
      for (let i = 1; i <= steps; i++) {
        args.push("mousemove", String(Math.round(ax + (bx - ax) * i / steps)), String(Math.round(ay + (by - ay) * i / steps)));
      }
      args.push("mouseup", "1");
      this.xdo(args);
      this.pointer = { x: bx, y: by };
      return;
    }
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    this.sendMove(ax, ay); await pause(40);
    this.input({ t: "down", b: 0 }); await pause(40);
    for (let i = 1; i <= steps; i++) {
      this.sendMove(Math.round(ax + (bx - ax) * i / steps), Math.round(ay + (by - ay) * i / steps));
      await pause(12);
    }
    await pause(40);
    this.input({ t: "up", b: 0 });
  }

  // Ctrl+Alt+Del (Windows: SAS tidak bisa disuntikkan; kirim Ctrl+Shift+Esc sebagai gantinya), kombinasi tombol lain.
  combo(keys) {
    const list = Array.isArray(keys) ? keys : [];
    list.forEach((c) => this.input({ t: "key", code: c, down: true }));
    setTimeout(() => list.slice().reverse().forEach((c) => this.input({ t: "key", code: c, down: false })), 25);
  }

  // ---------------------------------------------------------------- Tool agent AI (lihat & kendalikan desktop)
  // Bentuk sama dengan customTools lain: { description, inputSchema, execute(args)->{content:[...]} }.
  // Semua koordinat memakai fraksi 0..1 dari lebar/tinggi layar agar lepas dari resolusi.
  tools() {
    const self = this;
    const okStatus = async () => {
      const s = self.status();
      if (!s.ok) throw new Error((s.reason || "Remote desktop is not available on this server.") + (s.canSetup ? " Call desktop_setup to install a virtual desktop (headless Linux)." : ""));
      if (!self.screen.w) await self.capture(320, 30); // screen size is only known after the first capture
      return s;
    };
    const settle = (ms) => new Promise((r) => setTimeout(r, ms || 250));
    const num = (v, d) => { const n = Number(v); return isFinite(n) ? n : d; };
    const clamp01 = (v, d) => Math.max(0, Math.min(1, num(v, d)));
    const fmt = (x, y) => "(" + x.toFixed(3) + ", " + y.toFixed(3) + ")";
    // Screenshot + short status line. detail=high captures at up to 1920px for reading small text.
    const shot = async (note, detail) => {
      const hi = detail === "high";
      const f = await self.capture(hi ? 1920 : 1280, hi ? 75 : 60);
      const sw = f.sw || self.screen.w || 0, sh = f.sh || self.screen.h || 0;
      // Posisi pointer dilaporkan sebagai angka, bukan hanya digambar sebagai panah: menebak
      // letak kursor dari JPEG adalah sumber utama klik meleset dan klik berulang.
      const p = self.pointerAt();
      const line = "Screen " + (sw || "?") + "x" + (sh || "?") + " px" + (note ? " \u2014 " + note : "") +
        ". Pointer is now at pixel (" + p.px + ", " + p.py + ") = fraction " + fmt(p.x, p.y) +
        "; the white arrow on the image has its TIP there. Coordinates are fractions of the screen: x = pixel_x / " + (sw || "width") + ", y = pixel_y / " + (sh || "height") + ".";
      const b64 = f.jpeg.toString("base64");
      self.rememberShot(self._shotCall, f.jpeg);
      return { content: [{ type: "text", text: line }, { type: "image", data: b64, mimeType: "image/jpeg" }] };
    };
    const XY = {
      x: { type: "number", description: "Horizontal position as a fraction 0..1 of the screen width (0 = left edge, 1 = right edge)" },
      y: { type: "number", description: "Vertical position as a fraction 0..1 of the screen height (0 = top edge, 1 = bottom edge)" },
    };
    // "down" sudah memindahkan kursor dalam perintah yang sama, jadi tidak perlu "move"
    // terpisah lebih dulu: kursor melompat langsung ke target lalu menekan.
    const pressAt = async (x, y, b) => {
      self.input({ t: "down", b, x, y }); await settle(25); self.input({ t: "up", b, x, y });
    };
    const defs = {
      desktop_screenshot: {
        description: Instructions.tool("desktop_screenshot"),
        inputSchema: { type: "object", properties: { detail: { type: "string", enum: ["normal", "high"], description: "high = up to 1920px wide for fine detail (costs more tokens)" } } },
        annotations: { title: "Desktop: screenshot", readOnlyHint: true },
        execute: async (a) => { await okStatus(); return shot("", a && a.detail); },
      },
      desktop_find: {
        description: Instructions.tool("desktop_find"),
        inputSchema: { type: "object", properties: {
          query: { type: "string", description: "Text to look for in element names (case-insensitive substring), e.g. \"Save\", \"OK\", \"File name\". Empty = list named elements of the focused window." },
          max: { type: "number", description: "Maximum matches, 1..60 (default 20)" },
        }, required: ["query"] },
        annotations: { title: "Desktop: find element", readOnlyHint: true },
        execute: async (a) => {
          await okStatus();
          const q = String(a.query == null ? "" : a.query);
          const res = await self.findElements(q, num(a.max, 20));
          const lines = res.items.map((it, i) => (i + 1) + ". [" + (it.type || "element") + "] \u201c" + it.name + "\u201d at " + fmt(it.x, it.y) +
            " (" + it.w + "x" + it.h + " px" + (it.enabled ? "" : ", disabled") + ")" + (it.window ? " in window \u201c" + it.window.slice(0, 60) + "\u201d" : ""));
          const head = (res.items.length ? res.items.length + " element(s) matching \u201c" + q + "\u201d" : "No visible element matches \u201c" + q + "\u201d") +
            (res.focusedWindow ? " \u2014 focused window: \u201c" + res.focusedWindow.slice(0, 80) + "\u201d" : "") + ".";
          const tips = res.items.length
            ? " Click one with desktop_click({ name: \"" + q + "\", index: N }) (N is the 1-based number above) or by its coordinates."
            : " Try a shorter or different word, make sure the right window is in front, or take desktop_screenshot and click by coordinates.";
          return { content: [{ type: "text", text: head + tips + (res.note ? "\nNote: " + res.note : "") + (lines.length ? "\n" + lines.join("\n") : "") }],
            structuredContent: { query: q, source: res.source, focusedWindow: res.focusedWindow, items: res.items } };
        },
      },
      desktop_click: {
        description: Instructions.tool("desktop_click"),
        inputSchema: { type: "object", properties: Object.assign({}, XY, {
          name: { type: "string", description: "Instead of x,y: click the visible element whose name contains this text (uses desktop_find)" },
          index: { type: "number", description: "With name: which match to click when several match, 1-based (default 1)" },
          button: { type: "string", enum: ["left", "right", "middle"] }, double: { type: "boolean" },
        }) },
        annotations: { title: "Desktop: click" },
        execute: async (a) => {
          await okStatus();
          const b = a.button === "right" ? 2 : a.button === "middle" ? 1 : 0;
          let x, y, label = "";
          if (a.name != null && String(a.name).trim() && (a.x == null || a.y == null)) {
            const q = String(a.name).trim();
            const idx = Math.max(1, Math.round(num(a.index, 1)));
            const res = await self.findElements(q, Math.max(idx, 10));
            const hit = res.items[idx - 1];
            if (!hit) {
              throw new Error("No visible element matching \u201c" + q + "\u201d" + (idx > 1 ? " at index " + idx : "") +
                (res.items.length ? " (" + res.items.length + " match(es) exist; use index 1.." + res.items.length + ")" : "") +
                ". Use desktop_find to see what is on screen, or desktop_screenshot and click by coordinates." + (res.note ? " " + res.note : ""));
            }
            x = hit.x; y = hit.y; label = " on [" + (hit.type || "element") + "] \u201c" + hit.name.slice(0, 60) + "\u201d";
          } else {
            if (a.x == null || a.y == null) throw new Error("desktop_click needs x and y (fractions 0..1) or name.");
            x = clamp01(a.x, 0.5); y = clamp01(a.y, 0.5);
          }
          await pressAt(x, y, b);
          if (a.double) { await settle(50); await pressAt(x, y, b); }
          await settle(UI_SETTLE_MS);
          return shot((a.double ? "double " : "") + (a.button || "left") + " click at " + fmt(x, y) + label);
        },
      },
      desktop_drag: {
        description: Instructions.tool("desktop_drag"),
        inputSchema: { type: "object", properties: Object.assign({}, XY, { to_x: { type: "number", description: "Destination x, fraction 0..1" }, to_y: { type: "number", description: "Destination y, fraction 0..1" } }), required: ["x", "y", "to_x", "to_y"] },
        annotations: { title: "Desktop: drag" },
        execute: async (a) => {
          await okStatus();
          const x0 = clamp01(a.x, 0.5), y0 = clamp01(a.y, 0.5), x1 = clamp01(a.to_x, x0), y1 = clamp01(a.to_y, y0);
          await self.dragFrac(x0, y0, x1, y1);
          await settle(UI_SETTLE_MS);
          return shot("dragged from " + fmt(x0, y0) + " to " + fmt(x1, y1));
        },
      },
      desktop_move: {
        description: Instructions.tool("desktop_move"),
        inputSchema: { type: "object", properties: XY, required: ["x", "y"] },
        annotations: { title: "Desktop: move" },
        execute: async (a) => { await okStatus(); const x = clamp01(a.x, 0.5), y = clamp01(a.y, 0.5); self.input({ t: "move", x, y }); self.flushMove(); await settle(UI_SETTLE_MS); return shot("cursor moved to " + fmt(x, y)); },
      },
      desktop_type: {
        description: Instructions.tool("desktop_type"),
        inputSchema: { type: "object", properties: { text: { type: "string", description: "Text to type (max 2000 chars per call)" } }, required: ["text"] },
        annotations: { title: "Desktop: type" },
        execute: async (a) => { await okStatus(); const text = String(a.text || ""); if (!text) throw new Error("text is empty"); self.input({ t: "text", text }); await settle(Math.min(1200, 150 + text.length * 5)); return shot("typed " + text.length + " characters"); },
      },
      desktop_key: {
        description: Instructions.tool("desktop_key"),
        inputSchema: { type: "object", properties: { keys: { type: "array", items: { type: "string" }, description: "KeyboardEvent.code values pressed together (max 6)" }, repeat: { type: "number", description: "Press the combination this many times (1..20, default 1)" } }, required: ["keys"] },
        annotations: { title: "Desktop: key" },
        execute: async (a) => {
          await okStatus();
          const keys = Array.isArray(a.keys) ? a.keys.map(String).filter(Boolean).slice(0, 6) : [];
          if (!keys.length) throw new Error("keys is empty");
          const n = Math.max(1, Math.min(20, Math.round(num(a.repeat, 1))));
          for (let i = 0; i < n; i++) { self.combo(keys); await settle(55); }
          await settle(UI_SETTLE_MS);
          return shot("pressed " + keys.join("+") + (n > 1 ? " x" + n : ""));
        },
      },
      desktop_scroll: {
        description: Instructions.tool("desktop_scroll"),
        inputSchema: { type: "object", properties: Object.assign({}, XY, { direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "number", description: "Wheel notches, 1..10 (default 3)" } }), required: ["direction"] },
        annotations: { title: "Desktop: scroll" },
        execute: async (a) => {
          await okStatus();
          if (a.x != null && a.y != null) { self.input({ t: "move", x: clamp01(a.x, 0.5), y: clamp01(a.y, 0.5) }); self.flushMove(); await settle(40); }
          const n = Math.max(1, Math.min(10, Math.round(num(a.amount, 3))));
          const dir = String(a.direction || "down");
          const horiz = dir === "left" || dir === "right";
          const sign = (dir === "down" || dir === "right") ? 1 : -1;
          // input() handles up to 5 notches per event; split larger amounts.
          for (let left = n; left > 0; left -= 5) { self.input({ t: "wheel", dy: sign * 100 * Math.min(5, left), h: horiz }); await settle(60); }
          await settle(UI_SETTLE_MS);
          return shot("scrolled " + dir + " x" + n);
        },
      },
      desktop_wait: {
        description: Instructions.tool("desktop_wait"),
        inputSchema: { type: "object", properties: { seconds: { type: "number", description: "Seconds to wait, 0.5..10 (default 2)" } } },
        annotations: { title: "Desktop: wait", readOnlyHint: true },
        execute: async (a) => { await okStatus(); const s = Math.max(0.5, Math.min(10, num(a.seconds, 2))); await settle(s * 1000); return shot("waited " + s + "s"); },
      },
      desktop_setup: {
        description: Instructions.tool("desktop_setup"),
        inputSchema: { type: "object", properties: {} },
        annotations: { title: "Desktop: setup" },
        execute: async () => {
          const st = self.status();
          if (!st.canSetup && st.ok) return { content: [{ type: "text", text: "A desktop is already available (" + process.platform + "); no setup needed. Use desktop_screenshot." }] };
          // Windows: masalah paling umum di server adalah sesi terputus (tak ada login RDP).
          // Beri instruksi konkret, bukan sekadar "hanya Linux".
          if (IS_WIN) {
            if (st.needsConsole || st.sessionState === "disconnected") {
              return { content: [{ type: "text", text:
                "The Windows session running VRCloud is disconnected, so there is no desktop to see or control (screenshots come back black and clicks go nowhere). " +
                "This is why remote desktop stops working when you are not logged in over RDP.\n\n" +
                "To make it work WITHOUT keeping an RDP session open, set up console auto-logon on the server (run elevated, once):\n" +
                "    powershell -ExecutionPolicy Bypass -File scripts\\windows-headless-desktop.ps1\n\n" +
                "It logs a chosen account into the physical console at boot, keeps it unlocked, and (optionally) redirects RDP back to the console on disconnect " +
                "so the desktop keeps rendering. After running it and rebooting, remote desktop and computer use work with no one logged in over RDP." } ] };
            }
            return { content: [{ type: "text", text: "A desktop is available (session " + (st.sessionState || "active") + "). Use desktop_screenshot. " +
              "If it ever stops working when you disconnect RDP, set up console auto-logon: scripts\\windows-headless-desktop.ps1 (run as Administrator)." } ] };
          }
          if (!st.canSetup) return { content: [{ type: "text", text: "Virtual desktop setup is only supported on Linux. " + (st.reason || "") }] };
          const s = self.startSetup();
          const head = s.running ? "Virtual desktop installation is running\u2026 call desktop_setup again to check progress.\n" : (s.ok ? "Installation finished. Take a desktop_screenshot to continue.\n" : (s.ok === false ? "Installation failed; see log below.\n" : ""));
          return { content: [{ type: "text", text: head + (s.log || []).slice(-10).join("\n") }] };
        },
      },
    };
    // Cursor SDK memanggil execute(args, { toolCallId }). Simpan screenshot per panggilan
    // karena event tool-nya sering tidak membawa byte gambar.
    Object.keys(defs).forEach((name) => {
      const fn = defs[name].execute;
      defs[name].execute = async (args, ctx) => {
        self._shotCall = (ctx && (ctx.toolCallId || ctx.callId)) || "";
        try { return await fn(args, ctx); }
        finally { self._shotCall = ""; }
      };
    });
    return defs;
  }

  // Kirim pesan JSON ke semua penonton (catatan status, mis. sesi desktop sedang dijalankan).
  notifyClients(obj) {
    const s = JSON.stringify(obj);
    this.clients.forEach((ws) => { if (ws.readyState === 1) { try { ws.send(s); } catch (e) {} } });
  }

  // ---------------------------------------------------------------- WebSocket /desktop
  attach(ws) {
    this.clients.add(ws);
    const send = (o) => { if (ws.readyState === 1) { try { ws.send(JSON.stringify(o)); } catch (e) {} } };
    let opts = { maxW: 1280, q: 55 };
    let loop = false, stopped = false, fails = 0;
    const pump = async () => {
      if (stopped || !loop || ws.readyState !== 1) return;
      if (this.busy) { setTimeout(pump, 40); return; }
      this.busy = true;
      const t0 = Date.now();
      try {
        const f = await this.capture(opts.maxW, opts.q);
        this.busy = false; fails = 0;
        if (stopped || ws.readyState !== 1) return;
        // Header 12 byte: sw,sh,fw,fh (uint16 x4) + cadangan 4 byte, lalu JPEG.
        const head = Buffer.alloc(12);
        head.writeUInt16LE(f.sw || 0, 0); head.writeUInt16LE(f.sh || 0, 2); head.writeUInt16LE(f.fw || 0, 4); head.writeUInt16LE(f.fh || 0, 6);
        head.writeUInt32LE(Date.now() - t0, 8);
        if (ws.bufferedAmount < 4 * 1024 * 1024) ws.send(Buffer.concat([head, f.jpeg]));
      } catch (e) {
        this.busy = false;
        // Kegagalan tunggal (GDI "handle is invalid", layar terkunci sesaat) wajar: coba lagi diam-diam;
        // baru laporkan ke klien bila gagal beruntun.
        fails++;
        if (fails >= 3) send({ t: "error", message: e.message || String(e) });
        setTimeout(pump, fails >= 3 ? 1500 : 250); return;
      }
      // Jeda adaptif: target ~8 fps, lebih lambat kalau penangkapan berat.
      const took = Date.now() - t0;
      setTimeout(pump, Math.max(30, Math.min(700, 120 - took)));
    };
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (!m || typeof m !== "object") return;
      if (m.t === "start") { opts.maxW = Math.max(320, Math.min(2560, m.maxW | 0 || 1280)); opts.q = Math.max(20, Math.min(95, m.q | 0 || 55)); if (!loop) { loop = true; pump(); } send({ t: "hello", platform: process.platform, screen: this.screen }); }
      else if (m.t === "stop") loop = false;
      else if (m.t === "opts") { if (m.maxW) opts.maxW = Math.max(320, Math.min(2560, m.maxW | 0)); if (m.q) opts.q = Math.max(20, Math.min(95, m.q | 0)); }
      else if (m.t === "combo") this.combo(m.keys);
      else if (m.t === "input") this.input(m.ev);
      else this.input(m);
    });
    const bye = () => { stopped = true; loop = false; this.clients.delete(ws); if (!this.clients.size) this.idle(); };
    ws.on("close", bye); ws.on("error", bye);
    send({ t: "status", status: this.status() });
  }
  idle() {
    // Tidak ada penonton: hentikan helper Windows setelah jeda agar tidak memakan CPU.
    setTimeout(() => {
      if (this.clients.size) return;
      [this.helper, this.winInput, this.winUia].forEach((h) => { if (h) { try { h.stdin.write("quit\n"); } catch (e) {} setTimeout(() => { try { h.kill(); } catch (e) {} }, 500); } });
      this.helper = null; this.winInput = null; this.winUia = null;
    }, 60000);
  }
}

module.exports = DesktopRemote;
