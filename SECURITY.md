# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

- Use GitHub's private vulnerability reporting on this repository, or
- email **support@bayar.gg**.

Include a description, steps to reproduce and the affected version (Preferences shows it).
You will get an acknowledgement within a few days. Fixes ship as a new version of the
single release commit; installed servers receive them with `vrcloud update`.

## Supported versions

Only the current version on `main` is supported. There are no maintenance branches.

## Deployment notes

- Whoever can log in gets a shell on the server &mdash; **root** by default. Put the IDE
  behind a firewall, VPN or authenticating reverse proxy if it is reachable from the
  internet, or install with `VRCLOUD_ROOT_ACCESS=false`.
- `.env` contains the password and the session-signing secret. Keep it `chmod 600`.
  `vrcloud newpassword` rotates both and invalidates existing sessions.
- `data/` contains unsaved editor text, AI conversations, API keys entered in the UI
  (`ai-config.json`), the Grok account session (`grok-session.json`), the browser profile and screenshots. Restrict its permissions and
  include it in backups deliberately.
- The AI agent can run any command the service user can. Enable command approval for
  destructive patterns, use Ask mode for read-only sessions, and review changes before
  accepting them.
- Computer use and Remote Desktop operate the real desktop of the server. Anything visible
  on that screen is visible to the agent while it works; do not leave credentials on
  screen. Set Computer use to **Off** to unregister the desktop tools entirely.
- Browser automation runs a real Chromium profile stored under `data/`. Credentials saved
  in the browser secrets vault are encrypted with `AUTH_SECRET`.
- Login is rate-limited and locks out after repeated failures. HTTPS is on by default;
  the self-signed certificate protects against passive eavesdropping but not against an
  active attacker &mdash; use your own certificate (`TLS_CERT` / `TLS_KEY`) or a reverse
  proxy for a trusted chain.
