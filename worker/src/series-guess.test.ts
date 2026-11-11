/**
 * 從頁面標題猜作品原名（#186）的 Worker 端點：要登入、只收頁面文字、限制長度、不扣頁、依 Account 限制頻率。
 * 成功的呼叫照樣寫用量紀錄（#238）；用量紀錄沒有 API 看得到，那一條直接查 D1（docs/agents/testing.md 的例外）。
 */
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_MODEL, seriesGuessRequest } from '../../src/shared/claude-request.ts';
import { ACCOUNT_PATH, DEV_FREE_PAGES_PATH, SERIES_GUESS_PATH, type AccountResponse } from '../../src/shared/hosted-api.ts';
import type { TitleSignals } from '../../src/shared/translator.ts';
import { fakeAnthropic, reply, USAGE_COST_USD } from './test/anthropic.ts';
import { awayFromRateLimitEdge, freshEmail, get, post, signIn } from './test/http.ts';

const signals: TitleSignals = { title: '[第3話]範例作品 - 作者 | 網站', ogTitle: '', headings: ['範例作品'] };
const answer = { status: 'work', original_title: '範例作品', zh_title: '範例作品中文' };

let token: string;

beforeEach(async () => {
  token = await signIn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const remaining = async () => ((await (await get(ACCOUNT_PATH, token)).json()) as AccountResponse).quota.remaining;

describe('猜作品原名', () => {
  it('用共用模組組的 request 呼叫 Anthropic，回傳原名與中文譯名；不扣頁', async () => {
    const before = await remaining();
    const anthropic = fakeAnthropic([reply(answer)]);

    const response = await post(SERIES_GUESS_PATH, signals, { token });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'work', 原名: '範例作品', 中文譯名: '範例作品中文' });
    expect(anthropic.calls[0]!.body).toEqual(seriesGuessRequest(signals));
    vi.restoreAllMocks();
    expect(await remaining()).toBe(before);
  });

  it('成功時寫一筆 series_guess 用量紀錄：不屬於任何一頁、有 cache write 與 model，沒有頁面文字；額度不變', async () => {
    const email = freshEmail();
    const guesser = await signIn(email);
    fakeAnthropic([reply(answer)]);

    expect((await post(SERIES_GUESS_PATH, signals, { token: guesser })).status).toBe(200);

    const { results } = await env.DB.prepare('SELECT * FROM usage_records WHERE account_id = (SELECT id FROM accounts WHERE email = ?)').bind(email).all();
    expect(results).toEqual([
      {
        id: expect.any(Number),
        account_id: expect.any(String),
        created_at: expect.any(Number),
        kind: 'series_guess',
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_tokens: 700,
        cache_write_tokens: 100,
        cost_usd: USAGE_COST_USD,
        model: CLAUDE_MODEL,
        page_record_id: null,
        practice: 0,
      },
    ]);
    for (const content of ['範例作品', '作者', '網站']) expect(JSON.stringify(results)).not.toContain(content);
    vi.restoreAllMocks();
    expect(((await (await get(ACCOUNT_PATH, guesser)).json()) as AccountResponse).quota.remaining).toBe(100);
  });

  it('client 多送的欄位（網址、model）不轉給 Anthropic', async () => {
    const anthropic = fakeAnthropic([reply(answer)]);

    await post(SERIES_GUESS_PATH, { ...signals, url: 'https://manga.example/episode/3', model: 'claude-opus-5-5' }, { token });

    expect(anthropic.calls[0]!.body).toEqual(seriesGuessRequest(signals));
  });

  it('沒登入回 401；格式不符或文字太長回 400，都不呼叫 Anthropic', async () => {
    const anthropic = vi.spyOn(globalThis, 'fetch');

    expect((await post(SERIES_GUESS_PATH, signals)).status).toBe(401);
    expect((await post(SERIES_GUESS_PATH, { title: 1, ogTitle: '', headings: [] }, { token })).status).toBe(400);
    expect((await post(SERIES_GUESS_PATH, { ...signals, title: 'あ'.repeat(501) }, { token })).status).toBe(400);
    expect((await post(SERIES_GUESS_PATH, { ...signals, headings: Array(6).fill('見出し') }, { token })).status).toBe(400);
    expect(anthropic).not.toHaveBeenCalled();
  });

  it('同一個 Account 一分鐘內第 11 次回 429 rateLimited，不呼叫 Anthropic', async () => {
    await awayFromRateLimitEdge();
    const anthropic = fakeAnthropic(Array.from({ length: 10 }, () => reply(answer)));
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await post(SERIES_GUESS_PATH, signals, { token })).status);

    expect(statuses).toEqual([...Array(10).fill(200), 429]);
    expect(anthropic.calls).toHaveLength(10);
  });

  it('額度用完也照樣猜（不算 Translated Page）', async () => {
    const email = freshEmail('exhausted');
    const exhausted = await signIn(email);
    await post(DEV_FREE_PAGES_PATH, { email, remaining: 0 });
    fakeAnthropic([reply(answer)]);

    const response = await post(SERIES_GUESS_PATH, signals, { token: exhausted });

    expect(response.status).toBe(200);
  });
});
