/**
 * 在真實網站上除錯（目前只支援 Windows）：
 *   npm run debug:chrome   build debug 版外掛 → 用獨立 profile 開 Chrome（帶 remote debugging；已開著就接上）→ 重新載入外掛 → 透過 CDP 錄下除錯記錄
 *   npm run debug:reload   重新 build，並叫已開著的 Chrome 重新載入外掛（之後重新整理分頁、再跑 npm run debug:activate）
 *
 * 外掛 build 到固定位置（不跟 worktree 走），profile 載入一次就好：第一次在那個 Chrome 的
 * chrome://extensions 開「開發人員模式」→「載入未封裝項目」選 EXTENSION_DIR。新版 Chrome 不接受 --load-extension。
 *
 * 錄到的東西寫在 DEBUG_DIR/<session>/：trace.jsonl 一行一筆（src/shared/debug-trace.ts 的記錄，加上外掛各 context 的
 * console 警告／錯誤與未捕捉的例外），圖片（截圖、縮圖、偵測疊圖）在 images/。真實網站的頁面只為了除錯暫存，不要 commit。
 *
 * 選項：--chrome <path>（例如 Playwright 的 Chromium）、--profile <dir>、--port <n>、--load-extension（只有 Chromium 認得）
 * --profile 用短路徑：Chrome 在 profile 底下的 IndexedDB 路徑很深，超過 Windows 260 字元時外掛的 IndexedDB 會開不起來（LOCK: File not found）。
 */
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseTrace } from '../src/shared/debug-trace.ts';
import { build } from './build.ts';
import { extractImages, sessionName, sessionsToPrune } from './debug-session.ts';

const BASE_DIR = join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Local'), 'naruhodo');
export const EXTENSION_DIR = join(BASE_DIR, 'extension');
export const DEBUG_DIR = join(BASE_DIR, 'debug');
const DEFAULT_PROFILE = join(BASE_DIR, 'chrome-profile');
const DEFAULT_CHROME = join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
const DEFAULT_PORT = 9222;
const KEEP_SESSIONS = 10;
const EXTENSION_NAME = 'Naruhodo (debug)';

interface CdpMessage {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
  sessionId?: string;
}

/** 最小的 CDP client：一條 browser 層級的 WebSocket，flatten 模式下各 target 用 sessionId 區分。 */
export async function connectCdp(port: number) {
  const { webSocketDebuggerUrl } = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error(`連不上 ${webSocketDebuggerUrl}`)), { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, { resolve(result: any): void; reject(e: Error): void }>();
  const listeners: ((message: CdpMessage) => void)[] = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage;
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result);
    } else for (const listener of listeners) listener(message);
  });
  return {
    send(method: string, params: object = {}, sessionId?: string): Promise<any> {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(listener: (message: CdpMessage) => void) {
      listeners.push(listener);
    },
    closed: new Promise<void>((resolve) => ws.addEventListener('close', () => resolve())),
    close: () => ws.close(),
  };
}

export type Cdp = Awaited<ReturnType<typeof connectCdp>>;

export async function isListening(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/json/version`).then(
    (r) => r.ok,
    () => false,
  );
}

async function launchChrome({ chrome, profile, port, loadExtension }: { chrome: string; profile: string; port: number; loadExtension: boolean }) {
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check'];
  // 跟 browser/fixtures.ts 一樣兩個都要帶，Chromium 才會載入
  if (loadExtension) args.push(`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`);
  // detached：錄製腳本結束（Ctrl+C）時 Chrome 繼續開著
  spawn(chrome, args, { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 50; i++) {
    if (await isListening(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Chrome 沒有在 port ${port} 開 remote debugging（已經有用同一個 profile 的 Chrome 開著嗎？）`);
}

/** 要收 console 的 target：頁面（content script 在裡面的 isolated world）、SW、offscreen document 等。 */
const SKIPPED_TARGET_TYPES = new Set(['browser', 'tab']);

interface Attached {
  targetId: string;
  type: string;
  url: string;
  /** 這個外掛 content script 的 isolated world（context 名稱就是外掛名稱）。 */
  ourContexts: Set<number>;
}

function consoleText(args: { type: string; value?: unknown; description?: string }[]): string {
  return args.map((a) => (a.type === 'string' ? String(a.value) : (a.description ?? JSON.stringify(a.value)))).join(' ');
}

