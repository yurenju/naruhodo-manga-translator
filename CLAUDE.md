# CLAUDE.md

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `yurenju/naruhodo-manga-translator` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Testing

Unit and browser tests on every change; e2e (real OCR) only before an integration branch's PR or when `src/offscreen/` changes, not in each implement-spec ticket session. Where a new test goes and how FakeEngine replays the models: `docs/agents/testing.md`.

## Real-site debugging

A bug that shows on a real manga site but not on the e2e mock site: have the user reproduce it while `npm run debug:chrome` records a trace of the whole pipeline. Timing and performance: measure in that Chrome with `npm run debug:eval`. See `docs/agents/real-site-debugging.md`.

When the user asks to open the debug Chrome, do it at once, no research first: run `npm run debug:chrome` in a new Terminal panel tab (`run_in_terminal`, never the Bash or PowerShell tool). If `node_modules` does not exist yet (a fresh worktree), run `npm ci; npm run debug:chrome` instead. Wait for the `錄製中 →` line. The profile keeps the extension, API key and site logins. Then `npm run debug:summary` reads what the user reproduced.

## Public repo: no real titles or sites

Never write a real manga title, character, author, publisher, manga site or e-book reader brand in anything that gets published: docs, GLOSSARY, ADRs, code, commits, branches, issues, PRs. Name sites by layout (Canvas Site, E-book Reader) and keep concrete observations on this machine (`%LOCALAPPDATA%\naruhodo\`, scratchpad). See `docs/agents/public-repo.md`.

## Coding standards

Reviewing a change: check it against `CODING_STANDARDS.md`.
