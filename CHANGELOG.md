# Changelog

VRCloud IDE ships as a single, continuously updated release. The repository keeps
one commit on `main`; every update replaces it and bumps the version below.
Installed servers pick up new versions with `vrcloud update` or the **Update**
button in the menubar.

## 4.0.6

### Fixed

- **The agent now actually uses the project's skills on Anthropic and Grok.** Only the Cursor
  SDK reads `.cursor/`; the other providers need the skills index and rules injected into the
  prompt. When a `.cursor` link existed, that injection was skipped for everyone, so an
  Anthropic/Grok agent never saw the available skills. The index (and rules) are now always
  included for non-Cursor providers, with an instruction to read the matching `SKILL.md` and
  follow it before improvising; Cursor still defers to its SDK when `.cursor` is present.
- **Remote desktop error `CopyFromScreen ... "The handle is invalid"` on Windows.** The screen
  capture reused one graphics context across frames, so once the desktop handle went stale
  (lock/unlock, resolution change, RDP reconnect, secure/UAC desktop) every capture failed for
  good. It now recreates the context and retries, recovering on its own; if the session truly
  has no desktop, the message explains it and points at console auto-logon instead of the cryptic
  handle error.

## 4.0.5

### Added

- **Remote desktop without an RDP login (Windows Server).** The session VRCloud runs in becomes
  *disconnected* when you close RDP (and there is none before the first login), so the desktop
  stops rendering and remote desktop / computer use go black. The Remote Desktop panel and
  `desktop_setup` now detect a disconnected session and say exactly what is wrong. A new helper,
  `scripts\windows-headless-desktop.ps1`, sets up console auto-logon so a chosen account is signed
  into the physical console at boot, keeps it awake and unlocked, and redirects RDP back to the
  console on disconnect — so the desktop keeps rendering with no RDP session open (`-Remove` undoes
  it). The Windows installer offers this step (it already runs elevated), `scripts\vrcloud.ps1
  headless` enables it any time (self-elevates via UAC), and both offer a reboot at the end.

## 4.0.4

### Fixed

- **Empty reply with no response after changing the API key.** When the Anthropic model returned
  an empty turn (no text, no tool call, a normal stop), the turn was recorded internally but
  nothing was ever streamed to the chat, leaving a blank "VRCloud AI" bubble with no error. This
  happened most often on the first message after switching the API key, since that request runs
  on a freshly rebuilt history and a transient empty completion was not handled. An empty turn is
  now retried once; if it is still empty, a visible note is shown instead of silence. Normal and
  tool-using turns are unchanged.

## 4.0.3

### Added

- **Web search for every provider.** A `web_search` tool is available to Cursor, Anthropic and
  Grok in all modes. It picks a backend from the configured key: Tavily (`tvly-…`), Brave
  Search, or DuckDuckGo with no key at all. Results carry title, URL, snippet and date; a
  `recency` filter and a `site:` restriction narrow them, and `fetch_top` reads the full text of
  the top pages so answers rest on sources rather than the model's memory. Identical queries
  are cached for ten minutes. The key lives in the AI settings ("Pencarian web") or in
  `SEARCH_API_KEY`.
- **Research discipline.** A `[Research]` guide is sent for tasks, conversation and Ask: for
  anything factual that can change (versions, docs, errors, prices, news, people, products)
  the assistant searches first, reads one to three sources, prefers primary ones, cross-checks
  important claims, notes dates, separates sources from interpretation, and ends with the URLs
  it actually used. It does not search for things it knows for certain or for the user's own
  code.
- **Tool activity shown the way Claude shows it.** Consecutive tool steps are grouped into one
  collapsible block. While working it shows a shimmering label with the current action
  ("Menelusuri web…", "Mengedit…"); when the reply starts it folds into a one-line summary
  ("Menelusuri web · membaca 2 halaman", "Mengedit 1 file · 2 perintah") with an icon and the
  favicons of the sites used. Inside, steps are flat rows; search steps list their sources as
  favicon · title · domain, and page fetches show favicon + domain + path. Thinking that happens
  between tools lives in the same block; plans, change reviews and approvals stay outside.

### Fixed

- **TLS certificate could not be regenerated on Windows.** When the machine's IP set changed
  and `openssl` was not on PATH, the PowerShell fallback could hang and the server refused to
  start. The certificate helper now also uses the `openssl` bundled with Git for Windows (and
  Homebrew on macOS), which takes about a second.

