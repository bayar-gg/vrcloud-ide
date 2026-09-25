# Contributing

Thanks for taking the time to contribute. This document covers how the project is
developed and released.

## Development

```bash
git clone https://github.com/bayar-gg/vrcloud-ide.git
cd vrcloud-ide
npm ci
cp .env.example .env     # set AUTH_USER, AUTH_PASS, AUTH_SECRET; HTTPS=false is handy locally
npm start                # http://127.0.0.1:1337
npm test                 # session store + realtime smoke tests
```

There is no build step. The frontend is plain JavaScript in `public/`, the server is
Node.js in `server.js` and `lib/`. Static assets are cache-busted with the `?v=`
parameter in `public/index.html`; bump it when you change CSS or JS.

Guidelines:

- Keep it a single process with no new runtime dependencies unless there is no
  reasonable alternative. Native modules must build on Linux and Windows.
- Match the existing style (2 spaces, semicolons, double quotes, small helpers, no
  frameworks). Comments explain *why*, not *what*.
- Anything the AI agent reads (prompts, tool names and descriptions, tool results) is in
  **English** and lives in **one file**: `lib/agent-instructions.js`. Do not add prompt text
  or tool descriptions elsewhere; import from that module. UI strings are Indonesian by
  default and must have an English entry in `public/js/i18n.js`.
- Test on both Linux and Windows when touching terminals, runners, remote desktop or
  the installers.
- Do not commit secrets, `data/`, `workspace/` or `.env`.

## Release policy: one commit, one version

The repository intentionally keeps **a single commit on `main`**. A release does not add
a commit; it replaces the commit and bumps `version` in `package.json`:

```bash
node scripts/release.js 3.1.0          # bumps version, amends the single commit, force-pushes
node scripts/release.js patch          # or: major | minor | patch
node scripts/release.js 3.1.0 --no-push
```

The script:

1. verifies the working tree is on `main`,
2. writes the new version to `package.json` and `package-lock.json`,
3. stages everything, creates or amends the root commit with the message
   `VRCloud IDE vX.Y.Z`,
4. force-pushes `main` (with lease).

Installed servers update with `git fetch --depth 1` + `git reset --hard FETCH_HEAD`
(see `lib/updater.js`), so rewritten history never breaks `vrcloud update`.

Record user-facing changes in `CHANGELOG.md` under the new version before releasing.

## Pull requests

- Open an issue first for larger changes so the approach can be discussed.
- Keep pull requests focused. Explain the motivation and how you verified the change.
- Pull request branches may contain as many commits as you like; they are squashed into
  the release commit when merged.

## Reporting bugs

Use the issue templates. Include your OS, Node.js version, how you installed
(bootstrap / Windows installer / manual), and the relevant part of `vrcloud logs`.
