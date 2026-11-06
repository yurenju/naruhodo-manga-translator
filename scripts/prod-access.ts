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

/** 拿掉字串、識別字引號與註解裡的內容，關鍵字檢查才不會被 `WHERE note = 'delete'` 誤判或被註解藏住。 */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/\[[^\]]*\]/g, '[]')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * SQL 是不是只讀；不是的話回傳原因。token 本身就不能寫，這是第二道防線（ADR 0011）：
 * 只接受單一個 SELECT／WITH／EXPLAIN／PRAGMA 語句，WITH 後面不能接寫入，PRAGMA 不能設定值。
 */
export function readOnlySqlProblem(sql: string): string | undefined {
  const code = stripLiteralsAndComments(sql).trim().replace(/;\s*$/, '');
  if (!code) return 'SQL 是空的';
  if (code.includes(';')) return '一次只能一個語句';
  const first = /^\w+/.exec(code)?.[0].toUpperCase();
  if (!first || !['SELECT', 'WITH', 'EXPLAIN', 'PRAGMA'].includes(first)) return `只接受 SELECT、WITH、EXPLAIN、PRAGMA 開頭的語句（收到 ${first ?? '空白'}）`;
  const write = WRITE_KEYWORDS.exec(code);
  if (write) return `唯讀：不能有 ${write[0].toUpperCase()}`;
  if (first === 'PRAGMA' && code.includes('=')) return '唯讀：PRAGMA 不能設定值';
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

interface LogEvent {
  timestamp?: number;
  $metadata?: { level?: string; message?: unknown; error?: unknown; url?: string; statusCode?: number };
}

/**
 * telemetry query 的回應整理成一行一筆：`時間 等級 訊息`。文件沒寫清楚回應的結構，
 * 找不到 events 陣列就回傳 undefined，呼叫端改印原始 JSON。
 */
export function formatLogEvents(response: unknown): string[] | undefined {
  const result = (response as { result?: { events?: { events?: unknown } | unknown[] } })?.result;
  const raw = Array.isArray(result?.events) ? result.events : (result?.events as { events?: unknown } | undefined)?.events;
  if (!Array.isArray(raw)) return undefined;
  return (raw as LogEvent[])
    .slice()
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
    .map((event) => {
      const meta = event.$metadata ?? {};
      const time = typeof event.timestamp === 'number' ? new Date(event.timestamp).toISOString() : '?';
      const text = [meta.message, meta.error].filter((part) => part !== undefined && part !== '').map((part) => (typeof part === 'string' ? part : JSON.stringify(part)));
      const request = meta.url ? ` [${meta.statusCode ?? ''} ${meta.url}]` : '';
      return `${time} ${meta.level ?? '-'}${request} ${text.join(' ')}`.trimEnd();
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