## 4.0.2

### Added

- **Conversation, not just tasks.** The assistant is now a thinking partner as well as an
  engineer. Messages that are talk rather than work (questions, opinions, brainstorming,
  learning, a chat about the day) are detected and answered as conversation: with a point of
  view and reasons, disagreement when warranted, a clear line between what it knows and what
  it guesses, in the user's language and register, at most one clarifying question, and web
  research when facts could be stale. Such messages skip the task machinery (todos, step
  verification, project snapshot, orchestration), so they are faster and cheaper. Work
  requests (verbs, file paths, code vocabulary, attached skills) still get the full playbook.
  If a conversation turns into something it could do in the workspace, it offers in one
  sentence rather than editing files on its own.
- **It remembers you.** Durable facts about the user (name, role, preferences, how they like
  answers, what they are working on) are stored as `user` memories and shown to the assistant
  in every mode, so Agent, Plan, Ask and Chat all know who they are talking to.
- **Chat mode** in the Mode menu: talk and discuss freely, with web research, memory and image
  generation available, and no edits, shell, AST or desktop control. On the Cursor provider it
  blocks the mutating built-in tools without the strict Ask allowlist, so custom tools such as
  the browser remain available.

## 4.0.1

### Fixed

- **Anthropic: "messages: text content blocks must be non-empty".** An empty model reply was
  stored as an empty text block, after which every later message in that chat failed with
  HTTP 400. Empty replies are no longer stored that way, saved histories are repaired before
  each request (existing broken chats work again), and if the API still rejects a request for
  this reason the history is repaired and the request is retried automatically, so the run
  continues.
- **Restore to before this message could delete the whole chat.** Consecutive messages share
  a checkpoint when no file changed between them, and the restore looked the message up by
  checkpoint and took the first match, so restoring the second message removed the first one
  and everything after it. The button now identifies the exact message it belongs to; without
  that information it picks the latest match, never an earlier one.

## 4.0.0

### Added

- **Image generation** when the task needs it and the model supports it. Cursor uses its
  native `generateImage` tool; Grok uses Grok Imagine (`generate_image`, generate or edit
  up to 5 workspace images) with the signed-in session. Claude cannot generate images, so
  the tool is not offered unless `XAI_API_KEY` is set. Results are saved in the workspace,
  shown as a gallery in the chat, and tracked by checkpoints. New **Image** chip
  (Auto / Off) in the composer.
- **Context bar** above the composer showing how much of the model's context window the
  last request used, with warning colours at 65 / 85 / 95%. For Anthropic it is measured
  exactly with `count_tokens` once the estimate passes 60%.
- **Active-file pill** next to the context bar: shows which editor file (and how many open
  tabs) the agent receives as context; click to send the next message without them. While
  the agent works, the same spot shows live progress (step x/y, elapsed time, or waiting
  for command approval).
- **Context handoff**: at 80% of the window the agent writes a structured handoff (goal,
  done + how it was verified, in progress, findings, remaining) and a fresh agent continues
  from it instead of restarting the task. Continuation prompts always carry a task-state
  digest rebuilt from todos, changed files and the last verification.
- **Overflow guard** (Anthropic): when the prompt would not fit, older tool output is
  compacted harder and the oldest tool rounds are dropped without breaking tool pairs.
- **`diagnostics(path)` tool** for every provider: language-server errors and warnings
  for a file in under a second, honest about servers that are not installed.
- **`desktop_find` and `desktop_click({ name })`**: find and click controls by name
  through the OS accessibility tree (Windows UI Automation, Linux AT-SPI, macOS System
  Events) instead of estimating coordinates from a screenshot.
- Desktop tool results now report the exact pointer position in pixels and fractions.
- Smart Agent shows **why** each message took the direct or orchestrated path; medium-
  length change requests are classified by the model instead of by character count.
- Hermetic tests for prompt invariants, safety guards and image generation
  (`npm run test:prompts`); live eval fixtures for the browser and computer use, which
  are reported as skipped on servers without a browser or desktop.

### Changed

