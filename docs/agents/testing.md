# Testing

**Push it down.** Every layer up adds a browser, models, time and flakiness, so a test goes up a layer only when the layer below cannot catch what it checks. Why the browser layers are split this way: [ADR 0007](../adr/0007-browser-tests-fake-the-ocr-engine.md).

| Layer | Answers | Command | Browser + extension | OCR | LLM | Budget | When |
| --- | --- | --- | --- | --- | --- | --- | --- |
| unit | Is the rule computed right? | `npm test` | no | — | — | < 15 s | every change |
| Worker | Does the Worker's HTTP API answer right? | `npm test` (vitest project `worker`) | no | — | Anthropic faked with `vi.spyOn(fetch)` | shares unit's 15 s | every change |
| browser test | Do the pieces connect? | `npm run test:browser` | real (mock site) | FakeEngine (replayed) | FakeTranslator (in the extension, or in the local Worker) | < 90 s, build and `wrangler dev` included | every change that touches the extension's behaviour |
| e2e | Still right with the real models? | `npm run e2e` | real (mock site) | real models (wasm) | FakeTranslator | none; run only when needed | see below |
| smoke | Does the real Claude API still work? | `npm run smoke` | real (mock site) | real models | real Claude API (direct, and through the local Worker) | — | only when the Claude integration changes; costs money |
| smoke:paddle | Does a real Paddle sandbox checkout reach the Worker? | `npm run smoke:paddle` | real (mock site + local product site) | FakeEngine | — (Paddle sandbox: real checkout overlay, test card, webhook through a cloudflared tunnel) | — | only when the Paddle integration changes; needs `~/.config/naruhodo/paddle-sandbox.env`; a CAPTCHA on the payment screen means stop and ask the developer |

A layer over its budget is a signal that tests have drifted up: find the ones that belong lower.

## Where a test goes

- **unit**, next to the module (`src/**/*.test.ts`): every rule and every edge case — geometry, parsing, reading order, Notes rules, cache hits, queue order, status-line text, what a backup contains. When the rule sits inside a component or a content script, pull it out into a plain function and unit-test that.
- **Worker**, next to the module (`worker/src/**/*.test.ts`): the Hosted Translation backend (ADR 0006) tested from HTTP: send a request to the real Worker, check the response and what later requests see. It runs inside workerd with local D1 (`@cloudflare/vitest-plugin`, the renamed `vitest-pool-workers`); Anthropic and Paddle are faked by `vi.spyOn(globalThis, 'fetch')` (`worker/src/test/paddle.ts` signs webhook events with the test secret); mail goes to the fake mailer (`FAKE_MAIL` in `env.dev`/`env.test`), and tests sign in by reading the code from `DEV_OUTBOX_PATH` (`worker/src/test/http.ts` has `signIn()`). Rules about tokens, quota, webhooks and what the client may not choose go here, not in browser tests. Don't query D1 directly; observe through the API. The exceptions are what the API can't show: that secrets are stored only as hashes, that usage records hold only numbers (no source text, translations, Series names or URLs) and mark Practice Spread translations, and that deleting an Account leaves nothing behind but the Free Pages grant (email hash). To put an Account into a quota state (one page left, none left), use `DEV_FREE_PAGES_PATH` instead of writing to D1.
- **browser test**, in `browser/*.spec.ts`: the wiring unit cannot see — messages between content script, background, offscreen and side panel; real DOM layout; scrolling; page turns; screenshots; real downloads and file pickers. Each feature keeps **one representative path** here; its edge cases are unit tests. A new browser test names what it catches that unit cannot.
- **e2e**: a browser test tagged `{ tag: '@e2e' }` runs in both layers, with FakeEngine and with real OCR. The entry test: **would the real models change this test's result?** Yes for OCR accuracy, model download, and flows where real models run on downscaled or cropped screenshots or must ignore toolbar text; no for anything FakeEngine's replay already covers. `grep -rn "@e2e" browser/` lists the current set. A test that only means something with real models calls `test.skip(fakeOcr, ...)`.

## Regression tests for bugs found on a real site

A bug reproduced on a real manga site ([real-site debugging](real-site-debugging.md)) gets its regression test at the **lowest layer that reproduces it**. When a pure function reproduces it, copy the actual values from the trace (rects, subRects, page views) into a unit test as its data. A browser test is for bugs in the wiring itself: timing between components, messages, real layout.

## Choices made on purpose

- **Each test gets its own Chromium context and mock site**, not one shared per worker: extension state (`chrome.storage`, IndexedDB, activation) would leak into the next test and make it flaky.
- **vitest has no DOM environment** (happy-dom, jsdom): component logic is pulled out into plain functions instead, so no test depends on happy-dom behaving like real Chrome; real rendering stays in browser tests. Revisit only if a large piece of logic cannot leave the DOM.
- **The side panel opens in its own window** (`openSidePanel` in `browser/fixtures.ts`): in the page's window it would be a background tab once the page is brought to the front, its `requestAnimationFrame` stops, and every Playwright click waits about 2 seconds for the element to be stable. The real side panel is visible next to the page too.
- **Timeouts**: browser tests use the config defaults (30 s per test, 10 s per `expect`) and do not set longer ones; a slow wait under FakeEngine is a bug to fix, not a timeout to raise. The long timeouts real OCR needs live only in `playwright.e2e.config.ts`.

## When to run e2e

- Before opening the PR of an integration branch (implement-spec: once, after all tickets are merged, not in each ticket session).
- When a change touches `src/offscreen/` (models, OCR pipeline, Spread splitting, cropping).
- After `npm run record:ocr`.

Ticket sessions and ordinary changes run unit + browser test only.

## FakeEngine and the recording

Browser tests replace the ONNX models with FakeEngine (`src/offscreen/fake-engine.ts`). It recognises which synthetic page it was given by comparing thumbnails, then replays what the real models returned on that page: `testdata/synthetic/recorded-ocr.json`. So browser tests see the real models' boxes and text (including their mistakes), just without running them.

Re-record when the models, detection or OCR change: `npm run site:build && npm run record:ocr`, then commit the JSON and run e2e. The same command also re-records `practice-spread/ocr.json`, the text the Worker uses to recognise the Practice Spread (real OCR on the website's practice page, wasm and WebGPU); re-record it too when the Practice Spread image changes. If FakeEngine throws "認不出這是哪張合成頁", the page it was given is not one of the recorded ranges (a new mock-site layout, or a crop the extension did not make before).

FakeEngine is near-instant. A test that relies on OCR being slow (the side panel layout before the transcript arrives) sets `test.use({ fakeOcrDelayMs })`; rules about OCR being slower than page turns, such as queue scheduling, are unit tests. Don't add a delay just to make a flaky test pass: instant OCR has already exposed a real product race on the mock e-book reader (ADR 0007).

## Flaky tests

Browser tests have no retries: FakeEngine is deterministic, so a test that fails then passes points at a real race in the extension or the test. Fix it, or mark it `test.fixme(...)` with the reason and open an issue; do not add retries. e2e retries once, because real OCR speed depends on machine load.

Fixed delays follow [CODING_STANDARDS.md](../../CODING_STANDARDS.md): wait on a condition, except when asserting that something did *not* happen.
