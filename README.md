# VRCloud IDE

VRCloud IDE is a self-hosted browser development environment inspired by the
classic Cloud9 workflow. It combines an Ace code editor, persistent shared
terminals, a workspace file manager, split panes, authentication, and realtime
multi-browser collaboration in one Node.js application.

## Highlights

- Ace editor with syntax highlighting, autocomplete, line wrapping, gutter,
  status bar, themes, and multiple tabs.
- Drag tabs between panes or drop on an edge to create horizontal/vertical
  splits, including four-pane layouts.
- Persistent `tmux` terminals backed by `node-pty` and rendered with xterm.js.
- Shared realtime session: tabs, layout, editor buffers, dirty state, cursor,
  and terminal input/output synchronize between connected browsers.
- Atomic session persistence in `data/session.json`; closing the browser does
  not discard open files, unsaved buffers, layout, or running terminals.
- File manager with create, rename, delete, copy, paste, duplicate, search,
  upload, download, favorites, hidden files, multi-selection, ZIP/TAR creation,
  archive download/extraction, and context menus.
- Signed HttpOnly login cookie, login throttling, path traversal protection,
  and authenticated HTTP/WebSocket endpoints.
- Always-on systemd deployment with automatic restart.

## One-Command Full Installation

On a fresh Ubuntu/Debian VPS, run exactly one command:

```bash
curl -fsSL https://raw.githubusercontent.com/bayar-gg/vrcloud-ide/main/scripts/bootstrap.sh | sudo bash
```

This single command automatically:

1. Installs Node.js 12.22.12 and npm with checksum verification.
2. Installs Git, build tools, tmux, and ZIP/TAR tools.
3. Clones VRCloud IDE into `/opt/vrcloud-ide`.
4. Creates the dedicated `vrcloud` system account.
5. Creates the workspace at `/srv/vrcloud-workspace`.
6. Installs all production npm dependencies.
7. Generates a secure `.env`, random login password, and cookie signing secret.
8. Installs/enables the always-on systemd service.
9. Starts and verifies the complete installation.

When it finishes, the installer prints the generated username, password, and
URL:

```text
http://YOUR_SERVER_IP:1337/
```

Required firewall port: `1337`.

Custom workspace or port can still be provided in one command:

```bash
curl -fsSL https://raw.githubusercontent.com/bayar-gg/vrcloud-ide/main/scripts/bootstrap.sh \
  | sudo env PORT=1337 WORKSPACE=/srv/vrcloud-workspace bash
```

For security-sensitive environments, download and inspect `bootstrap.sh`
before piping it to `sudo bash`.

The command is safe to run again for updates. It preserves the existing
`.env`, workspace, and session data, then performs a fast-forward-only Git
update. Repository ownership is handled with a per-command `safe.directory`
override; the installer does not modify global Git configuration.

## Tested Environment

- Ubuntu 22.04 LTS
- Node.js 12.22.12
- npm 6.14
- tmux 3.x
- Chromium/Chrome-based browser

## Step-by-Step Installation

### 1. Install Node.js

