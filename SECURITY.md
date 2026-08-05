# Security Policy

## Reporting a Vulnerability

Do not publish authentication bypasses, path traversal issues, terminal command
injection, or credential leaks in a public issue.

Use GitHub Private Vulnerability Reporting for this repository and include:

- affected version or commit;
- reproduction steps;
- expected and actual behavior;
- impact assessment;
- suggested mitigation, if available.

## Deployment Requirements

- Run VRCloud IDE behind HTTPS.
- Use a dedicated non-root service account.
- Keep `.env` readable only by the service account (`chmod 600 .env`).
- Restrict port `1337` to localhost when using a reverse proxy.
- Back up and protect `data/session.json`; it can contain unsaved editor data.
- Rotate `AUTH_PASS` and `AUTH_SECRET` after suspected disclosure.

## Supported Version

Security fixes are applied to the latest commit on the default branch.
