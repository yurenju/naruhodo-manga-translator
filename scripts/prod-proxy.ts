/**
 * 本機唯讀 proxy（ADR 0011）：由 `npm run prod:connect` 在 op run 底下啟動，唯讀 token 只在這個行程的環境變數裡。
 * 只聽 127.0.0.1，只轉發三件事，規則在 prod-access.ts：
 *   POST /sql   {sql}                      → naruhodo 的 D1（database_id 讀 worker/wrangler.jsonc），只接受唯讀語句
 *   POST /logs  {sinceMs, search?, limit?} → naruhodo-api 的 Workers Logs
 *   POST /tail  {}                         → wrangler tail naruhodo-api，NDJSON 串流到結束
 * 閒置 IDLE_TIMEOUT_MS 沒有請求（也沒有 tail 在跑）就結束。
 */
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { experimental_readRawConfig } from 'wrangler';
import { IDLE_TIMEOUT_MS, isLocalClient, logsQueryBody, parseLogsRequest, PROXY_HOST, PROXY_PORT, readOnlySqlProblem, WORKER_NAME } from './prod-access.ts';

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !accountId) {
  console.error('缺少 CLOUDFLARE_API_TOKEN 或 CLOUDFLARE_ACCOUNT_ID：請用 npm run prod:connect 啟動');
  process.exit(1);
}

const { rawConfig } = experimental_readRawConfig({ config: 'worker/wrangler.jsonc' });
const databaseId = rawConfig.d1_databases?.[0]?.database_id;
if (!databaseId) {
  console.error('worker/wrangler.jsonc 最上層沒有 D1 的 database_id');
  process.exit(1);
}

const API = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;

async function cloudflare(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({ errors: [{ message: `HTTP ${response.status}，回應不是 JSON` }] })) };
}

function send(res: ServerResponse, status: number, json: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(json));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of req) text += chunk;
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return undefined;
  }
}

let activeTails = 0;
let idleTimer: NodeJS.Timeout | undefined;
function touch(): void {
  clearTimeout(idleTimer);
  if (activeTails > 0) return;
  idleTimer = setTimeout(() => {
    console.log(`閒置 ${IDLE_TIMEOUT_MS / 60_000} 分鐘，結束（token 跟著消失）。要再查就重跑 npm run prod:connect`);
    process.exit(0);
  }, IDLE_TIMEOUT_MS);
}

function tail(req: IncomingMessage, res: ServerResponse): void {
  // wrangler 從這個行程繼承 token；用 node 直接跑 wrangler.js，Windows 不必經過 npx.cmd
  const wrangler = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
  const child = spawn(process.execPath, [wrangler, 'tail', WORKER_NAME, '--format', 'json'], {
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeTails += 1;
  touch();
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  child.stdout.pipe(res, { end: false });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const stop = () => child.kill();
  req.on('close', stop);
  child.on('exit', (code) => {
    activeTails -= 1;
    touch();
    req.off('close', stop);
    res.end(code ? `${JSON.stringify({ error: `wrangler tail 結束（exit ${code}），錯誤在 prod:connect 的終端機` })}\n` : undefined);
  });
}

const server = createServer(async (req, res) => {
  touch();
  if (!isLocalClient(req.headers)) return send(res, 403, { error: '只接受本機 CLI 的請求（npm run prod:sql／prod:logs／prod:tail）' });
  if (req.method !== 'POST') return send(res, 405, { error: '只接受 POST' });
  const body = await readJson(req);
  if (body === undefined) return send(res, 400, { error: 'body 不是 JSON' });
  try {
    switch (req.url) {
      case '/sql': {
        const sql = (body as { sql?: unknown }).sql;
        if (typeof sql !== 'string') return send(res, 400, { error: 'body 要有 sql 字串' });
        const problem = readOnlySqlProblem(sql);
        if (problem) return send(res, 400, { error: problem });
        console.log(`sql  ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
        const { status, json } = await cloudflare(`/d1/database/${databaseId}/query`, { sql });
        return send(res, status, json);
      }
      case '/logs': {
        const request = parseLogsRequest(body);
        if (typeof request === 'string') return send(res, 400, { error: request });
        console.log(`logs ${request.sinceMs / 60_000} 分鐘${request.search ? ` 「${request.search}」` : ''}`);
        const { status, json } = await cloudflare('/workers/observability/telemetry/query', logsQueryBody(request, Date.now()));
        return send(res, status, json);
      }
      case '/tail':
        console.log('tail 開始');
        return tail(req, res);
      default:
        return send(res, 404, { error: '只有 /sql、/logs、/tail' });
    }
  } catch (error) {
    return send(res, 502, { error: `連 Cloudflare 失敗：${(error as Error).message}` });
  }
});

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE' ? `port ${PROXY_PORT} 已經有人在用：proxy 可能已經開著了，直接用 npm run prod:sql` : error.message);
  process.exit(1);
});

server.listen(PROXY_PORT, PROXY_HOST, () => {
  touch();
  console.log(`連線中 → http://${PROXY_HOST}:${PROXY_PORT}（唯讀；閒置 ${IDLE_TIMEOUT_MS / 60_000} 分鐘自動結束，Ctrl-C 立刻結束）`);
});