The currently tested runtime is Node.js 12.22.12. Using `nvm` keeps this legacy
runtime isolated from system packages:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install 12.22.12
nvm use 12.22.12
```

### 2. Clone the repository

```bash
sudo git clone https://github.com/bayar-gg/vrcloud-ide.git /opt/vrcloud-ide
cd /opt/vrcloud-ide
```

### 3. Run the production installer

```bash
sudo bash scripts/install-systemd.sh
```

The installer:

1. Installs `tmux`, ZIP/TAR tools, Git, build tools, and CA certificates.
2. Installs production npm dependencies.
3. Creates the restricted `vrcloud` service account.
4. Creates `/srv/vrcloud-workspace`.
5. Generates `.env` with a strong random password and signing secret.
6. Installs and starts `vrcloud-ide.service`.

Open:

```text
http://YOUR_SERVER_IP:1337/
```

The generated username/password are displayed once by the installer. Store
them in a password manager.

## Manual Setup

Install system dependencies:

```bash
sudo apt-get update
sudo apt-get install -y tmux zip unzip git build-essential python3 ca-certificates
```

Install project dependencies:

```bash
cd /opt/vrcloud-ide
npm ci --production
```

Create configuration:

```bash
cp .env.example .env
chmod 600 .env
openssl rand -hex 24
openssl rand -hex 32
```

Put the generated values into `.env`:

```dotenv
AUTH_USER=admin
AUTH_PASS=replace-with-the-generated-password
AUTH_SECRET=replace-with-the-generated-64-character-secret
COOKIE_SECURE=false
SESSION_MAX_AGE=604800
HOST=0.0.0.0
```

Start manually:

```bash
PORT=1337 WORKSPACE=/srv/vrcloud-workspace npm start
```

## Configuration

- `PORT`: HTTP port. Default: `1337`.
- `HOST`: bind address. Default production installer value: `0.0.0.0`.
- `WORKSPACE`: root directory exposed by the IDE.
- `AUTH_USER`: login username. Required.
- `AUTH_PASS`: login password. Required.
- `AUTH_SECRET`: HMAC signing secret, at least 32 characters. Required.
- `COOKIE_SECURE`: set to `true` only when HTTPS is enabled.
- `SESSION_MAX_AGE`: login lifetime in seconds. Default: `604800`.
- `SHELL_BIN`: terminal shell. Default: `bash`.

Never commit `.env`. It is excluded by `.gitignore`.

## Optional HTTPS

The automatic installer intentionally does not install Certbot, Snap, Nginx,
or request a certificate. This avoids installation failures caused by blocked
ACME challenges, provider proxies, NAT, or port `80` restrictions.

The default URL is:

```text
http://YOUR_SERVER_IP:1337/
```

If HTTPS is required, configure it separately with a domain, external reverse
proxy, VPN, CDN, or provider-managed TLS service. After HTTPS is working, set
`COOKIE_SECURE=true` in `.env` and restart `vrcloud-ide`.

## Terminal Clipboard

- `Ctrl+C`: copy when terminal text is selected; otherwise send interrupt.
- `Ctrl+V`: paste.
- `Ctrl+Shift+C` / `Ctrl+Shift+V`: explicit copy/paste.
- `Ctrl+Insert` / `Shift+Insert`: alternative copy/paste.
- Right-click: Copy, Paste, Select All, Clear.

On plain HTTP, browser clipboard APIs may be unavailable. VRCloud IDE displays
a paste dialog fallback. HTTPS enables direct clipboard access.

Every new terminal opens directly with a Kali-inspired two-line prompt:

```text
┌──(vrcloudproject㉿hostname)-[/workspace/path]
└─#
```

## Editor and Workspace Shortcuts

- `Ctrl+S`: save active file.
- `Ctrl+Shift+F`: search in files.
- `Ctrl+G`: go to line.
- `Alt+L`: open terminal in the selected directory.
- `F6`: create a terminal.
- `Ctrl`/`Cmd` + click in file tree: toggle file/folder selection.
- `Shift` + click in file tree: select a visible range.
- Download with multiple selected items: automatically download one ZIP.
- Drag tab to pane center: move tab.
- Drag tab to pane edge: create split.

## Realtime Collaboration

Every authenticated browser connected to the same server joins one shared
workspace session. An action in one browser is immediately visible in the
others:

- open/close/select tabs;
- drag tabs and resize split panes;
- edit and save documents;
- cursor position;
- terminal input/output.

The menu bar shows `Realtime` while the collaboration WebSocket is connected.
This project intentionally uses one shared room per deployment.

## Persistence and Backups

Persistent UI/editor state is stored atomically in:

```text
data/session.json
```

Terminal processes live in named tmux sessions. `KillMode=process` prevents a
systemd restart from killing those sessions.

Recommended backup:

```bash
sudo systemctl stop vrcloud-ide
sudo tar -czf vrcloud-backup.tar.gz \
  /opt/vrcloud-ide/.env \
  /opt/vrcloud-ide/data \
  /srv/vrcloud-workspace
sudo systemctl start vrcloud-ide
```

## Operations

```bash
sudo systemctl status vrcloud-ide
sudo systemctl restart vrcloud-ide
sudo journalctl -u vrcloud-ide -f
```

Authenticated session diagnostics:

```text
GET /api/session-status
```

Run tests:

```bash
npm test
```

## Updating

```bash
cd /opt/vrcloud-ide
sudo systemctl stop vrcloud-ide
sudo -u vrcloud git pull --ff-only
sudo -u vrcloud npm ci --production
sudo systemctl start vrcloud-ide
```

Back up `.env`, `data/`, and the workspace before major upgrades.

## Project Structure

```text
server.js                  HTTP API, authentication, WebSocket routing
lib/session-store.js       atomic shared-session persistence
lib/realtime-hub.js        revisions, presence, cursors, realtime broadcast
lib/terminal-manager.js    shared tmux/node-pty terminal manager
public/index.html          IDE shell
public/login.html          authenticated login page
public/css/style.css       VRCloud UI themes and pane layout
public/js/app.js           editor, file manager, panes, terminal integration
public/js/sync-client.js   reconnect and offline WebSocket queue
deploy/                    reusable systemd unit template
scripts/                   production installer
test/                      persistence and realtime smoke tests
```

## Security Notes

- HTTP API, preview routes, realtime synchronization, and terminals require a
  valid signed login cookie.
- Login attempts are throttled and temporarily blocked after repeated failure.
- Workspace paths are resolved and restricted to `WORKSPACE`.
- `.env`, session data, and dependencies are excluded from Git.
- Use HTTPS, a firewall, and a non-root service account in production.
- Rotate credentials immediately if they are ever pasted into logs or chat.

## Troubleshooting

### Service does not start

```bash
sudo journalctl -u vrcloud-ide -n 100 --no-pager
node --check server.js
```

Verify `.env` contains all required values and has mode `600`.

### Terminal does not open

```bash
tmux list-sessions
node -e "require('node-pty-prebuilt-multiarch'); console.log('pty ok')"
```

Reinstall dependencies if the Node.js ABI changed:

```bash
rm -rf node_modules
npm ci --production
```

### Realtime status remains offline

Ensure the reverse proxy forwards WebSocket `Upgrade` and `Connection` headers.

### Clipboard paste opens a dialog

This is expected over plain HTTP. Configure HTTPS and set
`COOKIE_SECURE=true` for direct browser clipboard access.
