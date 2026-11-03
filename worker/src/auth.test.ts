/**
 * Account 與 email 驗證碼登入（#91）：送請求給真正的 Worker 與本機 D1，看回應與之後查得到的狀態。
 * 寄信用 env.dev 的假實作，驗證碼從它的 outbox 取出。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { ACCOUNT_PATH, SEND_CODE_PATH, SIGN_OUT_PATH, TRANSLATE_PATH, VERIFY_CODE_PATH } from '../../src/shared/hosted-api.ts';
import type { TranslateInput } from '../../src/shared/translator.ts';
import { awayFromRateLimitEdge, freshEmail, freshIp, get, lastCode, post, signIn } from './test/http.ts';

const translateInput: TranslateInput = { seriesNotes: [], priorPages: [], items: [{ id: 'b1', kind: 'balloon', 原文: 'おはよう', orientation: 'vertical' }] };

/** 跟 code 不同的另一組 6 位數。 */
const otherCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

beforeEach(() => {
  // 只換 Date，setTimeout 照常（Worker 的 D1 與 fetch 要用）
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('登入', () => {
  it('寄送驗證碼、輸入正確的驗證碼就拿到 session token，用它查得到自己的 email', async () => {
    const email = freshEmail();

    const sent = await post(SEND_CODE_PATH, { email });
    expect(sent.status).toBe(204);
    const code = await lastCode(email);
    expect(code).toMatch(/^\d{6}$/);
    const verified = await post(VERIFY_CODE_PATH, { email, code });

    expect(verified.status).toBe(200);
    const { token } = (await verified.json()) as { token: string };
    const account = await get(ACCOUNT_PATH, token);
    expect(account.status).toBe(200);
    expect(await account.json()).toMatchObject({ email });
  });

  it('驗證碼錯誤回 400 wrongCode；之後輸入正確的仍然可以登入', async () => {
    const email = freshEmail();
    await post(SEND_CODE_PATH, { email });
    const code = await lastCode(email);

    const wrong = await post(VERIFY_CODE_PATH, { email, code: otherCode(code) });

    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ reason: 'wrongCode' });
    expect((await post(VERIFY_CODE_PATH, { email, code })).status).toBe(200);
  });

  it('超過 10 分鐘的驗證碼回 400 codeExpired，正確的也不行', async () => {
    const email = freshEmail();
    await post(SEND_CODE_PATH, { email });
    const code = await lastCode(email);

    vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);
    const expired = await post(VERIFY_CODE_PATH, { email, code });

    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ reason: 'codeExpired' });
  });

  it('沒寄過驗證碼的 email 也回 codeExpired（請重新寄送）', async () => {
    const response = await post(VERIFY_CODE_PATH, { email: freshEmail(), code: '123456' });

    expect(await response.json()).toMatchObject({ reason: 'codeExpired' });
  });

  it('錯 5 次這組驗證碼就失效：第 5 次起回 tooManyAttempts，正確的也不行；重新寄送後的新驗證碼可以登入', async () => {
    const email = freshEmail();
    await post(SEND_CODE_PATH, { email });
    const code = await lastCode(email);

    const reasons = [];
    for (let i = 0; i < 5; i++) reasons.push(((await (await post(VERIFY_CODE_PATH, { email, code: otherCode(code) })).json()) as { reason: string }).reason);
    const correct = await post(VERIFY_CODE_PATH, { email, code });

    expect(reasons).toEqual(['wrongCode', 'wrongCode', 'wrongCode', 'wrongCode', 'tooManyAttempts']);
    expect(await correct.json()).toMatchObject({ reason: 'tooManyAttempts' });
    await post(SEND_CODE_PATH, { email });
    expect((await post(VERIFY_CODE_PATH, { email, code: await lastCode(email) })).status).toBe(200);
  });
});

