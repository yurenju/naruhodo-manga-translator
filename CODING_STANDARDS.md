# Coding standards

Judgement rules a reviewer checks a change against. Each rule says what to look for and why.

## No real titles or sites

Code, comments, file names, test samples, test URLs and commit messages name no real manga title, character, author, publisher, manga site or e-book reader brand. Sites are named by layout (Canvas Site, E-book Reader), test URLs use reserved domains (`manga.example`), test titles are invented. Vendors we depend on (Cloudflare, Paddle, Anthropic) are fine. Details: [docs/agents/public-repo.md](docs/agents/public-repo.md).

Why: the repo is public. PR #137 had to rename mock sites, routes and identifiers that carried real site names, and that commit's own message repeated them into history.

## e2e waits on explicit conditions

When a Playwright test (browser test or e2e) waits for something inside the extension to happen, it waits on a condition: an e2e-build global (such as `__overlaidRecords`) or `expect.poll` on observable state. A fixed delay (`waitForTimeout`) belongs only in a test asserting that something did *not* happen within a window.

Why: two e2e tests in PR #51 waited 2 seconds and then counted captures; under parallel load the work took longer than 2 seconds and the tests flaked. Waiting on `__overlaidRecords` made them stable.

## A new browser test names what unit cannot catch

A new or extended test in `browser/*.spec.ts` comes with a stated reason (in the PR or the test's comment) for what it catches that a unit test cannot: messages between extension contexts, real layout, scrolling, page turns, screenshots, downloads. A test that checks a rule (an ordering, a status-line format, a cache decision, an edge case) belongs in unit; ask for it to move there, extracting a plain function if needed. Layering: [docs/agents/testing.md](docs/agents/testing.md).

Why: the spec #100 audit found browser tests re-checking rules unit already covered (capture rate, queue order, Notes carry-over), adding seconds and flakiness each, while some rules (Spread page order, backup leaving out the API key) were protected only by a browser test.

## A new `@e2e` tag names what the real models change

A test newly tagged `@e2e` comes with a stated reason for how real OCR models change its result (accuracy, model download, models running on downscaled or cropped screenshots, models reading toolbar text). If FakeEngine's replay gives the same result, the test stays a browser test.

Why: e2e runs real models on one worker and takes minutes; spec #100 found the page-turn test tagged `@e2e` although FakeEngine covers it fully.

## A D1 migration only adds

A new file in `worker/migrations/` only creates tables, or adds columns that are nullable or have a default. Renaming or dropping a column is split across two deploys: the first stops the code from using it, the second drops it after the first is live.

Why: the Worker deploys on merge to main (ADR 0008). The migration lands seconds before the new code, so the old code runs against the new schema; and `wrangler rollback` restores the previous code but not the previous schema. Set as a rule when automatic deploys were chosen, before any incident.

## The hosted API only adds

A change to a path in `src/shared/hosted-api.ts`, or to what the Worker accepts or returns there, keeps every existing field and path working: add fields, add paths, never rename or remove. A breaking change gets a new path, with the old one kept until no supported extension version calls it.

Why: the extension is released by hand and goes through Web Store review, and readers update at their own pace, while the Worker goes live on merge (ADR 0008). Older extensions are always calling the newest Worker.

## A new Worker secret is set before merge

A change that makes the Worker read a new secret says in the PR to run `wrangler secret put <NAME> -c worker/wrangler.jsonc` before merging, and the secret is listed in the comment at the top of `worker/wrangler.jsonc`.

Why: `wrangler deploy` does not check that secrets exist, so the deploy on merge succeeds and the Worker fails only when a request reaches the code (ADR 0008). Vars and bindings are checked by `scripts/wrangler-config.test.ts`; secrets cannot be, because only Cloudflare holds them.
