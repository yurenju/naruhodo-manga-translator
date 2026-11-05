/**
 * 在開著的 debug Chrome（npm run debug:chrome）裡，對外掛的某個 context 執行一段程式，印出 JSON 結果。
 * 量時間、效能這類 e2e 的 Playwright Chromium 重現不了的東西用它。
 *   npm run debug:eval -- sw measure.js                 檔案內容是一個可 await 的運算式
 *   npm run debug:eval -- offscreen -e "navigator.gpu !== undefined"
 *   npm run debug:eval -- page -e "location.href"       漫畫分頁的 main world
 *   npm run debug:eval -- content -e "document.querySelectorAll('[data-fit]').length"   content script 的 isolated world
 * context：sw、offscreen、page、content（見 scripts/debug-targets.ts）。
 * SW 裡多了 activeTab()：最後聚焦視窗的作用中分頁。
 *
 * 選項：--timeout <秒>（預設 30；offscreen 裡等 requestAnimationFrame 會永遠卡住）、--url <字串>（page／content 挑 url 含它的分頁）、--port <n>
 *
 * 直接對 /json/list 的 target 開 WebSocket，不經 Playwright：connectOverCDP 看不到 offscreen document。
 */
import { readFile } from 'node:fs/promises';
import { buildExpression, candidateTargets, CONTEXTS, isContext, isOurExtension, MANIFEST_NAME_EXPRESSION, type Context, type TargetInfo } from './debug-targets.ts';

const DEFAULT_PORT = 9222;
const DEFAULT_TIMEOUT_S = 30;

/** 對單一 target 的 CDP 連線。 */
async function connectTarget(url: string) {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error(`連不上 ${url}`)), { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, { resolve(result: any): void; reject(e: Error): void }>();
  const listeners: ((method: string, params: any) => void)[] = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result);
    } else for (const listener of listeners) listener(message.method, message.params);
  });
  return {
    send(method: string, params: object = {}): Promise<any> {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(listener: (method: string, params: any) => void) {
      listeners.push(listener);
    },
    close: () => ws.close(),
  };
}

type Connection = Awaited<ReturnType<typeof connectTarget>>;

async function manifestName(connection: Connection): Promise<unknown> {
  const { result } = await connection.send('Runtime.evaluate', { expression: MANIFEST_NAME_EXPRESSION, awaitPromise: true, returnByValue: true });
  return result.value;
}

/** content script 的 isolated world：Runtime.enable 會把既有的 context 都送一次 executionContextCreated。 */
async function contentContextId(connection: Connection): Promise<number> {
  const contexts: { id: number; name: string; auxData?: { type?: string } }[] = [];
  connection.on((method, params) => {
    if (method === 'Runtime.executionContextCreated') contexts.push(params.context);
  });
  await connection.send('Runtime.enable');
  const ours = contexts.find((c) => c.auxData?.type === 'isolated' && isOurExtension(c.name));
  if (!ours) throw new Error('這個分頁裡沒有外掛的 content script：重新整理分頁後跑 npm run debug:activate');
  return ours.id;
}

const NOT_FOUND: Record<Context, string> = {
  sw: '找不到外掛的 service worker：閒置時會被停掉，跑 npm run debug:panel 叫醒它',
  offscreen:
    "找不到外掛的 offscreen document：外掛第一次偵測或翻譯時才會建立，閒置一陣子會被關掉。手動建立：npm run debug:eval -- sw -e \"chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'debug' })\"",
  page: '找不到網頁分頁',
  content: '找不到網頁分頁',
};

/** 挑出目標並連上；sw／offscreen 逐一問 manifest 名稱，page／content 取最近用過的分頁。 */
async function connect(targets: readonly TargetInfo[], context: Context, urlFilter?: string): Promise<{ connection: Connection; target: TargetInfo }> {
  for (const target of candidateTargets(targets, context, urlFilter)) {
    const connection = await connectTarget(target.webSocketDebuggerUrl!);
    if (context === 'page' || context === 'content' || isOurExtension(await manifestName(connection))) return { connection, target };
    connection.close();
  }
  throw new Error(NOT_FOUND[context]);
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [context, file] = args;
  if (!isContext(context)) throw new Error(`用法：npm run debug:eval -- <${CONTEXTS.join('|')}> <file.js> 或 -e "<運算式>"`);
  const inline = option(args, '-e');
  const code = inline ?? (file !== undefined && !file.startsWith('-') ? await readFile(file, 'utf8') : undefined);
  if (code === undefined) throw new Error('要給一個檔案，或用 -e "<運算式>"');
  const port = Number(option(args, '--port') ?? DEFAULT_PORT);
  const timeoutS = Number(option(args, '--timeout') ?? DEFAULT_TIMEOUT_S);

  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(
    (r) => r.json() as Promise<TargetInfo[]>,
    () => {
      throw new Error(`port ${port} 沒有開著的 Chrome；先跑 npm run debug:chrome`);
    },
  );
  const { connection, target } = await connect(list, context, option(args, '--url'));
  console.error(`${context} → ${target.url}`);
  try {
    const contextId = context === 'content' ? await contentContextId(connection) : undefined;
    const evaluation = connection.send('Runtime.evaluate', {
      expression: buildExpression(code, context),
      awaitPromise: true,
      returnByValue: true,
      ...(contextId === undefined ? {} : { contextId }),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${timeoutS} 秒內沒有結果（程式還在 ${context} 裡跑；offscreen document 裡 requestAnimationFrame 永遠不會觸發）`)),
        timeoutS * 1000,
      );
    });
    const { result, exceptionDetails } = await Promise.race([evaluation, timeout]).finally(() => clearTimeout(timer));
    if (exceptionDetails) throw new Error(`程式丟出例外：${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    console.log(result.type === 'undefined' ? 'undefined' : JSON.stringify(result.value, null, 2));
  } finally {
    connection.close();
  }
}

try {
  await main();
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