- **Command approval is on by default and enforced for every provider.** Commands that
  match the safety patterns wait for approval in the AI panel; a timeout or a run with no
  one to ask means **deny**. The Cursor shell-guard hook is installed (HTTPS-aware) instead
  of removed at boot; Anthropic and Grok check in the `shell` tool itself.
- **Todos need evidence**: a step marked completed without a check run since it started
  (shell, diagnostics, browser, desktop, generated image) is put back to in progress and
  the agent is told why. One check cannot complete two steps.
- One-step-at-a-time verification guidance for all providers, and rewritten browser and
  computer-use playbooks (structure/refs first, stale refs after navigation, click by name).
- Read-only tool rounds (read, grep, glob, ls, ast_search, ...) run in parallel for
  Anthropic and Grok.
- Structured memory is the single source of truth; `.vrcloud-agent/memory.md` contains a
  generated block from it, and free-form notes outside the block are preserved.
- The workspace writer lock is global: a direct agent run in one chat no longer edits
  files at the same time as an orchestrated implementer in another.
- **Restore to before this message** now rewinds the conversation too: that message and
  every message below it are deleted for all browsers, the agent's memory of them is
  discarded (Anthropic/Grok history, the stored Cursor agent), and the message text is put
  back in the input box to edit or resend. It refuses while the agent is running and checks
  before restoring any file, so files and chat never get out of step.
- Remote Desktop pointer input is coalesced on the client and server, so the cursor no
  longer lags seconds behind; agent desktop actions wait less between steps and Linux drags
  use a single `xdotool` call.

### Fixed

- **Touch devices**: controls that only appeared on hover are now always visible on phones
  and tablets (restore-to-message, copy reply, rename/export chat); tap targets in the AI
  panel are 34–40px instead of 18–28px; inputs use 16px text so iOS Safari no longer zooms
  the page when you tap them; the send/microphone group stays right-aligned when the
  composer wraps; the model name is no longer clipped on narrow screens.
- **Menus could not be used on phones.** Chip menus (Agent, Browser, Computer) and the
  model popover's Effort / Context / Model submenus opened *behind* the full-screen mobile
  panel, closed themselves about a second after a tap (hover-leave auto-close fired when the
  finger lifted), and the Effort / Context / Model submenus were positioned off-screen. They
  now open on top, stay open until you tap outside, and are kept inside the screen. Touch is
  detected from the actual pointer type, not only from media queries some phones misreport.
- The mobile composer uses two fixed rows: option chips on top; plus, model, microphone and
  send below.
- Toasts appear at the top in mobile mode instead of covering the composer.
- The updater no longer offers an "update" when the local install is a newer, unpushed
  release than GitHub — that update would have reset it to the older version.
- `noNativeTask` is enforced: no fallback of the Cursor tool list can re-enable nested
  subagents inside the orchestrated implementer.
- Task-state and evidence checks recognise Cursor's `inProgress` todo status.

## 3.0.19

### Added

- **Smart Agent orchestration** for substantive Agent-mode work: one planner, bounded
  parallel read-only explorers, a single workspace writer, deterministic verification,
  bounded repair attempts, and read-only finalization. Worker/todo/verification/result
  events persist in order; stopping a run cancels workers and verification.
- **Ranked project context** backed by a persistent workspace index, canonical change
  events, active/open/explicit-file priority, symbol/import/test hints, strict context
  budgets, and cache invalidation after editor, disk, shell or agent changes.
- **Optional language-server context** for JavaScript/TypeScript, Python, Go and Rust
  (`typescript-language-server`, `pyright-langserver`, `gopls`, `rust-analyzer`) with
  diagnostics, symbol/definition/reference caches, restart backoff and lexical fallback.
- **Tree-sitter structural tools** for JavaScript/JSX, TypeScript/TSX, Python, Go and Rust.
  `ast_search` returns stable match IDs, byte ranges and source hashes; `ast_edit` rejects
  stale, ambiguous, non-unique and syntax-regressing changes while preserving UTF-8,
  BOMs and line endings.
- **Evidence-backed structured memory** with scope, provenance, confidence, TTL and source
  hashes. Changed evidence becomes stale until revalidated; Ask mode can search but cannot
  mutate memory.
- **Verification engine** that reconciles actual workspace changes, selects relevant project
  checks, bounds output and execution time, supports cancellation, and feeds failures into
  the repair loop and final review metadata.
