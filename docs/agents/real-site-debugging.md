# Real-site debugging

How to debug the extension on a real manga site, where the e2e mock site cannot reproduce the problem. You drive the browser over CDP and read a **trace** of everything the pipeline did; the user only sets up the profile once, and steps in for the exceptions below. Windows only.

Local flows that need no real site (the mock site, a local Worker, Paddle sandbox) are not debugged here: write them as Playwright tests on the e2e build, which already opens the side panel and activates without a click (`openSidePanel`, `testActivate` in `browser/fixtures.ts`).

The trace covers, per Page: page-turn signals → Page candidates (with why the rest were rejected) → capture → crop and Page hash → cache hit/miss → detection and OCR → LLM request/response → overlay layout, and every way the overlay hides or reattaches. Console warnings, errors and uncaught exceptions from the extension's own contexts are recorded too.

## Steps

1. **Start the recorder** in a Terminal panel tab (it runs until Chrome closes): `npm run debug:chrome`. A fresh worktree has no `node_modules` yet, and the build then fails with an `ENOENT` on `node_modules\kuromoji\dict`: check that the folder exists first, and if it does not, run `npm ci; npm run debug:chrome` instead. It is ready when it prints `錄製中 →` and the session folder. It builds the debug flavour to `%LOCALAPPDATA%\naruhodo\extension`, opens Chrome with its own profile and remote debugging, and records over CDP. If that Chrome is already open, it attaches instead of launching. Either way it then reloads the extension: on a browser restart Chrome keeps running the unpacked extension's previously registered service worker script, even after the files or the manifest version change, while pages such as the side panel and offscreen document load the new files (#220).
2. **First run only, the user sets up the profile** (it persists): in that Chrome, `chrome://extensions` → Developer mode → Load unpacked → `%LOCALAPPDATA%\naruhodo\extension`; set the API key in the side panel; log in to the site. Hand these steps to the user, then wait. You never type the user's site passwords.
3. **Reproduce the bug yourself**: open the manga page (CDP `Target.createTarget`, or ask the user to leave it on the starting page), then `npm run debug:activate` (add `--url <part of the url>` when several tabs are open). It opens that tab's side panel as its own window (`sidepanel.html?tabId=N`, like `openSidePanel`) and sends `test:activate`, the same activation as an icon click; it waits until the panel shows 已啟動. `npm run debug:panel` only opens the panel window. Then turn pages and operate the panel over CDP until the problem shows. The content script only exists after activation, so nothing from the page is traced before it.
4. **Read the trace** (below) until you can name the record where behaviour departs from what you expected.
5. **After a code change**, `npm run debug:reload` in a Terminal panel tab rebuilds and reloads the extension; refresh the tab (CDP `Page.reload`) and run `npm run debug:activate` again (a reload orphans the old content script).

### When the user still has to click

The debug build declares `<all_urls>` and accepts `test:activate`, like the e2e build, so activation does not depend on `activeTab`. That hides two kinds of bug; for these, ask the user to refresh the tab and click the extension icon instead of `debug:activate`:

- **`activeTab` behaviour**: Chrome grants `activeTab` only on the click and revokes it on navigation; with `<all_urls>` none of that happens.
- **The real side panel**: `chrome.sidePanel.open` needs a user gesture, so `debug:activate` uses a 400 px window. A layout problem that only appears in Chrome's own side panel needs the user to open it.

Run both build commands in the Terminal panel: files the Bash and PowerShell tools write under `%LOCALAPPDATA%` stay invisible to the Terminal and to the Chrome it opened, while the Terminal's writes are visible to the tools. Reading traces, `debug:summary` and `debug:eval` all work from Bash.

## Reading the trace

