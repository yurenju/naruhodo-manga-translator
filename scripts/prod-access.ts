/**
 * 本機唯讀查 production（ADR 0011）的規則：proxy 轉發什麼、擋什麼，以及 log 查詢怎麼組、怎麼印。
 * 沒有 I/O，scripts/prod-proxy.ts 與 scripts/prod-query.ts 共用，測試在 prod-access.test.ts。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** proxy 只聽這個位址；prod-query.ts 也打這裡。 */
export const PROXY_HOST = '127.0.0.1';
export const PROXY_PORT = 8790;
/** 閒置這麼久沒有請求（也沒有 tail 在跑），proxy 就結束，token 跟著消失。 */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** 唯一放行的 Worker（worker/wrangler.jsonc 的 name）。 */
export const WORKER_NAME = 'naruhodo-api';
/** 1Password 參照與 Account ID；跟 op.env 分開，worker:dev、smoke 拿不到 Cloudflare token。 */
export const READONLY_ENV_FILE = join(homedir(), '.config', 'naruhodo', 'cloudflare-readonly.env');

const FORMAT = `請建立 ${READONLY_ENV_FILE}，內容是唯讀 token 的 1Password 參照（不是 token 本身）與 Account ID：
  CLOUDFLARE_API_TOKEN=op://<vault>/<item>/<field>
  CLOUDFLARE_ACCOUNT_ID=<32 個十六進位字元>
（bash scripts/cloudflare-readonly-wizard.sh 會帶你建立）`;

/** cloudflare-readonly.env 解析後的內容（undefined＝檔案不存在）能不能用；不能用時回傳給開發者看的說明。 */
export function readonlyEnvProblem(env: Record<string, string> | undefined): string | undefined {
  if (env === undefined) return `找不到 ${READONLY_ENV_FILE}。\n${FORMAT}`;
  if (!env.CLOUDFLARE_API_TOKEN?.startsWith('op://')) return `${READONLY_ENV_FILE} 的 CLOUDFLARE_API_TOKEN 要是 op:// 參照。\n${FORMAT}`;
  if (!/^[0-9a-f]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? '')) return `${READONLY_ENV_FILE} 的 CLOUDFLARE_ACCOUNT_ID 不對。\n${FORMAT}`;
  return undefined;
}

// REPLACE 只擋 `REPLACE INTO`：replace() 是常用的字串函式
const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|REPLACE(?=\s+INTO\b)|UPSERT|CREATE|DROP|ALTER|ATTACH|DETACH|VACUUM|REINDEX|ANALYZE)\b/i;

/** 成對的引號：字串（'）、識別字（" ` [ ]）。 */
const QUOTE_CLOSE: Record<string, string> = { "'": "'", '"': '"', '`': '`', '[': ']' };

/**
 * 由左到右掃一次，把字串、識別字引號與註解的內容換成空白，只留下 SQLite 會當成程式碼的部分；引號沒成對回傳 undefined。
 * 引號與註解要一起處理：先拿掉其中一種的話，`-- '` 這種註解裡的引號會把後面的語句吃成字串，讓寫入躲過檢查。
 */
function codeOnly(sql: string): string | undefined {
  let code = '';
  let i = 0;
  while (i < sql.length) {
    const char = sql.charAt(i);
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      code += ' ';
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      code += ' ';
    } else if (QUOTE_CLOSE[char] !== undefined) {
      const close = QUOTE_CLOSE[char];
      let j = i + 1;
      // ' " ` 用連續兩個表示自己（'it''s'）；[ ] 不能跳脫
      while (j < sql.length && !(sql[j] === close && (close === ']' || sql[j + 1] !== close))) j += sql[j] === close ? 2 : 1;
      if (j >= sql.length) return undefined;
      code += `${char}${close}`;
      i = j + 1;
    } else {
      code += char;
      i += 1;
    }
  }
  return code;
}

/** 帶參數也只是讀取的 PRAGMA（查結構與檢查）。其他 PRAGMA 只能不帶參數讀目前的值：`PRAGMA x(0)` 跟 `PRAGMA x = 0` 一樣會設定。 */
const READ_PRAGMAS_WITH_ARGUMENT = ['table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list', 'foreign_key_check'];

/**
 * SQL 是不是只讀；不是的話回傳原因。token 本身就不能寫，這是第二道防線（ADR 0011）：
 * 只接受單一個 SELECT／WITH／EXPLAIN／PRAGMA 語句，WITH 後面不能接寫入，PRAGMA 不能設定值。
 */
export function readOnlySqlProblem(sql: string): string | undefined {
  const stripped = codeOnly(sql);
  if (stripped === undefined) return '引號沒有成對';
  const code = stripped.trim().replace(/;\s*$/, '');
  if (!code) return 'SQL 是空的';
  if (code.includes(';')) return '一次只能一個語句';
  const first = /^\w+/.exec(code)?.[0].toUpperCase();
  if (!first || !['SELECT', 'WITH', 'EXPLAIN', 'PRAGMA'].includes(first)) return `只接受 SELECT、WITH、EXPLAIN、PRAGMA 開頭的語句（收到 ${first ?? '空白'}）`;
  const write = WRITE_KEYWORDS.exec(code);
  if (write) return `唯讀：不能有 ${write[0].toUpperCase()}`;
  if (first === 'PRAGMA') {
    if (code.includes('=')) return '唯讀：PRAGMA 不能設定值';
    const name = /^PRAGMA\s+(?:\w+\.)?(\w+)/i.exec(code)?.[1]?.toLowerCase();
    if (code.includes('(') && !READ_PRAGMAS_WITH_ARGUMENT.includes(name ?? '')) return `唯讀：PRAGMA ${name ?? ''} 帶參數會設定值，只能不帶參數讀`;
  }
  return undefined;
}

