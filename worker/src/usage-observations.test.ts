/**
 * 用量紀錄的觀察欄位（#341）：作品 ID、Series Notes 的條目數、Retranslation、Suspect Line、句數。
 * 從 HTTP 送請求，直接查 D1 看那一列（用量紀錄沒有 API 看得到，跟 quota.test.ts 一樣是 docs/agents/testing.md 的例外）。
 * 新版外掛才送的欄位（seriesId、notesEntries、retranslation）沒送就存 NULL：Worker 看不到讀者同意的是第幾版（ADR 0015）。
 */
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notesRequest, translateRequest } from '../../src/shared/claude-request.ts';
import { NOTES_PATH, TRANSLATE_PATH } from '../../src/shared/hosted-api.ts';
import type { NotesEntry, NotesInput, TranslateInput } from '../../src/shared/translator.ts';
import { fakeAnthropic, reply } from './test/anthropic.ts';
import { freshEmail, post, signIn } from './test/http.ts';

const SERIES_ID = '3f2b8c1e-5d4a-4e7b-9c6f-1a2b3c4d5e6f';

const entry = (原文: string, 譯文: string): NotesEntry => ({ seriesId: SERIES_ID, 原文, 讀音: '', 譯文, 類別: '人名', locked: false });

const seriesNotes = [entry('霧島', '霧島'), entry('湊', '湊')];

const input: TranslateInput = {
  seriesNotes,
  priorPages: [],
  items: [
    { id: 'b1', kind: 'balloon', 原文: 'おはよう', orientation: 'vertical' },
    { id: 'b2', kind: 'balloon', 原文: '今日は早いね', orientation: 'vertical' },
  ],
};

const ok = reply({
  items: [
    { id: 'b1', zh: '早安', unreadable: false, sfx: false },
    { id: 'b2', zh: '今天好早喔', unreadable: false, sfx: false },
  ],
});

const notesInput: NotesInput = { seriesNotes, items: [{ kind: 'balloon', 原文: '湊、パン屋に行こう', 譯文: '湊，去麵包店吧' }] };

const notesOk = reply({ notes_changes: { added: [], filled: [], suggestions: [] } });

const OBSERVATIONS = 'series_id, notes_entries, notes_sent_entries, suspect_lines, retranslation, lines';

async function observations(email: string) {
  const { results } = await env.DB.prepare(
    `SELECT kind, ${OBSERVATIONS} FROM usage_records WHERE account_id = (SELECT id FROM accounts WHERE email = ?) ORDER BY id`,
  )
    .bind(email)
    .all();
  return results;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('新版外掛送的觀察欄位', () => {
  it('翻譯：存請求最上層的作品 ID、Notes 總條數與 Retranslation，Worker 自己數送了幾條、翻了幾句、補問幾句；prompt 跟沒送時一樣', async () => {
    const email = freshEmail();
    const token = await signIn(email);
    const anthropic = fakeAnthropic([ok]);

    const response = await post(TRANSLATE_PATH, { ...input, seriesId: SERIES_ID, notesEntries: 12, retranslation: true }, { token });

    expect(response.status).toBe(200);
    expect(await observations(email)).toEqual([
      { kind: 'translate', series_id: SERIES_ID, notes_entries: 12, notes_sent_entries: 2, suspect_lines: 0, retranslation: 1, lines: 2 },
    ]);
    expect(anthropic.calls[0]!.body).toEqual(translateRequest(input));
  });

  it('Notes：同樣存作品 ID、Notes 總條數與 Retranslation，送了幾條各記各的；沒有句數與補問', async () => {
    const email = freshEmail();
    const token = await signIn(email);
    const anthropic = fakeAnthropic([notesOk]);

    const response = await post(NOTES_PATH, { ...notesInput, seriesNotes: [seriesNotes[0]], seriesId: SERIES_ID, notesEntries: 12, retranslation: false }, { token });

    expect(response.status).toBe(200);
    expect(await observations(email)).toEqual([
      { kind: 'notes', series_id: SERIES_ID, notes_entries: 12, notes_sent_entries: 1, suspect_lines: null, retranslation: 0, lines: null },
    ]);
    expect(anthropic.calls[0]!.body).toEqual(notesRequest({ ...notesInput, seriesNotes: [seriesNotes[0]!] }));
  });

  it('有 Suspect Line 時記再問了幾句', async () => {
    const email = freshEmail();
    const token = await signIn(email);
    const kana = reply({
      items: [
        { id: 'b1', zh: '早安', unreadable: false, sfx: false },
        { id: 'b2', zh: '今日は早い', unreadable: false, sfx: false },
      ],
    });
    fakeAnthropic([kana, reply({ items: [{ id: 'b2', zh: '今天好早喔', unreadable: false, sfx: false }] })]);

    expect((await post(TRANSLATE_PATH, input, { token })).status).toBe(200);

    expect(await observations(email)).toEqual([expect.objectContaining({ suspect_lines: 1 })]);
  });
});

describe('舊版外掛', () => {
  it('沒送觀察欄位：作品 ID、Notes 總條數、Retranslation 存 NULL，不從 Notes 條目拿作品 ID（讀者只同意過不存它的那版）', async () => {
    const email = freshEmail();
    const token = await signIn(email);
    fakeAnthropic([ok, notesOk]);

    await post(TRANSLATE_PATH, input, { token });
    await post(NOTES_PATH, notesInput, { token });

    expect(await observations(email)).toEqual([
      { kind: 'translate', series_id: null, notes_entries: null, notes_sent_entries: 2, suspect_lines: 0, retranslation: null, lines: 2 },
      { kind: 'notes', series_id: null, notes_entries: null, notes_sent_entries: 2, suspect_lines: null, retranslation: null, lines: null },
    ]);
  });

  it('作品 ID 不像外掛產生的隨機 UUID（例如作品名）、條目數不是非負整數：當作沒帶，照常翻譯', async () => {
    const email = freshEmail();
    const token = await signIn(email);
    fakeAnthropic([ok]);

    const response = await post(TRANSLATE_PATH, { ...input, seriesId: '星屑バンド', notesEntries: -1, retranslation: 'yes' }, { token });

    expect(response.status).toBe(200);
    expect(await observations(email)).toEqual([expect.objectContaining({ series_id: null, notes_entries: null, retranslation: null })]);
  });
});
