/*
 * VRCloud IDE - i18n (Bahasa Indonesia / English).
 *
 * UI ditulis campuran: label menu/tree berbahasa Inggris, sisanya Indonesia.
 * Modul ini menerjemahkan teks UI ke bahasa pilihan (Preferences → Language)
 * dengan dua kamus: ID→EN untuk string yang ditulis dalam bahasa Indonesia, dan
 * EN→ID untuk string yang ditulis dalam bahasa Inggris. Teks DOM (node teks,
 * title, placeholder) diterjemahkan saat dimuat dan saat elemen baru ditambah
 * (MutationObserver); konten pengguna (editor, terminal, isi chat, nama file)
 * tidak disentuh. Kode lain bisa memanggil window.I18N.t(str) untuk string yang
 * tidak lewat DOM (alert/confirm).
 */
(function () {
  "use strict";
  var KEY = "vrcloud_lang";
  var lang = (function () { try { var v = localStorage.getItem(KEY); return v === "en" ? "en" : "id"; } catch (e) { return "id"; } })();

  // ----------------------------------------------------------- ID -> EN
  var ID_EN = {
    // menubar / umum
    "Sistem operasi server · status realtime": "Server operating system · realtime status",
    "Pemakaian server (klik untuk spesifikasi)": "Server usage (click for specifications)",
    "Pemakaian server saat ini — klik untuk spesifikasi lengkap": "Current server usage — click for full specifications",
    "Preferences": "Preferences", "Logout": "Logout",
    "Opsi": "Options", "Refresh": "Refresh",
    "Buka file, Git, dan pencarian": "Open files, Git, and search",
    "File, Edit, Find, dan menu lain": "File, Edit, Find, and other menus",
    "Navigasi": "Navigation", "Tampilkan editor": "Show editor", "Tampilkan terminal": "Show terminal",
    "Buka panel Agent": "Open Agent panel", "Menu": "Menu",
    "Lepas file di sini untuk upload": "Drop files here to upload",
    "Cari di workspace": "Search in workspace", "Ketik teks lalu Enter…": "Type text, then Enter…", "Cari": "Search",
    "mencari…": "searching…", "tidak ada hasil": "no results",
    "Input": "Input", "Batal": "Cancel", "OK": "OK",
    "Server:": "Server:", "Memuat…": "Loading…", "Gagal memuat info server.": "Failed to load server info.",
    "Mendukung Linux (systemd + tmux) dan Windows 10/11 (Scheduled Task + ConPTY). Minimum Node.js 22.13; git untuk checkpoint AI. Rincian: README → Specifications & Platform Support.":
      "Supports Linux (systemd + tmux) and Windows 10/11 (Scheduled Task + ConPTY). Minimum Node.js 22.13; git for AI checkpoints. Details: README → Specifications & Platform Support.",
    "Bahasa / Language:": "Language:", "Bahasa Indonesia": "Bahasa Indonesia", "English": "English",
    "Versi:": "Version:", "Version": "Version",
    "Berlaku untuk seluruh antarmuka (menu, panel AI, status bar). Nama file, isi editor, terminal, dan balasan agent tidak diterjemahkan.":
      "Applies to the whole interface (menus, AI panel, status bar). File names, editor content, terminal output, and agent replies are not translated.",
    "Run File Terpilih (tree)": "Run Selected File (tree)", "Spesifikasi Server…": "Server Specifications…",
    "Terminal baru di panel ini": "New terminal in this pane",
    "Paste ke terminal (Ctrl+V di kotak ini):": "Paste into terminal (Ctrl+V in this box):",
    "Pilih teks terminal terlebih dahulu": "Select terminal text first", "Teks terminal disalin": "Terminal text copied",
    "Akses clipboard ditolak — gunakan Ctrl+V": "Clipboard access denied — use Ctrl+V",
    "Clipboard tidak tersedia di koneksi ini — gunakan Ctrl+V": "Clipboard unavailable on this connection — use Ctrl+V",
    "Perubahan belum disimpan. Tutup saja?": "Unsaved changes. Close anyway?",
    "Nama baru:": "New name:", "Nama file baru:": "New file name:", "Nama folder baru:": "New folder name:",
    "Buka": "Open", "Hapus dari Favorites": "Remove from Favorites",
    "Buka & pilih file dulu untuk di-Run.": "Open and select a file first to run it.",
    "Buka file (path relatif):": "Open file (relative path):", "Go To Line (nomor baris):": "Go To Line (line number):",
    "Nomor baris tidak valid.": "Invalid line number.", "Ctrl+G: pilih tab file terlebih dahulu": "Ctrl+G: select a file tab first",
    "File biner tidak bisa ditampilkan di editor.": "Binary files cannot be shown in the editor.",
    "semua tersimpan": "all saved", "siap": "ready",
    "Perubahan disinkron ulang karena revision conflict": "Changes re-synced due to a revision conflict",
    "Sistem": "System", "Node.js": "Node.js", "Terminal": "Terminal", "Shell": "Shell", "Arsip ZIP/TAR": "ZIP/TAR archives",
    "Pencarian": "Search", "git / checkpoint AI": "git / AI checkpoints", "Agent AI": "AI Agent", "Perangkat": "Hardware", "Workspace": "Workspace",
    "tersedia": "available", "tidak tersedia": "unavailable", "tidak terdeteksi": "not detected", "aktif": "active",
    "nonaktif (API key belum diisi)": "disabled (API key not set)", "git tidak ditemukan": "git not found",
    "git ada, checkpoint nonaktif": "git present, checkpoints disabled", "bawaan Node (rg tidak ada)": "built-in Node (rg missing)",
    "ConPTY — restart bersama server": "ConPTY — restarts with the server", "tmux — persisten melewati restart": "tmux — persists across restarts",
    "PTY langsung — tidak persisten (tmux tidak ada)": "Direct PTY — not persistent (tmux missing)",
    // status bar
    "File aktif": "Active file", "Posisi kursor — klik: ke baris (Ctrl+G)": "Cursor position — click: go to line (Ctrl+G)",
    "Agent AI — klik untuk membuka panel": "AI Agent — click to open the panel", "Pemakaian token percakapan aktif": "Token usage of the active conversation",
    "Terminal — klik untuk fokus": "Terminal — click to focus", "Browser terhubung ke sesi ini": "Browsers connected to this session",
    "Hanya browser ini yang terhubung": "Only this browser is connected",
    "Bahasa file — klik untuk mengganti": "File language — click to change", "Indentasi — klik untuk mengganti": "Indentation — click to change",
    "Akhir baris — klik untuk mengganti LF/CRLF": "Line ending — click to switch LF/CRLF", "Encoding": "Encoding",
    "Notifikasi agent": "Agent notifications", "Notifikasi agent (tidak ada yang baru)": "Agent notifications (nothing new)",
    "Agent": "Agent", "Agent siap": "Agent ready", "Agent nonaktif": "Agent disabled", "Agent: menunggu izin": "Agent: awaiting approval",
    "Agent sedang bekerja": "Agent is working", "AI belum dikonfigurasi — klik untuk membuka setelan": "AI not configured — click to open settings",
    "Perintah berisiko menunggu persetujuan Anda — klik untuk melihat": "A risky command awaits your approval — click to view",
    "Terminal aktif": "Active terminal", "Terminal terakhir": "Last terminal", "klik untuk fokus": "click to focus",
    "tersambung": "connected", "menyambung…": "connecting…",
    "Run (simpan lalu jalankan file aktif)": "Run (save, then run the active file)",
    "Deteksi dari isi file": "Detect from file content", "Tab (lebar 4)": "Tab (width 4)", "Tab (lebar 8)": "Tab (width 8)",
    "LF (Unix / Linux / macOS)": "LF (Unix / Linux / macOS)", "CRLF (Windows)": "CRLF (Windows)",
    "Plain Text": "Plain Text",
    // panel AI: header, composer
    "AI Chat (Alt+A)": "AI Chat (Alt+A)", "Riwayat chat": "Chat history", "Chat baru": "New chat", "Setelan API": "API settings", "Tutup": "Close",
    "Tambah konteks (seleksi editor, output terminal, file, gambar)": "Add context (editor selection, terminal output, file, image)",
    "Pengaturan model": "Model settings", "pilih model": "choose model",
    "Skills agent: pakai skill untuk pesan ini, atau buat/kelola skill (.vrcloud-agent/skills). Ketik / di composer untuk memilih cepat.":
      "Agent skills: use a skill for this message, or create/manage skills (.vrcloud-agent/skills). Type / in the composer to pick quickly.",
    "Dikte suara (Bahasa Indonesia)": "Voice dictation", "Dikte tidak tersedia di browser ini.": "Dictation is not available in this browser.",
    "Mendengarkan… klik lagi untuk berhenti.": "Listening… click again to stop.",
    "Kirim (Enter)": "Send (Enter)", "Stop": "Stop", "Tambahkan ke antrean (dikirim setelah agent selesai)": "Add to queue (sent after the agent finishes)",
    "Beri tugas atau tanya apa saja…": "Give a task or ask anything…",
    "Agent sedang bekerja… ketik pesan berikutnya untuk diantrekan": "Agent is working… type the next message to queue it",
    "Tanya tentang kode (mode Ask: tidak mengubah apa pun)…": "Ask about the code (Ask mode: changes nothing)…",
    "Jelaskan tugas — agent hanya menyusun rencana…": "Describe the task — the agent only drafts a plan…",
    "Lepas file untuk dilampirkan ke chat": "Drop files to attach them to the chat", "Hapus lampiran": "Remove attachment", "Batalkan": "Cancel",
    "Beri tugas — agent menyusun rencana, mengedit file, menjalankan perintah, dan menyelesaikannya sendiri.":
      "Give a task — the agent plans, edits files, runs commands, and finishes it on its own.",
    "Kirim dengan": "Send with", "· baris baru": "· new line", "· buka/tutup": "· open/close", "· seret file ke sini untuk melampirkan": "· drag files here to attach",
    "Geser tab file / terminal ke tepi panel ini untuk split.": "Drag a file / terminal tab to the edge of this pane to split.",
    "File baru": "New file", "Buka file": "Open file", "Terminal baru": "New terminal", "Tanya VRCloud AI": "Ask VRCloud AI",
    "Buka file dari panel kiri, atau mulai dari sini.": "Open a file from the left panel, or start here.",
    "Palet perintah": "Command palette", "Cari di workspace": "Search in workspace", "Source control": "Source control", "Ke baris": "Go to line", "Simpan": "Save",
    "Klik untuk sembunyikan / tampilkan": "Click to hide / show",
    "Menyiapkan workspace…": "Preparing workspace…", "Menyambung ke server…": "Connecting to server…",
    "Notifikasi": "Notifications", "Tandai dibaca": "Mark read", "Bersihkan": "Clear", "Belum ada notifikasi.": "No notifications yet.",
    "Izinkan notifikasi browser saat tab tidak aktif": "Allow browser notifications when the tab is inactive", "Izinkan": "Allow",
    "Notifikasi browser diizinkan": "Browser notifications allowed", "Anda akan diberi tahu saat agent selesai walau tab tidak aktif.": "You'll be notified when the agent finishes even if the tab is inactive.",
    "Notifikasi (tidak ada yang baru)": "Notifications (nothing new)", "baru saja": "just now", "mnt lalu": "min ago", "jam lalu": "h ago",
    "Update VRCloud tersedia": "VRCloud update available", "Koneksi realtime terputus": "Realtime connection lost", "Mencoba menyambung ulang…": "Reconnecting…",
    "Tersambung kembali": "Reconnected", "Sesi realtime aktif lagi.": "Realtime session is back.",
    "Agent selesai": "Agent finished", "Agent menunggu izin": "Agent awaiting approval", "Agent gagal": "Agent failed",
    "Klik untuk Remote Desktop": "Click for Remote Desktop", "Menghubungkan ke desktop server…": "Connecting to the server desktop…",
    "Kendali:": "Control:", "\u{1F5B1} Kendali:": "\u{1F5B1} Control:", "aktif": "on", "mati": "off", "Kualitas": "Quality", "Rendah": "Low", "Sedang": "Medium", "Tinggi": "High",
    "Kendali mouse/keyboard": "Mouse/keyboard control", "Kirim Ctrl+Alt+Del": "Send Ctrl+Alt+Del", "Papan ketik: fokus di sini lalu ketik": "Keyboard: focus here, then type",
    "Menghubungkan ke desktop server…": "Connecting to the server desktop…", "Remote desktop tidak tersedia.": "Remote desktop is not available.", "Kendali diblokir.": "Control is blocked.", "Kendali diblokir": "Control is blocked", "Kendali diblokir antivirus.": "Control is blocked by antivirus.",
    "Pasang desktop virtual (Xvfb + XFCE) agar bisa dikontrol dari sini.": "Install a virtual desktop (Xvfb + XFCE) so it can be controlled from here.",
    "Sesi desktop belum berjalan; akan dijalankan saat dibuka.": "The desktop session is not running yet; it starts when opened.", "Display hidup tetapi tidak ada window manager (pasang xfce4).": "The display is up but there is no window manager (install xfce4).",
    "Desktop virtual (:99) akan dijalankan saat dibuka.": "The virtual desktop (:99) starts when opened.", "Server ini tidak punya desktop. Pasang desktop virtual (Xvfb + XFCE) untuk mengendalikannya dari sini.": "This server has no desktop. Install a virtual desktop (Xvfb + XFCE) to control it from here.",
    "Butuh ImageMagick (import) atau scrot, dan xdotool.": "Needs ImageMagick (import) or scrot, and xdotool.", "Tidak ada desktop. Pasang desktop virtual dulu.": "No desktop. Install the virtual desktop first.", "Xvfb tidak mau berjalan.": "Xvfb would not start.",
    "Pasang desktop virtual": "Install virtual desktop", "Server ini belum punya desktop.": "This server has no desktop yet.",
    "Koneksi desktop terputus.": "Desktop connection lost.", "Menunggu frame…": "Waiting for frames…",
    "aktif · pengaman perintah aktif": "enabled · command guard on", "Pola bawaan aktif": "Default patterns active",
    "AI Chat belum aktif.": "AI Chat is not enabled.", "AI belum aktif.": "AI is not enabled.", "⚙ Atur API key di sini": "⚙ Set the API key here", "Atur API key": "Set API key",
    "Seleksi di editor": "Editor selection", "File yang sedang dibuka": "Currently open file", "Output terminal (200 baris)": "Terminal output (200 lines)",
    "Gambar / file dari komputer": "Image / file from computer",
    "Tidak ada teks terpilih di editor.": "No text selected in the editor.", "Tidak ada file yang dibuka.": "No file is open.",
    "Tidak ada terminal aktif — buka terminal dulu.": "No active terminal — open one first.", "Terminal kosong atau tidak ada.": "Terminal is empty or missing.",
    "Gambar terlalu besar (maks 2MB).": "Image too large (max 2MB).", "Maksimal 4 gambar.": "At most 4 images.",
    "file biner, tidak dilampirkan": "binary file, not attached", "terlalu besar, dilewati": "too large, skipped", "gagal dibaca": "unreadable",
    "Lampirkan seluruh file yang dibuka": "Attach the whole open file", "Tambahkan seleksi ke chat": "Add selection to chat", "Tambahkan file ke chat": "Add file to chat",
    "Pilih kode dulu": "Select code first",
    "Jelaskan kode ini": "Explain this code", "Perbaiki masalah di kode ini": "Fix problems in this code", "Tulis test untuk kode ini": "Write tests for this code",
    "Refactor / rapikan": "Refactor / clean up", "Tambahkan komentar/dokumentasi": "Add comments/documentation",
    // pesan & kartu
    "Assistant": "Assistant", "Berpikir…": "Thinking…", "Berpikir": "Thinking", "Rencana": "Plan", "Rencana kerja": "Work plan", "Perubahan": "Changes",
    "Diff": "Diff", "Lihat diff": "View diff", "Memuat diff…": "Loading diff…", "(tidak ada perbedaan)": "(no differences)",
    "Kembalikan file ini ke sebelum pesan": "Restore this file to before the message", "↶ Kembalikan semua": "↶ Restore all", "Terima semua": "Accept all",
    "Tolak semua": "Reject all", "Terima": "Accept", "Pulihkan": "Restore", "Tinjau perubahan": "Review changes",
    "Tandai semua file sudah ditinjau": "Mark all files as reviewed", "Kembalikan semua file ke sebelum pesan ini": "Restore all files to before this message",
    "Terima perubahan file ini": "Accept this file's changes", "Tolak dan kembalikan file ke sebelum pesan": "Reject and restore the file to before the message",
    "Kembalikan versi agent": "Restore the agent's version", "Diterima": "Accepted",
    "Mode review ON — terima atau tolak perubahan agent per file. Klik untuk mematikan.":
      "Review mode ON — accept or reject the agent's file changes. Click to turn off.",
    "Mode review OFF — perubahan agent langsung diterapkan (tetap bisa dikembalikan). Klik untuk mengaktifkan.":
      "Review mode OFF — agent changes are applied immediately (you can still restore). Click to turn on.",
    "Tandai sudah ditinjau dan lipat kartu": "Mark as reviewed and collapse the card", "↶ Kembalikan ke sebelum pesan ini": "↶ Restore to before this message",
    "Folder kerja ini belum repositori Git.": "This workspace is not a Git repository.",
    "Inisialisasi repositori": "Initialize repository", "Git tidak ditemukan di server.": "Git was not found on the server.",
    "Ganti branch": "Switch branch", "Branch baru": "New branch", "Nama branch baru:": "New branch name:",
    "Pesan commit": "Commit message", "Siap di-commit": "Ready to commit", "Stage file dulu": "Stage files first",
    "Tidak ada yang di-stage": "Nothing staged", "Tidak ada perubahan": "No changes",
    "Buang semua perubahan yang belum di-stage?": "Discard all unstaged changes?",
    "Commit terakhir": "Recent commits", "Memuat diff…": "Loading diff…",
    "Pindah ke branch ": "Switch to branch ", "Buang perubahan pada ": "Discard changes in ",
    "Perubahan setelah titik itu (oleh agent maupun Anda) akan ditimpa.": "Changes after that point (by the agent or you) will be overwritten.",
    "Perintah berisiko — perlu izin Anda": "Risky command — needs your approval", "Diizinkan": "Allowed", "Ditolak": "Denied",
    "Waktu habis — ditolak": "Timed out — denied", "Dibatalkan": "Cancelled", "Izinkan": "Allow", "Tolak": "Deny",
    "ditolak": "denied", "tidak selesai": "unfinished", "gagal": "failed", "sedang berjalan": "running", "tidak ada perubahan": "no changes",
    "Jalankan perintah ini di terminal IDE": "Run this command in the IDE terminal", "Dikirim ke terminal IDE.": "Sent to the IDE terminal.",
    "▶ Jalankan": "▶ Run", "▶ Pratinjau": "▶ Preview", "Mendeteksi runner…": "Detecting runners…",
    "Menjalankan": "Running", "Mengedit": "Editing", "Menulis": "Writing", "Menghapus": "Deleting", "Membaca": "Reading", "Melihat": "Listing",
    "Mencari": "Searching", "Mengambil": "Fetching", "Menelusuri web": "Searching the web", "Cek lint": "Lint check", "Todo": "Todo",
    "Membuat gambar": "Generating image", "Subagent": "Subagent", "Alat": "Tool",
    "Salin kode": "Copy code", "Copy": "Copy", "Copied": "Copied",
    "Background shell": "Background shell", "berjalan": "running", "latar belakang": "background",
    "Hentikan semua proses ini": "Stop all of these processes", "Hentikan proses ": "Stop process ", "Gagal menghentikan: ": "Failed to stop: ",
    "Lihat di tab Agent shell (view-only)": "Show in the Agent shell tab (view-only)",
    "Tidak bisa membuka Agent shell (layout belum siap).": "Cannot open Agent shell (layout not ready yet).",
    "Mode seluler — hanya chat AI Agent. Buka di desktop untuk IDE lengkap (editor, terminal, file).": "Mobile mode — AI Agent chat only. Open on desktop for the full IDE (editor, terminal, files).",
    "terminal berjalan": "running terminal(s)", "terminal agent": "agent terminal(s)",
    "Agent shell — hanya tampilan (perintah dijalankan oleh agent AI)": "Agent shell — view only (commands are run by the AI agent)",
    "Minimap — klik/seret untuk menggulir": "Minimap — click/drag to scroll", "Minimap": "Minimap",
    // kartu browser agent
    "Membuka": "Opening", "Klik": "Click", "Mengetik": "Typing", "Tekan tombol": "Press key", "Menggulir": "Scrolling", "Screenshot": "Screenshot",
    "Membaca halaman": "Reading page", "Console browser": "Browser console", "Network browser": "Browser network", "Menjalankan JS": "Running JS",
    "Menunggu": "Waiting", "Kembali": "Back", "Menutup browser": "Closing browser", "browser bekerja…": "browser working…",
    "Browser agent": "Agent browser", "Browser agent — tampilan live browser headless agent; tekan Ambil alih untuk mengendalikan sendiri": "Agent browser — live view of the agent's headless browser; press Take over to control it yourself",
    "Belum ada aktivitas browser dari agent.": "No browser activity from the agent yet.",
    "Minta agent membuka situs, mis. \"buka https://example.com dan rangkum\".": "Ask the agent to open a site, e.g. \"open https://example.com and summarize\".",
    "navigate": "navigate", "click": "click", "type": "type", "scroll": "scroll", "snapshot": "snapshot", "console": "console", "network": "network",
    "Tab": "Tab", "Daftar tab": "List tabs", "Pindah tab": "Switch tab", "Hover": "Hover", "Memilih": "Selecting", "Mengunggah": "Uploading", "Menyeret": "Dragging", "Mengekstrak": "Extracting", "Minta bantuan Anda": "Asking for your help",
    "Rahasia tersimpan": "Stored secrets", "Emulasi perangkat": "Device emulation", "Mengunduh": "Downloading", "Menyimpan PDF": "Saving PDF",
    "Menjelajah web": "Browsing the web", "Menjelajah web…": "Browsing the web…", "langkah": "steps", "Langkah ini tidak menghasilkan screenshot.": "This step produced no screenshot.",
    // Computer use (desktop_* tools): grouped card + step verbs + composer chip
    "Mengendalikan komputer": "Controlling the computer", "Mengendalikan komputer…": "Controlling the computer…", "Screenshot layar": "Screen capture", "Geser kursor": "Move cursor",
    "Menunggu UI": "Waiting for UI", "Menyiapkan desktop": "Setting up desktop", "Remote desktop": "Remote desktop",
    "Computer use": "Computer use", "Computer use: Auto (agent memutuskan), On (utamakan GUI desktop untuk tugas aplikasi/jendela), Off (tool desktop dimatikan)": "Computer use: Auto (agent decides), On (prefer the desktop GUI for app/window tasks), Off (desktop tools disabled)",
    "Computer use: Auto (agent memutuskan), On (utamakan GUI desktop), Off (dimatikan)": "Computer use: Auto (agent decides), On (prefer the desktop GUI), Off (disabled)",
    "Auto — agent mengendalikan desktop bila tugas membutuhkan GUI": "Auto — the agent controls the desktop when the task needs a GUI", "On — utamakan GUI desktop untuk tugas aplikasi/jendela": "On — prefer the desktop GUI for app/window tasks", "Off — tool desktop (computer use) dimatikan": "Off — desktop tools (computer use) disabled",
    "Remote desktop tidak tersedia di server ini — di Linux tanpa GUI, buka Remote Desktop (klik badge OS di menubar) untuk memasang desktop virtual.": "Remote desktop is not available on this server — on headless Linux, open Remote Desktop (click the OS badge in the menubar) to install a virtual desktop.",
    "CAPTCHA / verifikasi manusia": "CAPTCHA / human verification", "Halaman login": "Login page", "terdeteksi.": "detected.", "Ambil alih di tab Browser agent": "Take over in the Agent browser tab",
    "Ambil alih": "Take over", "Kembalikan ke agent": "Hand back to agent", "Selesai, kembalikan ke agent": "Done, hand back to agent", "Mode ambil alih: klik & ketik langsung di gambar": "Take-over mode: click & type directly on the image",
    "Agent membutuhkan bantuan Anda di browser.": "The agent needs your help in the browser.", "Agent minta bantuan di browser": "Agent asks for help in the browser",
    "Maju": "Forward", "Muat ulang": "Reload", "Tutup tab": "Close tab", "Tab baru": "New tab", "Live": "Live",
    "Browser tools": "Browser tools",
    "Mode agent: Agent (rencanakan & kerjakan), Plan (hanya rencana), Ask (baca-saja)": "Agent mode: Agent (plan & execute), Plan (plan only), Ask (read-only)",
    "Browser tools: Auto (agent memutuskan), On (utamakan browser untuk tugas web), Off (dimatikan)": "Browser tools: Auto (agent decides), On (prefer the browser for web tasks), Off (disabled)", "Auto — agent memakai browser bila tugas membutuhkan": "Auto — the agent uses the browser when the task needs it",
    "On — utamakan browser untuk semua tugas web": "On — prefer the browser for every web task", "Off — tool browser dimatikan": "Off — browser tools disabled",
    "browser tidak ada": "no browser", "Browser Chrome/Edge/Chromium tidak ditemukan di server — pasang atau unduh lewat Preferences → Server.": "No Chrome/Edge/Chromium found on the server — install one or download it via Preferences → Server.",
    "Pane agent": "Agent pane", "Tab Agent shell dan Browser agent muncul di sini, terpisah dari tab Anda.": "Agent shell and Agent browser tabs appear here, separate from your tabs.",
    "Pane agent AI — tab Agent shell & Browser agent. Tab file/terminal Anda tidak ditaruh di sini.": "AI agent pane — Agent shell & Agent browser tabs. Your file/terminal tabs are never placed here.",
    "Pane agent hanya untuk tab agent — jatuhkan di pane lain": "The agent pane only holds agent tabs — drop it in another pane",
    "Tab agent": "Agent tab", "Tab Anda": "Your tab", "Tab baru milik Anda (terpisah dari tab agent)": "New tab of your own (separate from the agent's tabs)",
    "Tab agent — dikendalikan AI": "Agent tab — controlled by the AI", "Tab agent (sedang dipakai AI) — klik untuk melihat / membantu": "Agent tab (in use by the AI) — click to watch / help",
    "Tab Anda — tidak disentuh agent": "Your tab — the agent never touches it",
    "Tab ini dikendalikan agent. Tekan Ambil alih untuk membantu (login/CAPTCHA), atau + untuk tab Anda sendiri.": "This tab is controlled by the agent. Press Take over to help (login/CAPTCHA), or + for a tab of your own.",
    "Tab Anda — agent tidak melihat atau menyentuhnya.": "Your tab — the agent cannot see or touch it.",
    "Minta agent membuka situs, mis. \"buka https://example.com dan rangkum\". Tekan + untuk membuka tab Anda sendiri — terpisah dari tab agent.": "Ask the agent to open a site, e.g. \"open https://example.com and summarize\". Press + to open a tab of your own — separate from the agent's tabs.",
    "Unduh Chromium (Chrome for Testing)": "Download Chromium (Chrome for Testing)", "Unduh Chrome for Testing (cadangan)": "Download Chrome for Testing (fallback)",
    "Menyiapkan…": "Preparing…", "Mencari versi stabil…": "Looking up the stable version…", "Mengekstrak…": "Extracting…",
    "Rahasia browser agent": "Agent browser secrets", "Belum ada rahasia tersimpan.": "No secrets stored yet.", "Hapus": "Delete", "nilai": "value", "Isi nama dan nilai.": "Enter a name and a value.",
    "Kata sandi/token yang bisa diketik agent ke formulir web lewat browser_type({ secret: nama }). Disimpan terenkripsi (AES-256-GCM) di server; agent hanya melihat namanya, nilainya tidak pernah masuk percakapan.": "Passwords/tokens the agent can type into web forms via browser_type({ secret: name }). Stored encrypted (AES-256-GCM) on the server; the agent only sees the name, the value never enters the conversation.",
    // riwayat
    "Cari percakapan…": "Search conversations…", "+ Chat baru": "+ New chat", "Belum ada chat.": "No chats yet.", "Tidak ada yang cocok.": "No matches.",
    "Ubah nama": "Rename", "Ekspor Markdown": "Export Markdown", "Hapus chat": "Delete chat", "Nama percakapan:": "Conversation name:",
    "baru saja": "just now",
    // popover model
    "Model": "Model", "Mode": "Mode", "Agent — rencanakan & kerjakan": "Agent — plan & execute", "Plan — hanya susun rencana": "Plan — only draft a plan",
    "Ask — baca-saja, tanpa edit/shell": "Ask — read-only, no edit/shell", "Gagal memuat (cek API key)": "Failed to load (check API key)",
    // setelan
    "API Key": "API Key", "Cursor API Key": "Cursor API Key", "cursor_… (kosongkan = tidak diubah)": "cursor_… (leave empty = unchanged)",
    "Provider & API Key": "Provider & API Key", "Provider AI": "AI provider", "Anthropic API Key": "Anthropic API Key",
    "↻ Muat model": "↻ Load models", "Memuat model…": "Loading models…", "Pengaturan Agent": "Agent settings",
    "Prompt caching": "Prompt caching", "Aktifkan prompt caching": "Enable prompt caching",
    "Aktifkan memori proyek": "Enable project memory",
    "Salin": "Copy", "Tersalin": "Copied", "Salin jawaban": "Copy reply",
    "Memori aktif: disisipkan ke setiap run.": "Memory on: included in every run.",
    "Memori nonaktif: agent tidak membaca atau menulis memory.md.": "Memory off: the agent does not read or write memory.md.",
    "⟳ Update": "⟳ Update", "Update tersedia": "Update available", "Cek update VRCloud": "Check for VRCloud updates", "Update VRCloud sekarang": "Update VRCloud now",
    "sk-ant-… (kosongkan = tidak diubah)": "sk-ant-… (leave empty = unchanged)",
    "Cursor (Cursor SDK)": "Cursor (Cursor SDK)", "Anthropic Claude (API key Anthropic)": "Anthropic Claude (Anthropic API key)",
    "Simpan": "Save", "Hapus key": "Remove key", "Masukkan API key lalu Simpan.": "Enter the API key, then Save.",
    "Key disimpan di server (data/ai-config.json) dan menimpa .env. Pilih model & opsi (Thinking/Effort/Context) lewat tombol model di bawah composer.":
      "The key is stored on the server (data/ai-config.json) and overrides .env. Choose the model & options (Thinking/Effort/Context) via the model button below the composer.",
    "Key disimpan di server (data/ai-config.json) dan menimpa .env (CURSOR_API_KEY / ANTHROPIC_API_KEY). Pilih model & opsi (Thinking/Effort/Context) lewat tombol model di bawah composer. Provider Anthropic memakai Claude langsung dengan tool workspace bawaan (baca/edit file, shell, pencarian, browser).":
      "The key is stored on the server (data/ai-config.json) and overrides .env (CURSOR_API_KEY / ANTHROPIC_API_KEY). Choose the model & options (Thinking/Effort/Context) via the model button below the composer. The Anthropic provider runs Claude directly with built-in workspace tools (read/edit files, shell, search, browser).",
    "Status: modul @cursor/sdk belum terpasang di server.": "Status: the @cursor/sdk module is not installed on the server.",
    "Status: modul @cursor/sdk belum terpasang di server (pilih provider Anthropic Claude atau jalankan npm install).": "Status: the @cursor/sdk module is not installed on the server (choose the Anthropic Claude provider or run npm install).",
    "Pengaman perintah berbahaya": "Dangerous command guard",
    "Minta izin sebelum agent menjalankan perintah yang cocok pola di bawah": "Ask for approval before the agent runs commands matching the patterns below",
    "Pola (regex JavaScript, satu per baris, tidak peka huruf besar/kecil)": "Patterns (JavaScript regex, one per line, case-insensitive)",
    "Batas waktu menunggu izin (detik; lewat = ditolak)": "Approval timeout (seconds; expired = denied)",
    "Simpan pengaman": "Save guard", "Pola bawaan": "Default patterns",
    "Bekerja lewat hook Cursor beforeShellExecution (.vrcloud-agent/hooks.json di workspace). Perintah yang cocok ditahan sampai Anda klik Izinkan/Tolak di chat.":
      "Works through the Cursor beforeShellExecution hook (.vrcloud-agent/hooks.json in the workspace). Matching commands are held until you click Allow/Deny in the chat.",
    "Notifikasi & checkpoint": "Notifications & checkpoints",
    "Notifikasi browser saat agent selesai (bila tab tidak aktif)": "Browser notification when the agent finishes (if the tab is inactive)",
    "Jumlah balasan yang belum dilihat tampil di ikon bel status bar saat panel tertutup; tombol AI di menubar ikut berkedip.": "Unread reply count shows on the status-bar bell while the panel is closed; the AI button in the menubar also pulses.",
    "Checkpoint nonaktif: git tidak ditemukan di server": "Checkpoints disabled: git not found on the server",
    "Checkpoint aktif: workspace di-snapshot (shadow git di data/checkpoints.git) sebelum setiap pesan. Arahkan kursor ke pesan Anda untuk “Kembalikan”, atau klik ↶ di kartu edit untuk satu file.":
      "Checkpoints enabled: the workspace is snapshotted (shadow git in data/checkpoints.git) before every message. Hover your message for “Restore”, or click ↶ on an edit card for a single file.",
    "Verifikasi otomatis setelah edit": "Automatic verification after edits",
    "Perintah yang dijalankan agent setelah mengubah kode (kosongkan untuk nonaktif)": "Command the agent runs after changing code (leave empty to disable)",
    "Agent diinstruksikan menjalankan perintah ini setelah setiap perubahan kode dan memperbaiki sendiri bila gagal (maks 3 kali), lalu melaporkan hasilnya.":
      "The agent is instructed to run this command after every code change, fix failures itself (up to 3 times), and report the result.",
    // skills & rules
    "Skills": "Skills", "Rules": "Rules", "+ Rule baru": "+ New rule", "+ Skill baru": "+ New skill", "Skill baru": "New skill", "Rule baru": "New rule",
    "Pakai": "Use", "Pakai skill ini untuk pesan berikutnya": "Use this skill for the next message", "Hapus skill": "Delete skill", "Hapus rule": "Delete rule",
    "Klik untuk melihat/mengubah": "Click to view/edit", "otomatis": "auto", "selalu": "always", "sesuai deskripsi": "by description", "belum ada": "missing", "Buat": "Create",
    "Belum ada skill di workspace ini. Skill = SKILL.md berisi instruksi khusus (gaya commit, standar review, alur deploy, dsb.) yang dipakai agent saat relevan atau saat Anda memilihnya.":
      "No skills in this workspace yet. A skill is a SKILL.md with specific instructions (commit style, review standards, deploy flow, etc.) the agent uses when relevant or when you pick it.",
    "Belum ada skill yang cocok. Buat lewat tombol Skills.": "No matching skill. Create one via the Skills button.",
    "Belum ada rule di .vrcloud-agent/rules. Rule = instruksi yang berlaku otomatis (selalu, atau untuk file yang cocok globs) di semua percakapan.":
      "No rules in .vrcloud-agent/rules yet. A rule is an instruction applied automatically (always, or for files matching globs) in every conversation.",
    "Instruksi proyek yang selalu dimuat: gaya kode, bahasa, larangan, cara menjalankan/test.": "Project instructions always loaded: code style, language, restrictions, how to run/test.",
    "AGENTS.md di root workspace selalu dimuat agent di setiap percakapan baru.": "AGENTS.md at the workspace root is always loaded by the agent in every new conversation.",
    "Rules dimuat lewat settingSources “project”; perubahan berlaku untuk percakapan baru. Skill = dipilih per kebutuhan; Rule = selalu berlaku.":
      "Rules are loaded via settingSources “project”; changes apply to new conversations. Skill = picked on demand; Rule = always applies.",
    "Ketik / di composer untuk memilih skill cepat. Skill “otomatis” juga dipakai agent sendiri bila deskripsinya cocok (berlaku di percakapan baru).":
      "Type / in the composer to pick a skill quickly. “Auto” skills are also used by the agent itself when the description matches (applies to new conversations).",
    " Minta agent membuat skill…": " Ask the agent to create a skill…",
    "Nama (huruf kecil, angka, tanda hubung)": "Name (lowercase, digits, hyphens)", "mis. commit-message, review-api": "e.g. commit-message, review-api",
    "Nama file (.mdc)": "File name (.mdc)", "mis. gaya-kode, api-conventions": "e.g. code-style, api-conventions",
    "Deskripsi — apa yang dilakukan & KAPAN dipakai (dibaca agent untuk memutuskan)": "Description — what it does & WHEN to use it (read by the agent to decide)",
    "Deskripsi — kapan rule ini relevan (dipakai agent bila tidak 'selalu')": "Description — when this rule is relevant (used by the agent if not 'always')",
    "Globs (opsional) — rule berlaku untuk file yang cocok, mis. src/**/*.ts": "Globs (optional) — the rule applies to matching files, e.g. src/**/*.ts",
    "Boleh dipakai agent secara otomatis bila relevan (tanpa dipilih lewat /)": "May be used automatically by the agent when relevant (without picking via /)",
    "Selalu berlaku (alwaysApply) untuk semua percakapan": "Always applies (alwaysApply) to every conversation",
    "Instruksi (Markdown) — langkah, aturan, contoh; ringkas": "Instructions (Markdown) — steps, rules, examples; concise",
    "Isi rule (Markdown)": "Rule content (Markdown)", "Isi AGENTS.md (Markdown)": "AGENTS.md content (Markdown)",
    "Simpan skill": "Save skill", "Simpan rule": "Save rule", "Simpan & pakai": "Save & use", "Menyimpan…": "Saving…",
    "Disimpan sebagai .vrcloud-agent/skills/<nama>/SKILL.md di workspace (ikut repo bila di-commit). File pendukung (reference.md, scripts/) bisa ditambah lewat file tree.":
      "Saved as .vrcloud-agent/skills/<name>/SKILL.md in the workspace (part of the repo if committed). Supporting files (reference.md, scripts/) can be added via the file tree.",
    "Disimpan sebagai .vrcloud-agent/rules/<nama>.mdc dengan frontmatter description/globs/alwaysApply.": "Saved as .vrcloud-agent/rules/<name>.mdc with description/globs/alwaysApply frontmatter.",
    "Tulis permintaan yang mau dikerjakan dengan skill ini.": "Write the request to be handled with this skill.",
    "Menulis pesan commit gaya Conventional Commits. Dipakai saat pengguna minta commit message.": "Writes Conventional Commits style messages. Used when the user asks for a commit message.",
    "(tanpa deskripsi)": "(no description)", "(tidak ada)": "(none)",
    "Enter ↵ · @file · /skill": "Enter ↵ · @file · /skill",
  };

  // ----------------------------------------------------------- EN -> ID
  var EN_ID = {
    "File": "File", "Edit": "Edit", "Find": "Cari", "View": "Tampilan", "Run": "Jalankan", "Tools": "Alat", "Window": "Jendela",
    "Files": "Berkas", "Editor": "Editor", "Menu": "Menu", "Navigation": "Navigasi",
    "Preferences": "Preferensi", "⚙ Preferences": "⚙ Preferensi", "Logout": "Keluar", "▶ Run": "▶ Jalankan", "Workspace": "Workspace", "Navigate": "Navigasi", "Search": "Cari",
    "OPEN FILES": "FILE TERBUKA", "FAVORITES": "FAVORIT", "WORKSPACE": "WORKSPACE",
    "Language:": "Bahasa:", "Version:": "Versi:",
    "New File": "File Baru", "New Folder": "Folder Baru", "Save": "Simpan", "Save All": "Simpan Semua", "Upload Local Files…": "Unggah File Lokal…",
    "Download Project": "Unduh Proyek", "Close Tab": "Tutup Tab", "Close All Tabs": "Tutup Semua Tab",
    "Undo": "Urungkan", "Redo": "Ulangi", "Cut": "Potong", "Copy": "Salin", "Paste": "Tempel", "Select All": "Pilih Semua", "Clear": "Bersihkan",
    "To Upper Case": "Jadikan Huruf Besar", "To Lower Case": "Jadikan Huruf Kecil", "Find…": "Cari…", "Replace…": "Ganti…", "Replace": "Ganti",
    "Find in Files…": "Cari di File…", "Go to Line": "Ke Baris", "Toggle Comment": "Komentar/Batal Komentar",
    "Open Files": "File Terbuka", "New Terminal": "Terminal Baru", "Tab Buttons": "Tombol Tab", "Gutter": "Gutter", "Status Bar": "Bilah Status",
    "Split": "Pisah Panel", "Split Active Pane to 4": "Pisah Panel Aktif jadi 4", "Split Right (Terminal)": "Pisah Kanan (Terminal)",
    "Split Left (Terminal)": "Pisah Kiri (Terminal)", "Split Down (Terminal)": "Pisah Bawah (Terminal)", "Split Up (Terminal)": "Pisah Atas (Terminal)",
    "Font Size": "Ukuran Font", "Increase Font Size": "Perbesar Font", "Decrease Font Size": "Perkecil Font", "Reset Font Size": "Reset Ukuran Font",
    "Syntax": "Sintaks", "Wrap Lines": "Bungkus Baris", "Wrap To Print Margin": "Bungkus ke Margin Cetak",
    "Go To Line…": "Ke Baris…", "Go To File…": "Ke File…", "Source Control": "Source Control",
    "New Terminal Here": "Terminal Baru di Sini", "Preferences…": "Preferensi…",
    "Staged": "Di-stage", "Changes": "Perubahan", "Commit": "Commit", "Stage all": "Stage semua",
    "Unstage all": "Unstage semua", "Discard all": "Buang semua", "Stage": "Stage", "Unstage": "Unstage",
    "SOURCE CONTROL": "SOURCE CONTROL", "Git": "Git",
    "Terminal → Right": "Terminal → Kanan", "Terminal → Left": "Terminal → Kiri", "Terminal → Down": "Terminal → Bawah", "Terminal → Up": "Terminal → Atas",
    "Open": "Buka", "Download as ZIP": "Unduh sebagai ZIP", "Download as TAR.GZ": "Unduh sebagai TAR.GZ", "Compress to ZIP…": "Kompres ke ZIP…",
    "Compress to TAR.GZ…": "Kompres ke TAR.GZ…", "Extract Here": "Ekstrak di Sini", "Preview": "Pratinjau", "Refresh": "Segarkan", "Rename": "Ubah Nama",
    "Delete": "Hapus", "Duplicate": "Gandakan", "Copy file path": "Salin path file", "Copy absolute path": "Salin path absolut",
    "Add to Favorites": "Tambah ke Favorit", "Open Terminal Here": "Buka Terminal di Sini", "Search In This Folder": "Cari di Folder Ini",
    "Search In Workspace": "Cari di Workspace", "Refresh File Tree": "Segarkan Pohon File", "Collapse All Folders": "Lipat Semua Folder",
    "Show Open Files": "Tampilkan File Terbuka", "Show Hidden Files": "Tampilkan File Tersembunyi",
    "Copied": "Tersalin", "Stop": "Berhenti", "Model": "Model", "Mode": "Mode", "Skills": "Skills", "Rules": "Rules", "Diff": "Diff",
    "Assistant": "VRCloud AI", "VRCloud AI": "VRCloud AI", "Plan": "Plan", "Ask": "Ask", "Agent": "Agent", "Copy code": "Salin kode",
  };

  // Awalan bertemplat (sisa teks dipertahankan): [awalan sumber, awalan terjemahan]
  var PREFIX_EN = [
    ["tersimpan: ", "saved: "], ["upload selesai: ", "upload done: "], ["upload gagal: ", "upload failed: "], ["path disalin: ", "path copied: "], ["path: ", "path: "],
    ["digandakan: ", "duplicated: "], ["Arsip dibuat: ", "Archive created: "], ["Download siap: ", "Download ready: "], ["Extract selesai: ", "Extracted: "],
    ["Menyiapkan download ", "Preparing download "], ["Gagal buka: ", "Failed to open: "], ["Gagal simpan: ", "Failed to save: "], ["Gagal simpan ", "Failed to save "],
    ["Gagal membuat terminal: ", "Failed to create terminal: "], ["Gagal membuat arsip: ", "Failed to create archive: "], ["Gagal download arsip: ", "Failed to download archive: "],
    ["Gagal extract: ", "Failed to extract: "], ["Gagal memuat diff: ", "Failed to load diff: "], ["Gagal memuat rule: ", "Failed to load rule: "],
    ["Gagal memuat skill: ", "Failed to load skill: "], ["Gagal mengekspor: ", "Failed to export: "], ["Gagal mengembalikan: ", "Failed to restore: "],
    ["Gagal mengubah nama: ", "Failed to rename: "], ["Gagal menyimpan: ", "Failed to save: "], ["Paste gagal: ", "Paste failed: "], ["Copy terminal gagal: ", "Terminal copy failed: "],
    ["Gagal: ", "Failed: "], ["Kesalahan: ", "Error: "], ["Screenshot gagal: ", "Screenshot failed: "], ["Menjalankan sesi desktop di ", "Starting desktop session on "], ["Realtime error: ", "Realtime error: "], ["Indentasi terdeteksi: ", "Detected indentation: "], ["Indentasi: ", "Indentation: "],
    ["Cari di /", "Search in /"], ["Tersimpan di ", "Saved to "], ["Tersimpan. ", "Saved. "], ["Skill: ", "Skill: "], ["Rule: ", "Rule: "], ["Skill dipakai: ", "Skill used: "],
    ["File pendukung: ", "Supporting files: "], ["Status: aktif · sumber ", "Status: enabled · source "], ["Status: nonaktif · ", "Status: disabled · "],
    ["Pengaturan model — ", "Model settings — "], ["Berpikir ", "Thinking "], ["Membaca ", "Reading "], ["Nama arsip ", "Archive name "],
    ["Belum ada runner untuk ", "No runner for "], ["Kembalikan seluruh workspace ke keadaan sebelum pesan ini", "Restore the whole workspace to before this message"],
    ["Terminal → ", "Terminal → "], ["Output terminal (", "Terminal output ("], ["Server: ", "Server: "], ["Agent: bekerja…", "Agent: working…"],
    ["Hapus skill ", "Delete skill "], ["Akhir baris ", "Line ending "], ["cocok pola: ", "matched pattern: "], ["Input ", "Input "],
    ["Agent: menunggu izin", "Agent: awaiting approval"], ["Agent sedang bekerja", "Agent is working"], ["Agent siap", "Agent ready"],
  ];
  var PREFIX_ID = [["Close ", "Tutup "]];

  // Pola dengan angka/variabel di tengah.
  var RULES_EN = [
    [/^Agent: working…\s+(\d+\/\d+) langkah$/, "Agent: working… $1 steps"],
    [/^Membaca (\d+) item$/, "Reading $1 items"],
    [/^Reading (\d+) item$/, "Reading $1 items"],
    [/^Thinking (\d+)s$/, "Thinking $1s"],
    [/^(\d+) browser terhubung ke workspace ini \(termasuk Anda\)$/, "$1 browsers connected to this workspace (including you)"],
    [/^(\d+) balasan agent belum dilihat — klik untuk membuka$/, "$1 unread agent replies — click to open"],
    [/^(\d+) notifikasi belum dibaca — klik untuk melihat$/, "$1 unread notifications — click to view"],
    [/^Ln (\d+), Col (\d+)\s+\((?:(\d+) baris, )?(\d+) karakter dipilih\)$/, function (m, l, c, ln, ch) { return "Ln " + l + ", Col " + c + "  (" + (ln ? ln + " lines, " : "") + ch + " characters selected)"; }],
    [/^Hapus (\d+) item terpilih\?$/, "Delete $1 selected items?"],
    [/^(\d+) items selected$/, "$1 items selected"],
    [/^upload (\d+)\/(\d+) …$/, "upload $1/$2 …"],
    [/^Line ending (LF|CRLF) — berlaku saat disimpan \(Ctrl\+S\)$/, "Line ending $1 — applied on next save (Ctrl+S)"],
    [/^Saved to (.+)$/, "Saved to $1"],
    [/^Menghapus (.+)\?$/, "Delete $1?"],
    [/^Hapus chat "(.+)"\?$/, "Delete chat \"$1\"?"],
    [/^(\d+)m lalu$/, "$1m ago"], [/^(\d+)j lalu$/, "$1h ago"], [/^(\d+)h lalu$/, "$1d ago"],
    [/^(\d+) file berubah$/, "$1 files changed"], [/^(\d+) file$/, "$1 files"],
    [/^Reading (.+)$/, "Reading $1"],
    [/^Model settings — (.+) \(klik untuk mengubah\)$/, "Model settings — $1 (click to change)"],
    [/^Hapus (.+)\?$/, "Delete $1?"],
    [/^(Aktif|Nonaktif) · (\d+) pola \((bawaan|kustom)\)$/, function (m, a, n, d) { return (a === "Aktif" ? "Enabled" : "Disabled") + " · " + n + " patterns (" + (d === "bawaan" ? "default" : "custom") + ")"; }],
    [/^Aktif: (.+)$/, "Enabled: $1"], [/^Nonaktif\.$/, "Disabled."],
    [/^Kembalikan (?:file (.+)|seluruh workspace) ke checkpoint ([0-9a-f]+)\?\n[\s\S]*$/, function (m, f, h) { return "Restore " + (f ? "file " + f : "the whole workspace") + " to checkpoint " + h + "?\nChanges after that point (by the agent or you) will be overwritten."; }],
    [/^Restore the whole workspace to before this message \(checkpoint ([0-9a-f]+)\)$/, "Restore the whole workspace to before this message (checkpoint $1)"],
    [/^(\d+) menunggu review$/, "$1 awaiting review"],
    [/^Tolak semua perubahan agent pada (\d+) file dan kembalikan ke sebelum pesan ini\?$/, "Reject all agent changes on $1 files and restore them to before this message?"],
    [/^Pindah ke branch (.+)\?$/, "Switch to branch $1?"],
    [/^Buang perubahan pada (.+)\?$/, "Discard changes in $1?"],
    [/^Skrip Playwright tersimpan: (.+)$/, "Playwright script saved: $1"],
    [/^Berpikir selama (\d+) detik$/, "Thought for $1s"],
  ];
  var RULES_ID = [[/^Close (.+)$/, "Tutup $1"]];

  function apply(str, map, prefixes, rules) {
    if (Object.prototype.hasOwnProperty.call(map, str)) return map[str];
    var trimmed = str.trim();
    if (trimmed && trimmed !== str && Object.prototype.hasOwnProperty.call(map, trimmed)) return str.replace(trimmed, map[trimmed]);
    var out = str;
    for (var i = 0; i < prefixes.length; i++) {
      if (out.indexOf(prefixes[i][0]) === 0) { out = prefixes[i][1] + out.slice(prefixes[i][0].length); break; }
    }
    for (var j = 0; j < rules.length; j++) {
      if (rules[j][0].test(out)) { out = out.replace(rules[j][0], rules[j][1]); break; }
    }
    return out;
  }
  function t(str) {
    if (str == null) return str;
    str = String(str);
    if (!str || !/[A-Za-z]/.test(str)) return str;
    // Penanda status di depan ("✓ tersedia", "✗ gagal") diterjemahkan sisanya saja.
    var mark = /^([✓✗] )/.exec(str);
    if (mark) return mark[1] + t(str.slice(mark[1].length));
    return lang === "en" ? apply(str, ID_EN, PREFIX_EN, RULES_EN) : apply(str, EN_ID, PREFIX_ID, RULES_ID);
  }

  // ------------------------------------------------------ Terjemahan DOM
  // Konten pengguna dilewati: editor, terminal, isi chat (markdown/kode/diff),
  // nama file (tree, tab, daftar file terbuka), input.
  var SKIP = "script,style,textarea,input,select,pre,code,kbd,.ace_editor,.xterm,.ai-md,.ai-msg.user .card,.ai-code,.ai-diff,.ai-term,.ai-think-body,"
    + "#filetree,#openlist,#favlist,.pt-name,.opath,.oname,.ai-hist-title,.ai-chip-nm,.ai-sk-name,.ai-sk-desc,.ai-plan-it,.ai-approve-cmd,.sr-file,.sr-hit,"
    + "#ws-name,#sb-file,#sb-term,#sb-git,#sb-pos,#sb-tokens,#sys-metrics,#sync-status";
  var ATTRS = ["title", "placeholder", "aria-label"];
  function skip(el) { try { return !!(el && el.nodeType === 1 && (el.matches(SKIP) || el.closest(SKIP))); } catch (e) { return false; } }
  function textNode(n) {
    var v = n.nodeValue; if (!v || !/[A-Za-z]/.test(v)) return;
    var r = t(v); if (r !== v) n.nodeValue = r;
  }
  function attrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      if (!el.hasAttribute(ATTRS[i])) continue;
      var v = el.getAttribute(ATTRS[i]); var r = t(v); if (r !== v) el.setAttribute(ATTRS[i], r);
    }
    if (el.tagName === "INPUT" && (el.type === "button" || el.type === "submit") && el.value) { var rv = t(el.value); if (rv !== el.value) el.value = rv; }
    if (el.tagName === "OPTION" && el.textContent) { var ro = t(el.textContent); if (ro !== el.textContent) el.textContent = ro; }
    // <select> dilewati (SKIP) sehingga <option> di dalamnya tidak pernah dikunjungi: terjemahkan di sini.
    if (el.tagName === "SELECT") { for (var o = 0; o < el.options.length; o++) { var op = el.options[o]; var rt = t(op.textContent); if (rt !== op.textContent) op.textContent = rt; } }
  }
  function walk(node) {
    if (node.nodeType === 3) { if (!skip(node.parentNode)) textNode(node); return; }
    if (node.nodeType !== 1) return;
    // Elemen yang dilewati: atribut (title/placeholder) tetap diterjemahkan, isinya tidak.
    if (node.matches(SKIP)) { attrs(node); return; }
    attrs(node);
    for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
  }
  function translate(root) { if (root) walk(root); }

  var observer = null;
  function observe() {
    if (observer || typeof MutationObserver === "undefined") return;
    observer = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (skip(m.target)) continue;
        for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function setLang(l) {
    l = l === "en" ? "en" : "id";
    try { localStorage.setItem(KEY, l); } catch (e) {}
    if (l !== lang) location.reload();
  }

  document.documentElement.setAttribute("lang", lang);
  observe();
  if (document.body) translate(document.body);
  else document.addEventListener("DOMContentLoaded", function () { translate(document.body); });

  window.I18N = { lang: lang, t: t, setLang: setLang, translate: translate };
})();