/** `30m`、`2h`、`1d` 換成毫秒；格式不對回傳 undefined。 */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d+)\s*([mhd])$/.exec(text.trim());
  if (!match) return undefined;
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 'm' | 'h' | 'd'];
  return Number(match[1]) * unit;
}

export interface LogsRequest {
  /** 往回查多久（毫秒）。 */
  sinceMs: number;
  /** 只要訊息裡有這段文字的（不分大小寫）。 */
  search?: string;
  limit?: number;
}

/** Workers Logs 每筆查詢最多回 100 筆（telemetry query 的 parameters.limit）。 */
export const MAX_LOG_LIMIT = 100;

/** 組 telemetry query 的 body：固定只查 WORKER_NAME，呼叫端只能決定時間範圍、搜尋文字與筆數。 */
export function logsQueryBody(request: LogsRequest, now: number) {
  const limit = Math.min(Math.max(1, Math.floor(request.limit ?? 50)), MAX_LOG_LIMIT);
  return {
    queryId: 'naruhodo-prod-logs',
    view: 'events',
    dry: true,
    limit,
    timeframe: { from: now - request.sinceMs, to: now },
    parameters: {
      datasets: [],
      filterCombination: 'and',
      filters: [{ key: '$workers.scriptName', operation: 'eq', type: 'string', value: WORKER_NAME }],
      ...(request.search ? { needle: { value: request.search, matchCase: false } } : {}),
      limit,
    },
  };
}

/** proxy 收到的 /logs body 轉成 LogsRequest；不合法回傳原因字串。 */
export function parseLogsRequest(body: unknown): LogsRequest | string {
  if (typeof body !== 'object' || body === null) return 'body 要是 JSON 物件';
  const { sinceMs, search, limit } = body as Record<string, unknown>;
  if (typeof sinceMs !== 'number' || !(sinceMs > 0) || sinceMs > 7 * 86_400_000) return 'sinceMs 要是 7 天以內的正數（Workers Logs 只留 7 天）';
  if (search !== undefined && typeof search !== 'string') return 'search 要是字串';
  if (limit !== undefined && typeof limit !== 'number') return 'limit 要是數字';
  return { sinceMs, search: search || undefined, limit };
}

/** 實際回應裡用得到的欄位：請求事件（type cf-worker-event）的狀態碼與耗時在 $workers，console.log 的內容在 $metadata.message。 */
interface LogEvent {
  timestamp?: number;
  $metadata?: { level?: string; message?: unknown; error?: unknown; trigger?: string; type?: string };
  $workers?: { outcome?: string; wallTimeMs?: number; event?: { response?: { status?: number } } };
}

const asText = (part: unknown) => (typeof part === 'string' ? part : JSON.stringify(part));

/** events 陣列：文件寫的是 result.events.events，也接受 result.events 直接是陣列。 */
function logEventsIn(response: unknown): LogEvent[] | undefined {
  const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined);
  const events = field(field(response, 'result'), 'events');
  const list = Array.isArray(events) ? events : field(events, 'events');
  return Array.isArray(list) ? (list as LogEvent[]) : undefined;
}

/**
 * telemetry query 的回應整理成一行一筆：`時間 等級 訊息`。文件沒寫清楚回應的結構，
 * 找不到 events 陣列就回傳 undefined，呼叫端改印原始 JSON。
 */
export function formatLogEvents(response: unknown): string[] | undefined {
  const events = logEventsIn(response);
  if (!events) return undefined;
  return events
    .slice()
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
    .map((event) => {
      const meta = event.$metadata ?? {};
      const workers = event.$workers ?? {};
      const time = typeof event.timestamp === 'number' ? new Date(event.timestamp).toISOString() : '?';
      const error = meta.error !== undefined && meta.error !== '' ? [asText(meta.error)] : [];
      if (meta.type === 'cf-worker-event') {
        // 請求本身：`POST /v1/translate 200 2851ms`，outcome 不是 ok（exception、exceededCpu…）才印
        const request = [meta.trigger ?? asText(meta.message), workers.event?.response?.status ?? '-', workers.wallTimeMs === undefined ? '' : `${workers.wallTimeMs}ms`];
        if (workers.outcome && workers.outcome !== 'ok') request.push(workers.outcome);
        return [time, meta.level ?? '-', ...request, ...error].filter((part) => part !== '').join(' ');
      }
      return [time, meta.level ?? '-', ...(meta.message === undefined ? [] : [asText(meta.message)]), ...error].join(' ');
    });
}

/**
 * 請求是不是本機的程式送來的：Host 要是 proxy 自己（擋 DNS rebinding），而且不能有 Origin
 * （瀏覽器裡的網頁打 localhost 一定會帶 Origin；本機 CLI 不會）。
 */
export function isLocalClient(headers: { host?: string; origin?: string }): boolean {
  if (headers.origin !== undefined) return false;
  return headers.host === `${PROXY_HOST}:${PROXY_PORT}` || headers.host === `localhost:${PROXY_PORT}`;
}
