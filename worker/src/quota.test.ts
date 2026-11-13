/**
 * Free Pages（spec #86「額度規則」、#92）：新 Account 有一次性的 100 頁，翻譯成功才扣一頁，用完就拒絕。
 * 從 HTTP 觀察剩餘頁數（GET /v1/account）；Anthropic 用 vi.spyOn(fetch) 假的。
 * 用量紀錄沒有任何 API 看得到，只有它直接查 D1（跟「秘密只存 hash」一樣，是 docs/agents/testing.md 的例外）。
 */
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_PATH, DEV_FREE_PAGES_PATH, NOTES_PATH, TRANSLATE_PATH, type AccountResponse } from '../../src/shared/hosted-api.ts';
import type { NotesInput, TranslateInput } from '../../src/shared/translator.ts';
import { CLAUDE_MODEL } from '../../src/shared/claude-request.ts';
import { fakeAnthropic, reply, USAGE_COST_USD } from './test/anthropic.ts';
import { freshEmail, get, post, signIn } from './test/http.ts';

const input: TranslateInput = { seriesNotes: [], priorPages: [], items: [{ id: 'b1', kind: 'balloon', 原文: 'おはよう', orientation: 'vertical' }] };

const ok = reply({ items: [{ id: 'b1', zh: '早安', unreadable: false, sfx: false }] });

const failed = () => Response.json({ error: { message: 'invalid x-api-key' } }, { status: 401 });

const notesInput: NotesInput = { seriesNotes: [], items: [{ kind: 'balloon', 原文: '湊、パン屋に行こう', 譯文: '湊，去麵包店吧' }] };

const notesOk = reply({ notes_changes: { added: [], filled: [], suggestions: [] } });

const translate = (token: string) => post(TRANSLATE_PATH, input, { token });

/** 登入一個剩 remaining 頁免費額度的 Account。 */
async function signInWith(remaining: number): Promise<string> {
  const email = freshEmail();
  const token = await signIn(email);
  expect((await post(DEV_FREE_PAGES_PATH, { email, remaining })).status).toBe(204);
  return token;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const quota = async (token: string) => ((await (await get(ACCOUNT_PATH, token)).json()) as AccountResponse).quota;

describe('Free Pages', () => {
  it('新 Account 有 100 頁免費額度', async () => {
    const token = await signIn();

    expect(await quota(token)).toEqual({ plan: 'free', remaining: 100 });
  });

  it('翻譯成功扣一頁', async () => {
    const token = await signIn();
    fakeAnthropic([ok]);

    expect((await translate(token)).status).toBe(200);

    expect(await quota(token)).toEqual({ plan: 'free', remaining: 99 });
  });

  it('Anthropic 失敗不扣', async () => {
    const token = await signIn();
    fakeAnthropic([failed]);

    expect((await translate(token)).status).toBe(502);

    expect(await quota(token)).toEqual({ plan: 'free', remaining: 100 });
  });

  it('剩 0 頁時拒絕：402 freePagesExhausted，不呼叫 Anthropic', async () => {
    const token = await signInWith(0);
    const anthropic = vi.spyOn(globalThis, 'fetch');

    const response = await translate(token);

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ reason: 'freePagesExhausted' });
    expect(anthropic).not.toHaveBeenCalled();
  });

  it('只剩一頁時同時送兩頁：兩個都送到 Anthropic，只有一個扣得到、回 200，另一個回 402', async () => {
    const token = await signInWith(1);
    // 兩個請求都到了 Anthropic 才一起回答：兩個都通過了送出前的檢查，靠扣額度那一步決定誰成功
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    const afterBoth = async () => {
      if (++arrived === 2) release();
      await both;
      return ok();
    };
    fakeAnthropic([afterBoth, afterBoth]);

    const responses = await Promise.all([translate(token), translate(token)]);

    expect(responses.map((r) => r.status).sort()).toEqual([200, 402]);
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 0 });
  });
});