async function record(cdp: Cdp, sessionDir: string): Promise<void> {
  const tracePath = join(sessionDir, 'trace.jsonl');
  await mkdir(join(sessionDir, 'images'), { recursive: true });
  await writeFile(tracePath, '');
  /** Runtime.enable 會把 target 之前印過的 console 重送一次（例如上一次錄製時的記錄）；比這個時間早的都不收。 */
  const startedAt = Date.now();
  const attached = new Map<string, Attached>();
  /** setDiscoverTargets 會對既有的 target 再送一次 targetCreated；同一個 target 只 attach 一次，記錄才不會重複。 */
  const seen = new Set<string>();
  let imageSeq = 0;
  /** 寫檔照順序來，圖片多的記錄不會被後面的插隊。 */
  let writing = Promise.resolve();

  const write = (entry: Record<string, unknown>, event: string) => {
    writing = writing.then(async () => {
      const { data, images } = extractImages(entry, (ext) => `images/${String(++imageSeq).padStart(5, '0')}-${event.replace(/[^\w-]/g, '_')}.${ext}`);
      await Promise.all(images.map((image) => writeFile(join(sessionDir, image.path), image.bytes)));
      await appendFile(tracePath, `${JSON.stringify(data)}\n`);
    });
  };

  /**
   * 這個外掛的 origin（chrome-extension://<id>）。外掛頁面 attach 時查 manifest 名稱；SW 剛啟動時 chrome.runtime 可能還不能用，
   * 所以收到它的除錯記錄時也記下來。別的外掛的 console 不收。
   */
  const ourOrigins = new Set<string>();
  const originOf = (url: string) => (url.startsWith('chrome-extension://') ? new URL(url).origin : undefined);

  /** 只收這個外掛自己的 console：外掛頁面（SW、offscreen、side panel），或頁面裡 content script 的 isolated world。 */
  const isOurs = (target: Attached, contextId: number | undefined) =>
    ourOrigins.has(originOf(target.url) ?? '') || (contextId !== undefined && target.ourContexts.has(contextId));

  async function checkManifest(sessionId: string, origin: string) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { result } = await cdp.send('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().name', returnByValue: true }, sessionId);
      if (result.type === 'string') {
        if (result.value === EXTENSION_NAME) ourOrigins.add(origin);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  async function attach(targetInfo: { targetId: string; type: string; url: string }) {
    if (SKIPPED_TARGET_TYPES.has(targetInfo.type) || seen.has(targetInfo.targetId)) return;
    seen.add(targetInfo.targetId);
    try {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: targetInfo.targetId, flatten: true });
      attached.set(sessionId, { targetId: targetInfo.targetId, type: targetInfo.type, url: targetInfo.url, ourContexts: new Set() });
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      const origin = originOf(targetInfo.url);
      if (origin !== undefined && !ourOrigins.has(origin)) await checkManifest(sessionId, origin);
    } catch {
      // target 在 attach 前就關掉了
    }
  }

  cdp.on((message) => {
    const { method, params, sessionId } = message;
    if (method === 'Target.targetCreated') void attach(params.targetInfo);
    if (method === 'Target.detachedFromTarget') attached.delete(params.sessionId);
    if (method === 'Target.targetDestroyed') seen.delete(params.targetId);
    if (method === 'Target.targetInfoChanged') {
      for (const target of attached.values()) if (target.targetId === params.targetInfo.targetId) target.url = params.targetInfo.url;
    }
    const target = sessionId ? attached.get(sessionId) : undefined;
    if (!target) return;
    // console 與例外的 timestamp 是 epoch ms
    if ((method === 'Runtime.consoleAPICalled' || method === 'Runtime.exceptionThrown') && params.timestamp < startedAt) return;
    if (method === 'Runtime.executionContextCreated') {
      const { id, name, auxData } = params.context;
      if (auxData?.type === 'isolated' && name === EXTENSION_NAME) target.ourContexts.add(id);
    } else if (method === 'Runtime.executionContextsCleared') {
      target.ourContexts.clear();
    } else if (method === 'Runtime.consoleAPICalled') {
      const text = consoleText(params.args);
      const trace = parseTrace(text);
      if (trace) {
        const origin = originOf(target.url);
        if (origin !== undefined) ourOrigins.add(origin);
        write({ ...trace }, trace.event);
      } else if (isOurs(target, params.executionContextId) && params.type !== 'debug')
        write({ ctx: 'console', event: params.type, at: Math.round(params.timestamp), target: target.type, url: target.url, text }, `console-${params.type}`);
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails;
      if (isOurs(target, details.executionContextId))
        write(
          {
            ctx: 'console',
            event: 'exception',
            at: Math.round(params.timestamp),
            target: target.type,
            url: details.url ?? target.url,
            text: details.exception?.description ?? details.text,
          },
          'exception',
        );
    }
  });

  await cdp.send('Target.setDiscoverTargets', { discover: true });
  const { targetInfos } = await cdp.send('Target.getTargets');
  await Promise.all(targetInfos.map(attach));
  console.log(`錄製中 → ${tracePath}（Ctrl+C 結束；Chrome 會繼續開著）`);
  await cdp.closed;
  await writing;
  console.log('Chrome 已關閉，結束錄製。');
}

