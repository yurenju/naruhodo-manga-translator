/**
 * 失敗但已經計費的 Anthropic 呼叫（#238）：Claude 回了答案，但 stop_reason 不是 end_turn 或不符合 schema。
 * Worker 照舊回 502、不扣頁、不寫用量紀錄（以免 CONTINUABLE 這類查詢把它當成翻好的頁），改成在 Worker Logs 印一行
 * anthropic_billed_failure：只有種類、模型、四種 token、成本與原因，沒有 Account 與任何文字。
 * 從 HTTP 與 console.warn 觀察；「沒寫用量紀錄」沒有 API 看得到，直接查 D1（docs/agents/testing.md 的例外）。
 */
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_MODEL } from '../../src/shared/claude-request.ts';
import { ACCOUNT_PATH, NOTES_PATH, SERIES_GUESS_PATH, TRANSLATE_PATH, type AccountResponse } from '../../src/shared/hosted-api.ts';
import type { NotesInput, TitleSignals, TranslateInput } from '../../src/shared/translator.ts';
import { fakeAnthropic, usage, USAGE_COST_USD } from './test/anthropic.ts';
import { freshEmail, get, post, signIn } from './test/http.ts';

const translateInput: TranslateInput = {
  seriesName: '星屑バンド',
  seriesNotes: [],
  priorPages: [],
  items: [{ id: 'b1', kind: 'balloon', 原文: 'おはよう', orientation: 'vertical' }],
};
const notesInput: NotesInput = { seriesNotes: [], items: [{ kind: 'balloon', 原文: '湊、パン屋に行こう', 譯文: '湊，去麵包店吧' }] };
const signals: TitleSignals = { title: '範例作品 - 作者 | 網站', ogTitle: '', headings: [] };

/** Anthropic 計費了的回應：usage 照樣有，但 stop_reason 或內容不對。 */
const billed = (stop_reason: string | null, text: string) => () =>
  Response.json({ model: CLAUDE_MODEL, stop_reason, content: [{ type: 'text', text }], usage });

/** 回答裡的文字：不能出現在 log 裡。 */
const ANSWER_TEXT = '早安譯文';

afterEach(() => {
  vi.restoreAllMocks();
});

/** 這一行 log 的全部欄位（toEqual：多了 account_id 或任何文字欄位都會失敗）。 */
const failureLine = (kind: string, reason: string) => ({
  event: 'anthropic_billed_failure',
  kind,
  model: CLAUDE_MODEL,
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_tokens: 700,
  cache_write_tokens: 100,
  cost_usd: USAGE_COST_USD,
  reason,
});

async function usageRecordCount(email: string): Promise<number> {
  const row = await env.DB.prepare('SELECT count(*) AS n FROM usage_records WHERE account_id = (SELECT id FROM accounts WHERE email = ?)')
    .bind(email)
    .first<{ n: number }>();
  return row!.n;
}

describe('失敗但已計費的呼叫', () => {
  for (const [path, body, kind] of [
    [TRANSLATE_PATH, translateInput, 'translate'],
    [NOTES_PATH, notesInput, 'notes'],
    [SERIES_GUESS_PATH, signals, 'series_guess'],
  ] as const) {
    for (const [name, response, reason] of [
      ['stop_reason 是 max_tokens', billed('max_tokens', `{"items":[{"id":"b1","zh":"${ANSWER_TEXT}`), 'max_tokens'],
      ['回答不符合 schema', billed('end_turn', JSON.stringify({ unexpected: ANSWER_TEXT })), 'schema'],
    ] as const) {
      it(`${kind}：${name} → 502，印一行 anthropic_billed_failure，不寫用量紀錄、不扣頁`, async () => {
        const email = freshEmail();
        const token = await signIn(email);
        fakeAnthropic([response]);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect((await post(path, body, { token })).status).toBe(502);

        expect(warn).toHaveBeenCalledTimes(1);
        const [line] = warn.mock.calls[0]!;
        expect(JSON.parse(line as string)).toEqual(failureLine(kind, reason));
        for (const text of [ANSWER_TEXT, 'おはよう', '星屑バンド', 'パン屋', '範例作品', email]) expect(line).not.toContain(text);
        vi.restoreAllMocks();
        expect(await usageRecordCount(email)).toBe(0);
        expect(((await (await get(ACCOUNT_PATH, token)).json()) as AccountResponse).quota.remaining).toBe(100);
      });
    }
  }

  it('Anthropic 回錯誤（沒有計費）不印', async () => {
    const token = await signIn();
    fakeAnthropic([() => Response.json({ error: { message: 'invalid x-api-key' } }, { status: 401 })]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect((await post(TRANSLATE_PATH, translateInput, { token })).status).toBe(502);

    expect(warn).not.toHaveBeenCalled();
  });
});