describe('Strip（條漫）照句數計頁（#282）', () => {
  /** n 句的 Strip 翻譯；root＝接著哪一串累計（那一串第一次翻譯回的 usageRecordId）。 */
  async function translateStrip(token: string, n: number, root?: number) {
    fakeAnthropic([ok]);
    const items = Array.from({ length: n }, (_, i) => ({ ...input.items[0]!, id: `b${i + 1}` }));
    const response = await post(TRANSLATE_PATH, { ...input, items, strip: true, ...(root === undefined ? {} : { stripUsageRecordId: root }) }, { token });
    const body = (await response.json()) as { usageRecordId?: number; strip?: { lines: number; pages: number }; reason?: string };
    return { status: response.status, ...body };
  }

  it('第 1 句就計第 1 頁，之後每累計滿 8 句再計 1 頁；回應帶這一串的累計', async () => {
    const token = await signIn();

    const first = await translateStrip(token, 3);
    expect(first).toMatchObject({ status: 200, strip: { lines: 3, pages: 1 } });
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 99 });

    // 3＋5＝8 句，還在第 1 頁裡：不再扣
    const second = await translateStrip(token, 5, first.usageRecordId);
    expect(second).toMatchObject({ status: 200, usageRecordId: first.usageRecordId, strip: { lines: 8, pages: 1 } });
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 99 });

    // 第 9 句開始第 2 頁
    const third = await translateStrip(token, 1, first.usageRecordId);
    expect(third).toMatchObject({ usageRecordId: first.usageRecordId, strip: { lines: 9, pages: 2 } });
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 98 });
  });

  it('一次翻很多句：跨過幾個 8 句就扣幾頁', async () => {
    const token = await signIn();

    expect(await translateStrip(token, 20)).toMatchObject({ status: 200, strip: { lines: 20, pages: 3 } });

    expect(await quota(token)).toEqual({ plan: 'free', remaining: 97 });
  });

  it('接著的那一串不是自己的 Strip 第一筆（別人的、一般翻譯的、不存在的）：當成新的一串，從頭計', async () => {
    const token = await signIn();
    const other = await translateStrip(await signIn(), 3);
    fakeAnthropic([ok]);
    const plain = (await (await translate(token)).json()) as { usageRecordId: number };
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 99 });

    for (const root of [other.usageRecordId!, plain.usageRecordId, 999_999]) {
      const result = await translateStrip(token, 2, root);
      expect(result.strip).toEqual({ lines: 2, pages: 1 });
      expect(result.usageRecordId).not.toBe(root);
    }

    expect(await quota(token)).toEqual({ plan: 'free', remaining: 96 });
  });

  it('Strip 的紀錄不能拿來當長 Page 的接續（不然接續的請求都不扣頁）', async () => {
    const token = await signIn();
    const strip = await translateStrip(token, 1);
    fakeAnthropic([ok]);

    const response = await post(TRANSLATE_PATH, { ...input, pageUsageRecordId: strip.usageRecordId }, { token });

    expect(((await response.json()) as { usageRecordId: number }).usageRecordId).not.toBe(strip.usageRecordId);
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 98 });
  });

  it('額度用完：這次的句數還落在已經計過的那一頁裡照樣翻，要多計一頁就拒絕（不呼叫 Anthropic）', async () => {
    const token = await signInWith(1);
    const first = await translateStrip(token, 3);
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 0 });

    expect(await translateStrip(token, 5, first.usageRecordId)).toMatchObject({ status: 200, strip: { lines: 8, pages: 1 } });

    // 前面兩次翻譯已經呼叫過，只看這一次有沒有再呼叫
    const anthropic = vi.spyOn(globalThis, 'fetch').mockClear();
    const blocked = await post(TRANSLATE_PATH, { ...input, strip: true, stripUsageRecordId: first.usageRecordId }, { token });
    expect(blocked.status).toBe(402);
    expect(await blocked.json()).toMatchObject({ reason: 'freePagesExhausted' });
    expect(anthropic).not.toHaveBeenCalled();
  });

  it('用量紀錄只多記句數與這是 Strip，接著累計的那筆指到第一筆', async () => {
    const token = await signIn();
    const first = await translateStrip(token, 3);
    await translateStrip(token, 5, first.usageRecordId);

    const { results } = await env.DB.prepare('SELECT strip, lines, page_record_id FROM usage_records WHERE id >= ? ORDER BY id').bind(first.usageRecordId).all();

    expect(results).toEqual([
      { strip: 1, lines: 3, page_record_id: null },
      { strip: 1, lines: 5, page_record_id: first.usageRecordId },
    ]);
  });
});

