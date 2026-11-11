/**
 * Daily Free Pages Cap（#241）：全站每天（UTC）送出的 Free Pages 有總上限，到了上限，只靠 Free Pages 的 Account 在呼叫 Anthropic 之前
 * 就拿到 402 freePagesPausedToday，隔天 UTC 0 點重新計數。上限在測試是 wrangler.jsonc env.dev 的值；當天已送出幾頁用
 * DEV_DAILY_FREE_PAGES_PATH 設定（不直接寫 D1）。每個測試固定在自己的一天，計數不會跟別的測試互相影響。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import practiceSpread from '../../practice-spread/ocr.json' with { type: 'json' };
import { ACCOUNT_PATH, DEV_DAILY_FREE_PAGES_PATH, NOTES_PATH, TRANSLATE_PATH, type AccountResponse } from '../../src/shared/hosted-api.ts';
import type { NotesInput, TranslateInput } from '../../src/shared/translator.ts';
import { fakeAnthropic, reply } from './test/anthropic.ts';
import { get, post, signIn } from './test/http.ts';
import { checkoutAccountId, subscriptionEvent, webhook } from './test/paddle.ts';

/** Practice Spread 錄下來的第一種跑法的第一頁（practice-spread.test.ts 也用這一頁）。 */
const practicePage = Object.values(practiceSpread as Record<string, string[][]>)[0]![0]!;

const notesInput: NotesInput = { seriesNotes: [], items: [{ kind: 'balloon', 原文: 'おはよう', 譯文: '早安' }] };

const input: TranslateInput = { seriesNotes: [], priorPages: [], items: [{ id: 'b1', kind: 'balloon', 原文: 'おはよう', orientation: 'vertical' }] };
const ok = reply({ items: [{ id: 'b1', zh: '早安', unreadable: false, sfx: false }] });

/** wrangler.jsonc env.dev 的 DAILY_FREE_PAGES_CAP。 */
const CAP = 2000;

/** 把時間固定在 iso（Worker 用它算今天是 UTC 的哪一天）。 */
const at = (iso: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
};

/** 今天（UTC）全站已經送出 used 頁 Free Pages。 */
async function usedToday(used: number): Promise<void> {
  expect((await post(DEV_DAILY_FREE_PAGES_PATH, { used })).status).toBe(204);
}

const quota = async (token: string) => ((await (await get(ACCOUNT_PATH, token)).json()) as AccountResponse).quota;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Daily Free Pages Cap', () => {
  it('今天送滿了：免費 Account 回 402 freePagesPausedToday，不呼叫 Anthropic', async () => {
    at('2030-01-01T12:00:00Z');
    const token = await signIn();
    await usedToday(CAP);
    const anthropic = vi.spyOn(globalThis, 'fetch');

    const response = await post(TRANSLATE_PATH, input, { token });

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ reason: 'freePagesPausedToday' });
    expect(anthropic).not.toHaveBeenCalled();
  });

  it('差一頁到上限：這頁照常翻譯、扣頁並算進今天的總數，下一頁（別的 Account 也一樣）就擋下', async () => {
    at('2030-01-02T12:00:00Z');
    const [first, second] = [await signIn(), await signIn()];
    await usedToday(CAP - 1);
    fakeAnthropic([ok]);

    expect((await post(TRANSLATE_PATH, input, { token: first })).status).toBe(200);
    expect(await quota(first)).toEqual({ plan: 'free', remaining: 99 });
    const response = await post(TRANSLATE_PATH, input, { token: second });

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ reason: 'freePagesPausedToday' });
  });

  it('隔天 UTC 0 點重新計數：照常翻譯', async () => {
    at('2030-01-03T23:59:00Z');
    const token = await signIn();
    await usedToday(CAP);
    expect((await post(TRANSLATE_PATH, input, { token })).status).toBe(402);

    vi.setSystemTime(new Date('2030-01-04T00:00:01Z'));
    fakeAnthropic([ok]);

    expect((await post(TRANSLATE_PATH, input, { token })).status).toBe(200);
  });
});

describe('Daily Free Pages Cap 不擋的', () => {
  it('訂閱中的 Account：扣 Monthly Page Limit，照常翻譯', async () => {
    at('2030-01-05T12:00:00Z');
    const token = await signIn();
    const accountId = await checkoutAccountId(token);
    expect((await webhook(subscriptionEvent({ accountId, eventType: 'subscription.created', startedAt: '2030-01-01T00:00:00Z', endsAt: '2031-01-01T00:00:00Z' }))).status).toBe(200);
    await usedToday(CAP);
    fakeAnthropic([ok]);

    expect((await post(TRANSLATE_PATH, input, { token })).status).toBe(200);
  });

  it('Practice Spread：照常試翻', async () => {
    at('2030-01-06T12:00:00Z');
    const token = await signIn();
    await usedToday(CAP);
    const practice: TranslateInput = {
      seriesNotes: [],
      priorPages: [],
      items: practicePage.map((原文, i) => ({ id: `b${i + 1}`, kind: 'balloon', 原文, orientation: 'vertical' })),
    };
    fakeAnthropic([reply({ items: practice.items.map((item) => ({ id: item.id, zh: '譯文', unreadable: false, sfx: false })) })]);

    expect((await post(TRANSLATE_PATH, practice, { token })).status).toBe(200);
  });

  it('長 Page 的接續翻譯與 Notes：跟著已經扣過的那一頁，照常翻譯', async () => {
    at('2030-01-07T12:00:00Z');
    const token = await signIn();
    await usedToday(CAP - 1);
    fakeAnthropic([ok, ok, reply({ notes_changes: { added: [], filled: [], suggestions: [] } })]);
    const { usageRecordId } = (await (await post(TRANSLATE_PATH, input, { token })).json()) as { usageRecordId: number };

    expect((await post(TRANSLATE_PATH, { ...input, pageUsageRecordId: usageRecordId }, { token })).status).toBe(200);
    expect((await post(NOTES_PATH, { ...notesInput, pageUsageRecordId: usageRecordId }, { token })).status).toBe(200);
    vi.restoreAllMocks();
    expect((await post(TRANSLATE_PATH, input, { token })).status).toBe(402);
  });
});
