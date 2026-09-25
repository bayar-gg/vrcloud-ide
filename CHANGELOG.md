# Changelog

VRCloud IDE ships as a single, continuously updated release. The repository keeps
one commit on `main`; every update replaces it and bumps the version below.
Installed servers pick up new versions with `vrcloud update` or the **Update**
button in the menubar.

## 3.0.14

### Added

- **Grok** as an AI provider via the operator's own Grok / xAI account. Sign in from
  the AI settings panel (official device-code OAuth at `auth.x.ai` — the same flow as
  `grok login --device-auth`). Session tokens stay on the server in
  `data/grok-session.json` (encrypted, mode 0600) and can be signed out. No
  `GROK_API_KEY` / `XAI_API_KEY` is required. The agent uses the same workspace tools
  as Anthropic (files, shell, search, browser, computer use). Needs SuperGrok or
  X Premium+; xAI may rate-limit or expire the session (re-login from settings).

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
