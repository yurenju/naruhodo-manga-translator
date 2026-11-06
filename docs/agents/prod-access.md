# Querying production

This machine has **read-only** access to Cloudflare (ADR 0011). You can read the production D1 and the Worker's logs; you cannot deploy, write to D1, or change secrets. That is deliberate: deploys and migrations go through CI on merge to main (ADR 0008), and Worker secrets are set by the user in the Cloudflare dashboard. Never run `wrangler login`, and never ask the user for a token with write permissions to work around a refusal: if a task needs a write, tell the user what to change and where.

## Steps

1. **Open the proxy once per debugging session**, in a Terminal panel tab (`run_in_terminal`): `npm run prod:connect`. It asks 1Password once for the read-only token and is ready when it prints `連線中 →`. The token lives only in that process. It exits after 30 minutes without a request; while it is open, the queries below need no further authorization.
2. **Query**, from Bash:
   - `npm run prod:sql -- "SELECT …"` prints the rows as JSON. Only one `SELECT`, `WITH`, `EXPLAIN` or `PRAGMA` statement per call (a `PRAGMA` may not set a value: no `=`, and arguments only for the schema pragmas such as `table_info(accounts)`); anything that writes is refused by the proxy before it reaches Cloudflare, and by the token if it got that far. Find the tables in `worker/migrations/`. Keep the SQL on one line: on Windows `npm run` cuts an argument at its first newline, so a multi-line query silently loses its tail; for one, call `node scripts/prod-query.ts sql "…"` directly.
   - `npm run prod:logs -- --since 2h --search error --limit 50` prints Workers Logs of `naruhodo-api`, one line per event, oldest first (`--since` takes `30m`, `2h`, `1d`, at most 7 days back; at most 100 events; `--json` prints the raw response). Logs exist only since `observability` was enabled in `worker/wrangler.jsonc`.
   - `npm run prod:tail` streams live events as NDJSON until Ctrl-C; run it with a timeout or in the background, since it never ends on its own.
3. If a query says the proxy is not running, it timed out or was never started: ask the user to watch for the 1Password prompt, and start step 1 again.

## Keeping the 1Password prompts down

Each `op run` is a new 1Password authorization, and every tool call you make is a new process, so a command that wraps its own `op run` prompts every time. Always go through the proxy rather than `op run … wrangler …`, and batch: think about what you need before querying, and pull several columns or a wider time range in one call instead of many narrow calls. One debugging session should cost the user one prompt; a second one only after the proxy has idled out.

## What the proxy allows

`scripts/prod-proxy.ts` listens on `127.0.0.1:8790` and forwards only the D1 database whose `database_id` is in `worker/wrangler.jsonc`, and the logs and tail of `naruhodo-api`. The token itself is account-wide (Cloudflare cannot scope D1 Read to one database), so this allow-list is what keeps other projects' data on the same account out of reach. It refuses requests that carry an `Origin` header or a foreign `Host`, so a web page in a browser cannot use it. The rules are in `scripts/prod-access.ts`, tested in `scripts/prod-access.test.ts`.

## Doing the same in another project

`wrangler logout` signs this whole machine out, so another project that used `wrangler login` needs its own setup. Copy the pattern rather than sharing this token:

- One read-only Account API token per project, holding only the Read permissions that project queries, stored in 1Password under the project's name.
- Its own `~/.config/<project>/cloudflare-readonly.env` with the `op://` reference and the Account ID, apart from any env file other commands load.
- A proxy that pins the project's own resource ids (its D1 `database_id`, its Worker name), because the token alone cannot: `scripts/prod-access.ts`, `prod-proxy.ts`, `prod-query.ts` and `prod-connect.ts` are small enough to copy and rename.
- A wizard that proves writes are refused before relying on it (stage 5 of `scripts/cloudflare-readonly-wizard.sh`).

## Setting it up

`bash scripts/cloudflare-readonly-wizard.sh` walks the user through creating the token (D1 Read, Workers Tail Read, Workers Observability Read), storing it in 1Password, writing `~/.config/naruhodo/cloudflare-readonly.env` (the `op://` reference and the Account ID, kept apart from `op.env` so `worker:dev` and `smoke` never see a Cloudflare token), checking that a D1 write and a Worker upload are both refused, and logging out of `wrangler`. It is the user's to run: it opens the Cloudflare dashboard and 1Password.