- **Hermetic Smart Agent acceptance suite** with cross-provider doubles, orchestration,
  context ranking, LSP, memory invalidation, structural edit, verification/repair,
  cancellation, checkpoint/review and event compatibility coverage. `npm test` no longer
  reads `.env`, starts a server or uses the network; realtime coverage moved to
  `npm run test:smoke`.
- **Opt-in live agent evaluator** (`npm run eval:agent`) with JavaScript, TypeScript, TSX,
  Python, Go and Rust fixtures plus stale/ambiguous/syntax rejection and protected diff-scope
  cases. It runs only with explicit enablement and records JSON success, provider/model,
  tool-call, text-edit fallback, token, duration, changed-file and syntax-regression metrics.

### Changed

- Multi-agent runs now activate for Indonesian coding requests, stream localized worker
  lifecycle/activity/tool-count/timing cards in real time, retain compact progress in
  history, and preserve substantive implementation details plus authoritative changed-file
  and verification evidence in the final response.
- Linux installers now detect `apt`, `dnf`, or `yum`. CentOS Stream 9+ and AlmaLinux
  8+ are supported, including native build dependencies, optional Chromium runtime
  libraries, EPEL/CRB-backed virtual desktop packages, and `firewalld` setup guidance.
  Bootstrap-installed Node.js remains discoverable when RHEL's `sudo` secure path omits
  `/usr/local/bin`.
