/**
 * Practice Spread（#169）：Worker 認出送來的文字是試翻頁的那一頁，就照常翻譯、不扣頁，用量照記並標成試翻。
 * 送的是真的 OCR 錄下來的原文（practice-spread/ocr.json）。用量紀錄沒有 API 看得到，直接查 D1（docs/agents/testing.md 的例外）。
 */
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import practiceSpread from '../../practice-spread/ocr.json' with { type: 'json' };
import { ACCOUNT_PATH, DEV_FREE_PAGES_PATH, TRANSLATE_PATH, type AccountResponse } from '../../src/shared/hosted-api.ts';
import type { TranslateInput } from '../../src/shared/translator.ts';
import { fakeAnthropic, reply } from './test/anthropic.ts';
import { freshEmail, get, post, signIn } from './test/http.ts';

/** 錄下來的第一種跑法的第一頁。 */
const practicePage = Object.values(practiceSpread as Record<string, string[][]>)[0]![0]!;

const inputOf = (texts: readonly string[]): TranslateInput => ({
  seriesNotes: [],
  priorPages: [],
  items: texts.map((原文, i) => ({ id: `b${i + 1}`, kind: 'balloon', 原文, orientation: 'vertical' })),
});

const replyFor = (input: TranslateInput) =>
  reply({ items: input.items.map((item) => ({ id: item.id, zh: '譯文', unreadable: false, sfx: false })) });

async function translate(token: string, texts: readonly string[]): Promise<Response> {
  const input = inputOf(texts);
  fakeAnthropic([replyFor(input)]);
  const response = await post(TRANSLATE_PATH, input, { token });
  vi.restoreAllMocks();
  return response;
}

const quota = async (token: string) => ((await (await get(ACCOUNT_PATH, token)).json()) as AccountResponse).quota;

async function usageRecords(email: string) {
  const { results } = await env.DB.prepare('SELECT kind, practice FROM usage_records WHERE account_id = (SELECT id FROM accounts WHERE email = ?) ORDER BY id')
    .bind(email)
    .all<{ kind: string; practice: number }>();
  return results;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Practice Spread 不扣頁', () => {
  it('送 Practice Spread 的一頁：有譯文、額度不變、記一筆標成試翻的用量', async () => {
    const email = freshEmail();
    const token = await signIn(email);

    const response = await translate(token, practicePage);

    expect(response.status).toBe(200);
    const { items } = (await response.json()) as { items: { id: string; 譯文: string }[] };
    expect(items[0]).toMatchObject({ id: 'b1', 譯文: '譯文' });
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 50 });
    expect(await usageRecords(email)).toEqual([{ kind: 'translate', practice: 1 }]);
  });

  it('Free Pages 用完的 Account 也能試翻', async () => {
    const email = freshEmail();
    const token = await signIn(email);
    expect((await post(DEV_FREE_PAGES_PATH, { email, remaining: 0 })).status).toBe(204);

    expect((await translate(token, practicePage)).status).toBe(200);

    expect(await quota(token)).toEqual({ plan: 'free', remaining: 0 });
  });

  it('普通的文字照常扣頁，用量不是試翻', async () => {
    const email = freshEmail();
    const token = await signIn(email);

    expect((await translate(token, ['今日の給食はカレーだ！', 'なんだと！？'])).status).toBe(200);

    expect(await quota(token)).toEqual({ plan: 'free', remaining: 49 });
    expect(await usageRecords(email)).toEqual([{ kind: 'translate', practice: 0 }]);
  });

  it('只有少數句子對得上 Practice Spread 照常扣頁', async () => {
    const token = await signIn();

    expect((await translate(token, practicePage.slice(0, 1))).status).toBe(200);

    expect(await quota(token)).toEqual({ plan: 'free', remaining: 49 });
  });
});

describe('試翻紀錄不能拿來接續（spec #142 的長 Page 接續）', () => {
  it('帶試翻那筆用量紀錄的 id 送任意文字：照常扣頁', async () => {
    const email = freshEmail();
    const token = await signIn(email);
    await translate(token, practicePage);
    // id 是連號整數，猜得到，所以只靠「試翻不回傳 id」不夠
    const { id } = (await env.DB.prepare('SELECT id FROM usage_records WHERE account_id = (SELECT id FROM accounts WHERE email = ?)').bind(email).first<{ id: number }>())!;

    const input = { ...inputOf(['今日の給食はカレーだ！']), pageUsageRecordId: id };
    fakeAnthropic([replyFor(input)]);
    expect((await post(TRANSLATE_PATH, input, { token })).status).toBe(200);

    expect(await quota(token)).toEqual({ plan: 'free', remaining: 49 });
  });
});