describe('長 Page 的接續翻譯（spec #142「計費」）', () => {
  /** 翻一次，回傳回應的 usageRecordId；pageUsageRecordId 有值就是同一個 Page 的接續請求。 */
  async function translateAs(token: string, pageUsageRecordId?: number): Promise<{ status: number; usageRecordId?: number }> {
    fakeAnthropic([ok]);
    const response = await post(TRANSLATE_PATH, { ...input, ...(pageUsageRecordId === undefined ? {} : { pageUsageRecordId }) }, { token });
    vi.restoreAllMocks();
    if (!response.ok) return { status: response.status };
    return { status: response.status, usageRecordId: ((await response.json()) as { usageRecordId: number }).usageRecordId };
  }

  it('帶第一次回應的 usageRecordId：只記用量、不扣頁，回應帶回同一個 id', async () => {
    const email = freshEmail();
    const token = await signIn(email);
    const first = await translateAs(token);

    const next = await translateAs(token, first.usageRecordId);

    expect(next).toEqual({ status: 200, usageRecordId: first.usageRecordId });
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 99 });
    expect(await usageRecords(email)).toEqual([
      { id: first.usageRecordId, kind: 'translate', page_record_id: null },
      { id: expect.any(Number), kind: 'translate', page_record_id: first.usageRecordId },
    ]);
  });

  it('接續 10 次都不扣，第 11 次當成新的一頁扣，之後接續它', async () => {
    const token = await signIn();
    const first = await translateAs(token);
    for (let i = 0; i < 10; i++) expect((await translateAs(token, first.usageRecordId)).usageRecordId).toBe(first.usageRecordId);
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 99 });

    const eleventh = await translateAs(token, first.usageRecordId);

    expect(eleventh.usageRecordId).not.toBe(first.usageRecordId);
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 98 });
    expect((await translateAs(token, eleventh.usageRecordId)).usageRecordId).toBe(eleventh.usageRecordId);
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 98 });
  });

  it('第一次翻譯超過 1 小時：當成新的一頁扣', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    const token = await signIn();
    const first = await translateAs(token);
    vi.setSystemTime(new Date('2026-11-01T00:59:59Z'));
    await translateAs(token, first.usageRecordId);
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 99 });

    vi.setSystemTime(new Date('2026-11-01T01:00:01Z'));
    const late = await translateAs(token, first.usageRecordId);
    vi.useRealTimers();

    expect(late.usageRecordId).not.toBe(first.usageRecordId);
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 98 });
  });

  it('紀錄不是自己的第一次翻譯（別人的、接續的、Notes 的、不存在的）：當成新的一頁扣', async () => {
    const email = freshEmail();
    const token = await signIn(email);
    const others = await translateAs(await signIn());
    const first = await translateAs(token);
    await translateAs(token, first.usageRecordId);
    const [, continued] = await usageRecords(email);
    fakeAnthropic([notesOk]);
    await post(NOTES_PATH, { ...notesInput, pageUsageRecordId: first.usageRecordId }, { token });
    vi.restoreAllMocks();
    const [, , notes] = await usageRecords(email);

    for (const id of [others.usageRecordId!, continued!.id, notes!.id, 999_999]) await translateAs(token, id);

    expect(await quota(token)).toEqual({ plan: 'free', remaining: 95 });
  });

  it('額度用完時，條件內的接續請求照樣翻譯（這頁已經扣過）', async () => {
    const email = freshEmail();
    const token = await signIn(email);
    expect((await post(DEV_FREE_PAGES_PATH, { email, remaining: 1 })).status).toBe(204);
    const first = await translateAs(token);
    expect(await quota(token)).toEqual({ plan: 'free', remaining: 0 });

    expect((await translateAs(token, first.usageRecordId)).status).toBe(200);
    expect((await translateAs(token)).status).toBe(402);
  });
});