describe('猜驗證碼的限制', () => {
  /** 送一組錯的驗證碼，回傳 reason。 */
  const guessWrong = async (email: string, code: string) =>
    ((await (await post(VERIFY_CODE_PATH, { email, code: otherCode(code) })).json()) as { reason: string }).reason;

  /** 寄兩次驗證碼、每組都錯 5 次：用完這個 email 一小時內的 10 次。 */
  async function useUpAttempts(email: string) {
    for (let round = 0; round < 2; round++) {
      await post(SEND_CODE_PATH, { email });
      const code = await lastCode(email);
      for (let i = 0; i < 5; i++) await guessWrong(email, code);
    }
  }

  it('同一個 email 一小時內錯 10 次就被擋：重新寄送也不會歸零，連正確的新驗證碼都回 429 rateLimited', async () => {
    const email = freshEmail();
    await useUpAttempts(email);
    await post(SEND_CODE_PATH, { email });

    const blocked = await post(VERIFY_CODE_PATH, { email, code: await lastCode(email) });

    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ reason: 'rateLimited' });
  });

  it('被擋一小時後，重新寄送的驗證碼可以登入', async () => {
    const email = freshEmail();
    await useUpAttempts(email);

    vi.setSystemTime(Date.now() + 60 * 60 * 1000 + 1);
    await post(SEND_CODE_PATH, { email });

    expect((await post(VERIFY_CODE_PATH, { email, code: await lastCode(email) })).status).toBe(200);
  });

  it('登入成功後錯誤次數歸零', async () => {
    const email = freshEmail();
    await post(SEND_CODE_PATH, { email });
    const first = await lastCode(email);
    for (let i = 0; i < 4; i++) await guessWrong(email, first);
    expect((await post(VERIFY_CODE_PATH, { email, code: first })).status).toBe(200);

    await post(SEND_CODE_PATH, { email });
    const code = await lastCode(email);
    const reasons = [];
    for (let i = 0; i < 4; i++) reasons.push(await guessWrong(email, code));

    expect(reasons).toEqual(['wrongCode', 'wrongCode', 'wrongCode', 'wrongCode']);
    expect((await post(VERIFY_CODE_PATH, { email, code })).status).toBe(200);
  });

  it('同一個 IP 一分鐘內第 31 次驗證回 429 rateLimited（即使換 email）', async () => {
    await awayFromRateLimitEdge();
    const ip = freshIp();
    const statuses = [];
    for (let i = 0; i < 31; i++) statuses.push((await post(VERIFY_CODE_PATH, { email: freshEmail(), code: '123456' }, { ip })).status);

    expect(statuses).toEqual([...Array(30).fill(400), 429]);
  });
});

describe('寄送驗證碼的頻率限制', () => {
  it('同一個 email 一分鐘內第 4 次回 429 rateLimited（即使換 IP），沒有寄出新的驗證碼', async () => {
    await awayFromRateLimitEdge();
    const email = freshEmail();
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await post(SEND_CODE_PATH, { email })).status);
    const code = await lastCode(email);

    const limited = await post(SEND_CODE_PATH, { email });

    expect(statuses).toEqual([204, 204, 204]);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ reason: 'rateLimited' });
    expect(await lastCode(email)).toBe(code);
  });

  it('同一個 IP 一分鐘內第 11 次回 429 rateLimited（即使換 email）', async () => {
    await awayFromRateLimitEdge();
    const ip = freshIp();
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await post(SEND_CODE_PATH, { email: freshEmail() }, { ip })).status);

    expect(statuses).toEqual([...Array(10).fill(204), 429]);
  });
});

const DAY = 24 * 60 * 60 * 1000;

describe('session token', () => {
  it('沒帶 token、token 錯誤時，翻譯端點回 401 signedOut', async () => {
    for (const token of [undefined, 'not-a-session-token']) {
      const response = await post(TRANSLATE_PATH, translateInput, { token });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ reason: 'signedOut' });
    }
  });

  it('登出撤銷這個 token：之後翻譯端點回 401 signedOut；同一個 Account 的其他 token 不受影響', async () => {
    const email = freshEmail();
    const token = await signIn(email);
    const other = await signIn(email);

    expect((await post(SIGN_OUT_PATH, {}, { token })).status).toBe(204);
    const response = await post(TRANSLATE_PATH, translateInput, { token });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: 'signedOut' });
    expect((await get(ACCOUNT_PATH, other)).status).toBe(200);
  });

  it('一直有在用就一直有效；閒置超過 180 天才失效', async () => {
    const token = await signIn();

    vi.setSystemTime(Date.now() + 170 * DAY);
    expect((await get(ACCOUNT_PATH, token)).status).toBe(200);
    vi.setSystemTime(Date.now() + 170 * DAY);
    expect((await get(ACCOUNT_PATH, token)).status).toBe(200);
    vi.setSystemTime(Date.now() + 181 * DAY);
    const idle = await get(ACCOUNT_PATH, token);

    expect(idle.status).toBe(401);
    expect(await idle.json()).toMatchObject({ reason: 'signedOut' });
  });

  it('D1 裡只有驗證碼與 token 的 hash，查不到原文', async () => {
    const email = freshEmail();
    await post(SEND_CODE_PATH, { email });
    const code = await lastCode(email);
    const otps = await env.DB.prepare('SELECT * FROM otps WHERE email = ?').bind(email).all();
    const token = ((await (await post(VERIFY_CODE_PATH, { email, code })).json()) as { token: string }).token;
    const sessions = await env.DB.prepare('SELECT * FROM sessions').all();

    expect(otps.results).toHaveLength(1);
    expect(JSON.stringify(otps.results)).not.toContain(code);
    expect(JSON.stringify(sessions.results)).not.toContain(token);
  });
});

