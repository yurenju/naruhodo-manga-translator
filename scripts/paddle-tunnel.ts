/**
 * 讓 Paddle sandbox 的 webhook 送得到本機的 Worker：
 *   node scripts/paddle-tunnel.ts          開 cloudflared quick tunnel 轉到 localhost:8787（wrangler dev），
 *                                          再用 Paddle API 把 webhook destination 改成這次的 tunnel 網址
 *   node scripts/paddle-tunnel.ts --echo   同上，另外自己在 8787 開一個小伺服器：驗 Paddle-Signature、印出事件，
 *                                          Worker 還沒寫好、或只想確認 Paddle 設定時用（跟 wrangler dev 擇一）
 *
 * quick tunnel 不需要 Cloudflare 帳號，但每次啟動網址都不同，所以每次都要更新 destination。
 * 設定值（API key、destination id、webhook secret）由 scripts/paddle-sandbox-wizard.sh 寫在 repo 外的
 * ~/.config/naruhodo/paddle-sandbox.env，這裡只讀不寫，也不印出任何秘密值。
 *
 * 選項：--port <n>（預設 8787）、--env <file>
 */
import { spawn } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const WEBHOOK_PATH = '/webhooks/paddle';
export const PADDLE_SANDBOX_ENV_FILE = join(homedir(), '.config', 'naruhodo', 'paddle-sandbox.env');
const CLOUDFLARED_CANDIDATES = [
  'cloudflared',
  join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'cloudflared', 'cloudflared.exe'),
  join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
];

/** 讀 wizard 寫的 KEY='value' 檔（單引號內的 '\'' 還原成 '），也接受沒加引號或雙引號的值。 */
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const [, key, raw] = /^([A-Z0-9_]+)=(.*)$/.exec(line) ?? [];
    if (!key || raw === undefined) continue;
    let value = raw;
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replaceAll("'\\''", "'");
    else if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    env[key] = value;
  }
  return env;
}

/** 驗 `Paddle-Signature: ts=…;h1=…`：HMAC-SHA256(secret, `${ts}:${rawBody}`)，可能有多個 h1（secret 輪替時）。 */
export function verifyPaddleSignature(header: string, rawBody: string, secret: string): boolean {
  const parts = header.split(';').map((part) => part.split('='));
  const ts = parts.find(([k]) => k === 'ts')?.[1];
  const signatures = parts.filter(([k]) => k === 'h1').map(([, v]) => v ?? '');
  if (!ts || signatures.length === 0) return false;
  const expected = createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest();
  return signatures.some((h1) => {
    const actual = Buffer.from(h1, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

/** cloudflared 會把 quick tunnel 的網址印在 stderr 的框框裡；api.trycloudflare.com 是它自己呼叫的端點，不算。 */
export function findTunnelUrl(output: string): string | undefined {
  return [...output.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/g)].find((m) => m[1] !== 'api')?.[0];
}

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function required(env: Record<string, string>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} 不在設定檔裡：先跑 bash scripts/paddle-sandbox-wizard.sh`);
  return value;
}

async function updateDestination(env: Record<string, string>, destination: string): Promise<void> {
  const id = required(env, 'PADDLE_NOTIFICATION_SETTING_ID');
  const response = await fetch(`${required(env, 'PADDLE_API_BASE_URL')}/notification-settings/${id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${required(env, 'PADDLE_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ destination }),
  });
  if (!response.ok) throw new Error(`更新 webhook destination 失敗：HTTP ${response.status} ${await response.text()}`);
}

function startEcho(port: number, secret: string): void {
  createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== WEBHOOK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const ok = verifyPaddleSignature(String(req.headers['paddle-signature'] ?? ''), body, secret);
      let summary = '';
      try {
        const event = JSON.parse(body);
        summary = `${event.event_type}  ${event.event_id}  occurred_at=${event.occurred_at}`;
      } catch {
        summary = '(body 不是 JSON)';
      }
      console.log(ok ? `✓ signature ok  ${summary}` : `✗ signature mismatch  ${summary}`);
      res.writeHead(ok ? 200 : 401).end();
    });
  }).listen(port, () => console.log(`echo server：http://localhost:${port}${WEBHOOK_PATH}`));
}

async function startCloudflared(port: number): Promise<{ url: string; stop: () => void }> {
  for (const command of CLOUDFLARED_CANDIDATES) {
    if (command !== 'cloudflared' && !existsSync(command)) continue;
    const child = spawn(command, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const url = await new Promise<string | undefined>((resolve) => {
      let output = '';
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        const found = findTunnelUrl(output);
        if (found) resolve(found);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', () => resolve(undefined));
      child.on('exit', () => resolve(undefined));
    });
    if (url) return { url, stop: () => child.kill() };
  }
  throw new Error('找不到 cloudflared，或 quick tunnel 沒有啟動：winget install --id Cloudflare.cloudflared');
}

/** 新的 quick tunnel 網址要幾秒後 DNS 才查得到；太早送 webhook，Paddle 那邊會記成 aborted。 */
async function waitUntilReachable(url: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await fetch(url, { method: 'HEAD' });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`tunnel 網址 30 秒內都連不上：${url}`);
}

async function main(): Promise<void> {
  const port = Number(option('--port') ?? 8787);
  const env = parseEnvFile(readFileSync(option('--env') ?? PADDLE_SANDBOX_ENV_FILE, 'utf8'));
  if (process.argv.includes('--echo')) startEcho(port, required(env, 'PADDLE_WEBHOOK_SECRET'));

  const tunnel = await startCloudflared(port);
  process.on('SIGINT', () => {
    tunnel.stop();
    process.exit(0);
  });
  const destination = `${tunnel.url}${WEBHOOK_PATH}`;
  await waitUntilReachable(destination);
  await updateDestination(env, destination);
  console.log(`webhook destination → ${destination}`);
  console.log(`轉到 http://localhost:${port}${WEBHOOK_PATH}；Ctrl-C 結束`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
