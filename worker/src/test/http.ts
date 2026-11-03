/** Worker 測試共用：送 HTTP 給真正的 Worker，以及用 email 驗證碼登入拿 session token。 */
import { exports } from 'cloudflare:workers';
import { vi } from 'vitest';
import { DEV_OUTBOX_PATH, SEND_CODE_PATH, VERIFY_CODE_PATH } from '../../../src/shared/hosted-api.ts';

let ips = 0;

/** 每次呼叫一個新的 IP，讓依 IP 的頻率限制不會跨測試累積。 */
export const freshIp = () => `203.0.113.${++ips}`;

/**
 * 本機的 rate limit（miniflare）時間窗對齊整分鐘，而且用真的時鐘，不受 vi.useFakeTimers 影響。
 * 一串請求跨過整分鐘，計數就歸零、該回 429 的回了別的（PR #184 的 CI）。離下一分鐘不到 margin 就等到跨過去再開始。
 */
export async function awayFromRateLimitEdge(marginMs = 2_000): Promise<void> {
  const left = 60_000 - (vi.getRealSystemTime() % 60_000);
  if (left < marginMs) await new Promise((resolve) => setTimeout(resolve, left + 100));
}

export function post(path: string, body: unknown, { token, ip = freshIp() }: { token?: string; ip?: string } = {}): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://api.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
    }),
  );
}

export function get(path: string, token?: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://api.test${path}`, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } }),
  );
}

export function del(path: string, token?: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://api.test${path}`, { method: 'DELETE', headers: token === undefined ? {} : { authorization: `Bearer ${token}` } }),
  );
}

/** 假的寄信實作最後寄給這個 email 的驗證碼。 */
export async function lastCode(email: string): Promise<string> {
  const response = await get(`${DEV_OUTBOX_PATH}?email=${encodeURIComponent(email)}`);
  return ((await response.json()) as { code: string }).code;
}

let emails = 0;

/** 每個測試用不同的 email，狀態不會互相影響。 */
export const freshEmail = (name = 'reader') => `${name}-${++emails}-${crypto.randomUUID().slice(0, 8)}@example.com`;

/** 寄送 → 從假的寄信取出驗證碼 → 驗證，回傳 session token。 */
export async function signIn(email = freshEmail()): Promise<string> {
  await post(SEND_CODE_PATH, { email });
  const response = await post(VERIFY_CODE_PATH, { email, code: await lastCode(email) });
  return ((await response.json()) as { token: string }).token;
}
