/**
 * 用法：node scripts/webstore-publish.ts <zip>
 *   把 zip 上傳到 Chrome Web Store 並送審（審過就上線）。由 .github/workflows/webstore.yml 呼叫。
 *   上一版還在審核中就不上傳：再送一版可能被拒或蓋掉審核中的版本。
 *
 * 環境變數：
 *   CWS_SERVICE_ACCOUNT_KEY：service account 的 JSON key（GitHub secret）
 *   CWS_PUBLISHER_ID、CWS_EXTENSION_ID：Dashboard 上的 publisher ID 與項目 ID（GitHub variable）
 *
 * 用 Chrome Web Store API v2（v1 在 2026-10-15 停用）。v2 沒有建立項目的方法，第一次上架要在 Dashboard 手動做。
 * 認證用 service account 自己簽 JWT 換 access token，不另外裝 Google 的套件，也不需要額外的 IAM 角色。
 * 規則與出處見 docs/research/chrome-web-store-listing.md 第 8 節。
 */
import { sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const API = 'https://chromewebstore.googleapis.com';
/** 上傳後還在處理時，輪詢 fetchStatus 的間隔與上限。 */
const POLL_INTERVAL_MS = 5_000;
const POLL_LIMIT = 60;

interface RevisionStatus {
  state?: string;
  distributionChannels?: { crxVersion?: string }[];
}

interface ItemStatus {
  lastAsyncUploadState?: string;
  publishedItemRevisionStatus?: RevisionStatus;
  submittedItemRevisionStatus?: RevisionStatus;
}

const versions = (status: RevisionStatus | undefined) =>
  status?.distributionChannels?.map((channel) => channel.crxVersion).join(', ') || '（不明）';

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少環境變數 ${name}`);
  return value;
}

const base64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

async function accessToken(key: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: key.token_uri, iat: now, exp: now + 3600 }));
  const signature = base64url(sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), key.private_key));
  const response = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }),
  });
  const body = (await response.json()) as { access_token?: string };
  if (!response.ok || !body.access_token) throw new Error(`取得 access token 失敗：${response.status} ${JSON.stringify(body)}`);
  return body.access_token;
}

async function call<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${url} 失敗：${response.status} ${text}`);
  return JSON.parse(text) as T;
}

const [zipPath] = process.argv.slice(2);
if (!zipPath) throw new Error('用法：node scripts/webstore-publish.ts <zip>');

const key = JSON.parse(env('CWS_SERVICE_ACCOUNT_KEY')) as ServiceAccountKey;
const item = `publishers/${env('CWS_PUBLISHER_ID')}/items/${env('CWS_EXTENSION_ID')}`;
const token = await accessToken(key);

const before = await call<ItemStatus>(token, `${API}/v2/${item}:fetchStatus`);
console.log('目前上線的版本', before.publishedItemRevisionStatus ? versions(before.publishedItemRevisionStatus) : '（尚未上線）');
if (before.submittedItemRevisionStatus?.state === 'PENDING_REVIEW') {
  throw new Error(`版本 ${versions(before.submittedItemRevisionStatus)} 還在審核中，等審核結束（或到 Dashboard 撤回送審）再上傳`);
}

const upload = await call<{ uploadState?: string; crxVersion?: string }>(token, `${API}/upload/v2/${item}:upload`, {
  method: 'POST',
  headers: { 'content-type': 'application/zip' },
  body: await readFile(zipPath),
});
console.log('upload', upload);

// 上傳頁的說明寫 UPLOAD_IN_PROGRESS，UploadState enum 寫 IN_PROGRESS，兩個都當成還在處理
let state = upload.uploadState;
for (let i = 0; (state === 'IN_PROGRESS' || state === 'UPLOAD_IN_PROGRESS') && i < POLL_LIMIT; i++) {
  await sleep(POLL_INTERVAL_MS);
  state = (await call<ItemStatus>(token, `${API}/v2/${item}:fetchStatus`)).lastAsyncUploadState;
  console.log('upload state', state);
}
if (state !== 'SUCCEEDED') throw new Error(`上傳沒有成功：${state}`);

const published = await call<unknown>(token, `${API}/v2/${item}:publish`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
});
console.log('publish', published);
