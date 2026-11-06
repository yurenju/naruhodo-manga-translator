/**
 * 查 production（唯讀，ADR 0011），打 `npm run prod:connect` 開著的本機 proxy，不會跳 1Password 授權：
 *   npm run prod:sql -- "SELECT …"                       D1 查詢，印出結果的 JSON
 *   npm run prod:logs -- [--since 1h] [--search 文字] [--limit 50] [--json]
 *                                                        Workers Logs（最多 7 天前），一行一筆；--json 印原始回應
 *   npm run prod:tail                                    即時 log，Ctrl-C 結束
 */
import { formatLogEvents, parseDuration, PROXY_HOST, PROXY_PORT } from './prod-access.ts';

const BASE = `http://${PROXY_HOST}:${PROXY_PORT}`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function post(path: string, body: unknown): Promise<Response> {
  try {
    return await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    fail('proxy 沒開：先在 Terminal panel 跑 npm run prod:connect（會跳一次 1Password 授權），看到「連線中 →」再查');
  }
}

/** Cloudflare 的錯誤（errors[].message）或 proxy 自己的錯誤（error）。 */
function errorText(json: unknown): string {
  const { error, errors } = (json ?? {}) as { error?: string; errors?: { code?: number; message?: string }[] };
  return error ?? errors?.map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('\n') ?? JSON.stringify(json);
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function sql(args: string[]): Promise<void> {
  const text = args.join(' ').trim();
  if (!text) fail('用法：npm run prod:sql -- "SELECT …"');
  const response = await post('/sql', { sql: text });
  const json = (await response.json()) as { result?: { results?: unknown[]; meta?: unknown }[] };
  if (!response.ok) fail(errorText(json));
  for (const result of json.result ?? []) console.log(JSON.stringify(result.results, null, 2));
}

async function logs(args: string[]): Promise<void> {
  const sinceMs = parseDuration(flag(args, '--since') ?? '1h');
  if (sinceMs === undefined) fail('--since 的格式是 30m、2h、1d');
  const limit = flag(args, '--limit');
  const response = await post('/logs', { sinceMs, search: flag(args, '--search'), limit: limit ? Number(limit) : undefined });
  const json = await response.json();
  if (!response.ok) fail(errorText(json));
  const lines = args.includes('--json') ? undefined : formatLogEvents(json);
  console.log(lines ? lines.join('\n') || '（這段時間沒有 log）' : JSON.stringify(json, null, 2));
}

async function tail(): Promise<void> {
  const response = await post('/tail', {});
  if (!response.ok || !response.body) fail(errorText(await response.json()));
  for await (const chunk of response.body) process.stdout.write(chunk);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'sql') await sql(args);
else if (command === 'logs') await logs(args);
else if (command === 'tail') await tail();
else fail('用法：node scripts/prod-query.ts <sql|logs|tail> …');