const RELOADED_MESSAGE = '已重新載入外掛：重新整理漫畫分頁，再跑 npm run debug:activate（或點外掛圖示）。';

/**
 * 在背景開一個 chrome://extensions 分頁，找到這個外掛後執行 body（裡面可以用 extension，回傳值要能 JSON 化）。
 * 不靠外掛自己的 SW：SW 閒置時會被停掉、不在 target 清單裡。外掛還沒載入（第一次使用）時回傳 null。
 */
async function evalInExtensionsPage(cdp: Cdp, body: string, errorPrefix: string): Promise<unknown> {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'chrome://extensions', background: true });
  try {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const expression = `(async () => {
      for (let i = 0; i < 50 && !chrome.developerPrivate; i++) await new Promise((r) => setTimeout(r, 100));
      const extension = (await chrome.developerPrivate.getExtensionsInfo()).find((e) => e.name === ${JSON.stringify(EXTENSION_NAME)});
      if (!extension) return null;
      ${body}
    })()`;
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(`${errorPrefix}：${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

/** 用 chrome.developerPrivate 重新載入外掛；外掛還沒載入時回傳 false。 */
async function reloadExtension(cdp: Cdp): Promise<boolean> {
  const reloaded = await evalInExtensionsPage(cdp, 'await chrome.developerPrivate.reload(extension.id, { failQuietly: true }); return true;', '重新載入外掛失敗');
  return reloaded === true;
}

/** debug 版外掛的 id（chrome-extension://<id>）；還沒載入時回傳 undefined。 */
export async function extensionId(cdp: Cdp): Promise<string | undefined> {
  const id = await evalInExtensionsPage(cdp, 'return extension.id;', '查外掛 id 失敗');
  return typeof id === 'string' ? id : undefined;
}

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const port = Number(option('--port') ?? DEFAULT_PORT);
  await build({ e2e: false, debug: true, outDir: EXTENSION_DIR });
  console.log(`built debug → ${EXTENSION_DIR}`);

  if (process.argv.includes('--reload')) {
    if (!(await isListening(port))) throw new Error(`port ${port} 沒有開著的 Chrome；先跑 npm run debug:chrome`);
    const cdp = await connectCdp(port);
    const reloaded = await reloadExtension(cdp);
    cdp.close();
    console.log(reloaded ? RELOADED_MESSAGE : `還沒載入「${EXTENSION_NAME}」：請在 chrome://extensions 載入未封裝項目：${EXTENSION_DIR}`);
    return;
  }

  if (!(await isListening(port))) {
    const chrome = option('--chrome') ?? DEFAULT_CHROME;
    const profile = option('--profile') ?? DEFAULT_PROFILE;
    await launchChrome({ chrome, profile, port, loadExtension: process.argv.includes('--load-extension') });
    console.log(`已開啟 Chrome（profile：${profile}）。`);
  }
  // 新開的也要重新載入：Chrome 重開時 unpacked 外掛的 SW 沿用之前註冊的舊腳本（連 manifest 版號變了都一樣），
  // 頁面（side panel、offscreen）卻讀磁碟上的新檔，新舊程式混著跑（#220、#163）。只有重新載入會換掉 SW。
  const cdp = await connectCdp(port);
  const reloaded = await reloadExtension(cdp);
  cdp.close();
  console.log(reloaded ? RELOADED_MESSAGE : `第一次使用請在 chrome://extensions 載入未封裝項目：${EXTENSION_DIR}`);

  await mkdir(DEBUG_DIR, { recursive: true });
  const old = sessionsToPrune(await readdir(DEBUG_DIR), KEEP_SESSIONS - 1);
  await Promise.all(old.map((name) => rm(join(DEBUG_DIR, name), { recursive: true, force: true })));
  await record(await connectCdp(port), join(DEBUG_DIR, sessionName(new Date())));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