describe('用量紀錄', () => {
  it('Notes 不扣額度', async () => {
    const token = await signIn();
    fakeAnthropic([notesOk]);

    expect((await post(NOTES_PATH, notesInput, { token })).status).toBe(200);

    expect(await quota(token)).toEqual({ plan: 'free', remaining: 100 });
  });

  it('翻譯與 Notes 各寫一筆：只有時間、種類、四種 tokens、依價目表算的成本與模型，沒有原文、譯文、Series 名稱或網址', async () => {
    const email = freshEmail();
    const token = await signIn(email);
    fakeAnthropic([ok, notesOk]);
    const seriesNotes = [{ seriesId: 's1', 原文: '霧島湊', 讀音: 'きりしまみなと', 譯文: '霧島湊', 類別: '人名', locked: false }];

    await post(TRANSLATE_PATH, { ...input, seriesName: '星屑バンド', seriesNotes, url: 'https://manga.example/episode/1' }, { token });
    await post(NOTES_PATH, notesInput, { token });

    const { results } = await env.DB.prepare(
      'SELECT * FROM usage_records WHERE account_id = (SELECT id FROM accounts WHERE email = ?) ORDER BY id',
    )
      .bind(email)
      .all();
    const record = (kind: string) => ({
      id: expect.any(Number),
      account_id: expect.any(String),
      created_at: expect.any(Number),
      kind,
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 700,
      cache_write_tokens: 100,
      cost_usd: USAGE_COST_USD,
      model: CLAUDE_MODEL,
      page_record_id: null,
      practice: 0,
      strip: 0,
      lines: null,
    });
    expect(results).toEqual([record('translate'), record('notes')]);
    const stored = JSON.stringify(results);
    for (const content of ['おはよう', '早安', '星屑バンド', '霧島湊', 'パン屋', '麵包店', 'manga.example']) expect(stored).not.toContain(content);
  });

  it('Notes 的用量歸到同一頁：翻譯回應帶回用量紀錄 id，Notes 請求帶回來，Notes 那筆就記下它', async () => {
    const email = freshEmail();
    const token = await signIn(email);
    fakeAnthropic([ok, notesOk]);

    const translated = (await (await translate(token)).json()) as { usageRecordId: number };
    await post(NOTES_PATH, { ...notesInput, pageUsageRecordId: translated.usageRecordId }, { token });

    expect(await usageRecords(email)).toEqual([
      { id: translated.usageRecordId, kind: 'translate', page_record_id: null },
      { id: expect.any(Number), kind: 'notes', page_record_id: translated.usageRecordId },
    ]);
  });

  it('Notes 帶來的 id 不是自己的翻譯紀錄（別人的、或是 Notes 的）就不記，Notes 照常回 200', async () => {
    const other = await signIn();
    const email = freshEmail();
    const token = await signIn(email);
    fakeAnthropic([ok, notesOk, notesOk, notesOk]);
    const othersRecord = ((await (await translate(other)).json()) as { usageRecordId: number }).usageRecordId;

    expect((await post(NOTES_PATH, { ...notesInput, pageUsageRecordId: othersRecord }, { token })).status).toBe(200);
    const [ownNotes] = await usageRecords(email);
    expect((await post(NOTES_PATH, { ...notesInput, pageUsageRecordId: ownNotes!.id }, { token })).status).toBe(200);
    expect((await post(NOTES_PATH, { ...notesInput, pageUsageRecordId: 'x' }, { token })).status).toBe(200);

    expect((await usageRecords(email)).map((r) => r.page_record_id)).toEqual([null, null, null]);
  });
});

/** 這個 email 的 Account 的用量紀錄：id、種類與歸屬的翻譯紀錄。 */
async function usageRecords(email: string) {
  const { results } = await env.DB.prepare(
    'SELECT id, kind, page_record_id FROM usage_records WHERE account_id = (SELECT id FROM accounts WHERE email = ?) ORDER BY id',
  )
    .bind(email)
    .all<{ id: number; kind: string; page_record_id: number | null }>();
  return results;
}