- Reverted the mobile-responsive shell and follow-up phone UX (PRs #4, #6, #7, #8, #9).
  The desktop IDE is back to the pre-mobile layout: menubar, activity bar, sidebar,
  Ace editor, terminal, and the original composer. No bottom nav, no file drawer,
  no hidden editor on narrow viewports, and no phone-only composer tap-target CSS.
- **Grok account login is kept** (PR #5 / 3.0.14): Settings → Grok → Sign in with Grok
  still runs xAI device-code OAuth at `auth.x.ai`. Session tokens stay encrypted in
  `data/grok-session.json`.

## 3.0.18

### Changed

- On phones and narrow browsers (≤768px) the Ace text editor / workarea pane is gone.
  The bottom bar is Files / Terminal / Agent; Agent (or the file drawer) fills the
  space the editor used to occupy. Opening a file no longer switches to the editor —
  it stays on the current mobile pane. Desktop (≥1024px) file open and the editor
  are unchanged.

## 3.0.17

### Fixed

- Opening a file on a phone no longer paints a white Ace sheet that looks like the
  server crashed. Ambiance is loaded with the page (not a later dynamic fetch),
  TextMate’s default `#fff` background is overridden to the dark editor colors,
  and adding a tab no longer tears down `#workarea` (which blanked Ace on iOS).
  Workers are disabled before the first session. A process-level log line is
  written if Node would otherwise die silently. Desktop file open is unchanged.

## 3.0.16

### Fixed

- Composer toolbar on phones is compact again (one row: +, model pill, tool icons, mic,
  send) instead of the oversized two-row 44px chrome. Invisible hit padding keeps taps
  reliable without enlarging the glyphs. The model (`auto`) chip is clickable again —
  menus are pinned above the chip so they are not clipped by the agent overlay.
- Opening a file on a phone no longer blanks or freezes the IDE. Ace no longer
  auto-focuses (which scrolled its hidden textarea off-screen and zoomed the page),
  workers / live autocomplete / minimap are skipped on narrow viewports, and the
  viewport is pinned so the workarea stays usable. Desktop file open is unchanged.

## 3.0.15

### Fixed

- On phones and narrow browsers (≤768px), every control on the AI composer toolbar is a
  ~44×44 tap target. The model, Mode/Browser/Computer/Review/Skills, mic, and send buttons
  no longer share one cramped row: tool icons wrap onto a second row (and can scroll
  sideways if needed) so adjacent icons are not mis-tapped. Chip menus now open above the
  agent overlay instead of behind it. Desktop (≥1024px) chrome is unchanged.

## 3.0.14

### Added

- **Grok** as an AI provider via the operator's own Grok / xAI account. Sign in from
  the AI settings panel (official device-code OAuth at `auth.x.ai` — the same flow as
  `grok login --device-auth`). Session tokens stay on the server in
  `data/grok-session.json` (encrypted, mode 0600) and can be signed out. No
  `GROK_API_KEY` / `XAI_API_KEY` is required. The agent uses the same workspace tools
  as Anthropic (files, shell, search, browser, computer use). Needs SuperGrok or
  X Premium+; xAI may rate-limit or expire the session (re-login from settings).

## 3.0.13

### Changed

- Phones and narrow browsers (≤768px, with a tighter 480px pass) get a usable IDE: viewport
  and safe-area handling, a file drawer, a Menu overflow, touch-sized chrome, and a bottom bar
  for Files / Editor / Terminal / Agent. The previous mobile mode that hid the IDE and left
  only the AI chat is gone. Desktop (≥1024px) layout is unchanged.

## 3.0.12

### Changed

- The agent instructions now follow the same working habits used by other coding agents: search only until the cause is clear, batch independent lookups, keep edits small and exact, verify with the narrowest check, and stay read-only in Ask mode. The text is VRCloud's own; other products' system prompts are not copied in.
- Windows update works on a ZIP download that has no `.git`. `vrcloud.ps1 update` and the Update button turn the folder into a Git checkout, then fetch `main`. `.env` and `data/` stay in place.

## 3.0.11

### Added

- Windows `scripts\vrcloud.ps1 update` fetches the latest release and restarts the Scheduled Task when it is running, matching `vrcloud update` on Linux. The Update button in the IDE already did this on Windows.

## 3.0.10

### Changed

- Windows installs now open the IDE the same way Linux does: inbound TCP on the server port is allowed, and the installer plus `vrcloud.ps1 start` / `status` print `https://IP:port` for the public address, LAN address, and localhost.

## 3.0.9

### Fixed

- Browser steps in the chat card often had no screenshot. A failed attempt to shrink a large capture discarded the image, and text steps such as extract never captured one. Captures are kept, extract and error pages are screenshotted, and the card shows the latest image when the selected step has none.

## 3.0.8

### Fixed

- Computer-use screenshots in the chat were broken when the agent used the Cursor API. That provider puts raw JPEG bytes in the tool result, and embedding those bytes made the card show a broken image. Each capture is now saved as a file and the card loads it by URL.

## 3.0.7

### Fixed

- Computer-use screenshots were missing in the chat when the agent used the Cursor API. That provider returns images as `{ image: { data } }` and often omits the bytes from the tool event, so the "Controlling the computer" card said the step had no screenshot. Both result shapes are read now, and the capture is kept on the server per tool call so the card can still show it.

## 3.0.6

### Changed

- An invalid or rejected API key now shows the provider's own error (HTTP status and message) in the chat and in the agent settings, instead of a generic failure.
- Changing the API key or the provider keeps the open chat. The new agent re-reads that conversation and continues the same task.

## 3.0.5

### Changed

- Computer-use screenshots and the remote-desktop stream draw the mouse pointer (a white arrow). Its tip is the click point, so the agent can see when a click missed. macOS already captured the system cursor; Windows and Linux now draw one because their capture APIs omit it.
- Computer-use instructions now walk the agent through a tighter loop: look, act once, check where the cursor tip landed, wait instead of repeating a missed click, switch to the keyboard after two misses, and only report success when the result is visible.

## 3.0.4

### Fixed

- The "N terminal agent" bar above the composer counted finished background shell cards, so it stayed visible after the processes had already exited. It now lists only processes that are still alive.
- Each listed process, and the bar itself, has a Stop button that ends that process (and its children).

## 3.0.3

### Changed

- Computer use no longer stops at login, sign-up, CAPTCHA, checkout, or payment. When those
  steps are part of the task, the agent fills and submits them (using details the user gave,
  that are on screen, or that are saved in the browser) and gets past dialogs that block the
  outcome instead of handing the work back.

## 3.0.2

### Changed

- **All agent instructions in one file.** System prompt, per-message guidance, Ask mode,
  browser and computer-use playbooks, memory rules, context labels, the continue prompt and
  every tool description (workspace, `desktop_*`, `browser_*`) now live in
  `lib/agent-instructions.js`; `ai-chat.js`, `anthropic-agent.js`, `desktop-remote.js` and
  `browser-automation.js` import from it. Browser tool and parameter descriptions are now
  English like everything else the agent reads.
- The Anthropic provider no longer receives the static "how to work" block twice (system
  prompt and per message), saving tokens on every turn.

## 3.0.1

### Fixed

- **Black Remote Desktop on Linux.** The virtual display could be alive while no desktop
  session was drawing on it (Xvfb survives a server restart, or XFCE failed to start under
  systemd without `HOME` / `XDG_RUNTIME_DIR` / a D-Bus session), so every frame was black.
  The server now checks for a running window manager on the virtual display and (re)starts
  the session when it is missing, gives the session a proper environment, disables the xfwm4
  compositor (which blanks `import` captures on Xvfb), captures with `-screen`, sets a
  non-black root background while the session loads, logs session output to
  `data/desktop-session.log`, falls back to openbox / fluxbox / icewm / twm when XFCE is not
  installed, and shows "Starting desktop session..." in the panel. `desktop-setup.sh` now
  installs `xprop` and `xsetroot` on every supported distro.

## 3.0.0

The "computer use" release.

### New

- **Computer use for the AI agent.** The agent can now see and operate the
  server's real desktop: `desktop_screenshot`, `desktop_click`, `desktop_drag`,
  `desktop_move`, `desktop_type`, `desktop_key`, `desktop_scroll`,
  `desktop_wait` and `desktop_setup`. Coordinates are resolution-independent
  fractions of the screen; every action returns a fresh screenshot.
- **"Controlling the computer" card** in the chat: consecutive desktop steps
  fold into one card with a large live screen frame and numbered steps with
  thumbnails, the same way browser sessions do.
- **Computer use toggle** in the composer (Auto / On / Off), next to Browser
  tools. Off removes the desktop tools entirely; On tells the agent to prefer
  the desktop GUI for application and window tasks.
- **Remote Desktop** (VNC-like) from the OS badge in the menubar: JPEG screen
  streaming over WebSocket with mouse and keyboard control on Windows, Linux
  and macOS, plus one-click virtual desktop (Xvfb + XFCE) setup on headless
  Linux servers.
- **Realtime UI mirroring** across browsers: open tabs, active tab, split
  layout, editor content and cursors, terminal output, sidebar view, AI panel
  state and the Remote Desktop panel are all kept in sync between sessions.
- **Notification center**: bell icon with unread badge, history dropdown,
  in-app toasts and optional browser notifications when the agent finishes.
- **Smarter agent prompts** with a live project snapshot (stack, git state,
  file tree, recent changes), editor context, repeated-failure detection and
  history compaction. All agent instructions and tool descriptions are in
  English.
- **Project memory** (`.vrcloud-agent/memory.md`) can be switched on and off
  from the agent settings.
- **HTTPS by default** with an automatically generated self-signed certificate
  that covers local and public IPs (`https://IP:PORT`), or your own PEM files.

### Improved

- Realtime editor sync: 40 ms keystroke debounce, server-side conflict
  resolution that retries local edits, and disk changes by the agent or by
  scripts are reflected in open tabs immediately.
- The **Run** button detects the interpreter or compiler for the active file's
  extension on the server and runs the file in its own folder, in a floating
  terminal that can be docked as a tab.
- VS Code-style file and folder icons, inline rename and file creation in the
  tree (F2 / Delete), clearer line numbers, collapsible Open Files list.
- Redesigned login and loading screens; the login page follows the IDE
  language setting.
- Chat rendering closer to Claude and ChatGPT: streamed thinking blocks,
  GFM tables, nested and task lists, copy buttons, accept/reject review card
  that jumps to the first changed line.
- The OS badge shows a monitor icon with the OS logo on screen and opens
  Remote Desktop on click.
- Tool cards, browser and desktop steps, option chips and the Remote Desktop
  panel are fully translated in English mode.

### Fixed

- Commands sent to a terminal from the chat (the run-in-terminal button) now
  send a real Enter (CR), which PowerShell/ConPTY expects; previously they
  showed a `>>` continuation prompt on Windows.
- Transient screen-capture errors no longer flash an error in the Remote
  Desktop panel; the stream retries silently and only reports persistent
  failures.
- The Windows capture and input helpers are split so antivirus (AMSI) no
  longer blocks streaming and control.

## 2.0.0

Realtime collaboration, AI agent with checkpoints and review mode, headless
browser automation, source control panel, command palette, project memory,
self-update.

## 1.0.0

Initial release: Ace editor, tmux-backed terminals, file manager, login,
systemd and Windows installers.