Each recording is a session folder `%LOCALAPPDATA%\naruhodo\debug\<YYYYMMDD-HHmmss>\` holding `trace.jsonl` (one record per line) and `images/`. The latest 10 sessions are kept.

- `npm run debug:summary` prints event counts and a compact timeline of the latest session; pass a session name for another one, `--grep <event>` to filter, `--since <line>` to print only what was recorded after the last line you read. Each line starts with its line number in `trace.jsonl`: read that line for the full record. The timeline drops what is bulky: `crop` shows each Page as `anchorId:hash` plus `ms`, `overlay:show` shows only the fit count and whether any was truncated, and image paths are left out; LLM text, rects, fit regions and images are all in the full line.
- Follow one Page by its `pageHash`. Offscreen `analyze` records carry only `anchorId`; link them through the `crop` record with the same `anchorId`.
- Match the user's screenshot by time and by the images: `capture` is the full screenshot (overlay hidden, so it never shows our translation), `crop` thumbnails are each Page, and `analyze` `detections` draws the detector output on the Page (blue = Balloon box, red = text box, green = Loose Text, numbers = reading order).
- Event names and their fields live at the call sites: `grep -rn "trace('" src`.

## Measuring in real Chrome

Timing and performance bugs need measuring in the debug Chrome: e2e runs Playwright's Chromium, which is far faster at the steps that matter and cannot reproduce them. Known differences:

| | Real Chrome | Playwright Chromium |
| --- | --- | --- |
| `chrome.tabs.captureVisibleTab` | ~0.25 s while something repaints; ~1.6 s on a still page | ~80 ms |
| `OffscreenCanvas.convertToBlob` in the offscreen document | ~1 s | ~55 ms |
| `requestAnimationFrame` in the offscreen document | never fires | — |

`captureVisibleTab` waits for a new compositor frame, and a still page produces none until a timeout. So every capture runs a repaint animation the screenshot cannot see (`src/content/repaint.ts`, #60): a canvas-per-Page site went from ~1.6 s to ~0.25 s, while an e-book reader that repaints on its own was already ~0.25 s. To time captures by hand, call `captureVisibleTab` from the SW at least 500 ms apart (Chrome allows two per second), and send the tab `content:prepareCapture` (with a `mark` of 0 or 1) before and `content:finishCapture` after each one; without them you measure the still-page timeout. Any change to what the page draws during capture must leave the screenshot byte-identical: compare captures with and without it. The one exception is the frame mark (`src/shared/frame-mark.ts`): two CSS px in the viewport's top-left corner that prove the screenshot came after `prepareCapture` (under load `captureVisibleTab` sometimes returns an older frame, with the site's toolbar and our status chip still in it). The offscreen document paints the mark over with the pixels beside it before cropping, so compare screenshots after that step, not raw ones.

`npm run debug:eval -- <sw|offscreen|page|content> <file.js>` (or `-e "<expression>"`) runs an awaitable expression in that context of the open debug Chrome and prints the result as JSON. `content` is the content script's isolated world in the manga tab; `page` is that tab's main world. It picks this extension's SW and offscreen document by manifest name, defines `activeTab()` in the SW (the manga tab: the extension has no `tabs` permission, so `chrome.tabs.query` shows no URLs), and gives up after `--timeout` seconds (default 30). The offscreen document exists only after the extension's first detection or translation and is closed again after a while idle; the SW only while awake: click the icon first. To get an offscreen document without translating, create it from the SW: `npm run debug:eval -- sw -e "chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'debug' })"`. `chrome.runtime.getManifest` is undefined in the offscreen document, so read the manifest there with `fetch('/manifest.json')`; its Cache Storage `models-v1` holds the OCR models, keyed by their Hugging Face URL (`src/offscreen/models/model-files.ts`), for re-running OCR on a crop by hand.

## Adding a trace

Get a tracer with `createTrace(ctx)` from `src/shared/trace.ts` and call it with an event name and a data object. It is a no-op outside the debug build and the build test keeps the trace code out of prod; wrap any work done only for the trace (extra measuring, building arrays) in `if (__DEBUG__)` so prod skips it too. A string value starting with `data:image/` is saved as a file in `images/`. Keep the API key out of trace data.

## Handling real pages

Screenshots of real sites stay in `%LOCALAPPDATA%` and never enter the repo; neither do the site's or the title's real names ([public-repo.md](public-repo.md)). Delete a session folder once its bug is fixed. The debug Chrome listens on port 9222, so any local program can drive that profile while it is open.
