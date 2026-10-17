# Repository Rules

## Git workflow
- After every implementation round, commit and push to `origin/main`.
- Remote: https://github.com/shadowaltar/OpenCodeWeb.git
- Inspect `git status` and `git diff` before staging; stage only intended files.
- Never commit `node_modules/`, runtime state, tokens, or logs.
- Use concise, imperative commit messages (`feat:`, `fix:`, `docs:`, `chore:`).
- Do not force-push or amend already-pushed commits.

## Verification
- Run `npm run smoke` after logic changes.
- Run `npm run test:real` against a running OpenCode app for end-to-end changes.
- Run `node --check` on changed `.js` files.

## Plugin install
- After source changes that affect the running plugin, run `npm run install:plugin`.
- Runtime token: `%USERPROFILE%\.local\share\opencode-remote-player\runtime.json`.

## Security requirements
- Keep the web server bound to `127.0.0.1` only.
- Keep bearer-token auth, Host/Origin validation, strict CSP, and JSON-only POST bodies.
- Never expose prompt text, tokens, or project paths to third parties.
