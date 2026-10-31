import { describe, expect, it, vi } from 'vitest';
import type { NotesInput, TranslateInput } from '../shared/translator.ts';
import { CLAUDE_MODEL, costUsd, createClaudeTranslator, type ClaudeDeps } from './claude-translator.ts';

const input: TranslateInput = {
  seriesNotes: [
    { seriesId: 's1', 原文: '霧島湊', 讀音: 'きりしまみなと', 譯文: '霧島湊', 類別: '人名', locked: false },
  ],
  priorPages: [],
  items: [
    { id: 'b1', kind: 'balloon', 原文: 'おはよう！今日は早いね', orientation: 'vertical' },
    { id: 'l1', kind: 'loose', 原文: 'ドドドド', orientation: 'vertical' },
  ],
};

const notesInput: NotesInput = {
  seriesNotes: input.seriesNotes,
  items: [{ kind: 'balloon', 原文: '湊、パン屋に行こう', 譯文: '湊，去麵包店吧' }],
};

/** structured outputs 回來的 JSON（text 區塊裡的字串）。 */
const answer = {
  items: [
    { id: 'b1', reading: 'おはよう！きょうははやいね', zh: '早安！今天好早喔', unreadable: false, sfx: false },
    { id: 'l1', reading: 'どどどど', zh: '', unreadable: true, sfx: true },
  ],
};

const notesAnswer = {
  notes_changes: {
    added: [{ ja: 'パン屋', reading: 'ぱんや', zh: '麵包店', category: '地名', note: '' }],
    filled: [{ ja: '霧島湊', reading: '', zh: '', category: '', note: '主角' }],
    suggestions: [{ ja: '霧島湊', zh: '霧島港', reason: '' }],
  },
};

const usage = { input_tokens: 300, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 700 };

function response(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json', ...init.headers } });
}

const ok = () => response({ model: CLAUDE_MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }], usage });

const okNotes = () =>
  response({
    model: CLAUDE_MODEL,
    stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(notesAnswer) }],
    usage,
  });

const body = (call: { init: RequestInit }) => JSON.parse(call.init.body as string);

function setup(responses: (() => Response)[], overrides: Partial<ClaudeDeps> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  let clock = 1000;
  const deps: ClaudeDeps = {
    apiKey: 'sk-ant-test-1234',
    fetch: vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      clock += 2300;
      const next = responses.shift();
      if (!next) throw new Error('no more responses');
      return next();
    }),
    sleep: vi.fn(async () => {}),
    now: () => clock,
    ...overrides,
  };
  return { translator: createClaudeTranslator(deps), calls, deps };
}

describe('Claude 翻譯：request', () => {
  it('從瀏覽器直接呼叫 Messages API：Haiku 5.5、effort low、structured outputs、關 thinking、不送 sampling 參數', async () => {
    const { translator, calls } = setup([ok]);

    await translator.translatePage(input);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'sk-ant-test-1234',
      'anthropic-version': '2026-10-21',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.output_config.effort).toBe('low');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(Object.keys(body.output_config.format.schema.properties)).toEqual(['items']); // 只回譯文，Notes 由 ② 整理
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('stream');
  });

  it('system 分兩段、各標 cache_control：固定的指示在前、Series Notes 在後；這頁的原文（依閱讀順序、只帶 id）放在 user message', async () => {
    const { translator, calls } = setup([ok]);

    await translator.translatePage(input);

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.system).toHaveLength(2);
    expect(body.system.map((b: { cache_control: unknown }) => b.cache_control)).toEqual([{ type: 'ephemeral' }, { type: 'ephemeral' }]);
    expect(body.system[0].text).not.toContain('霧島湊');
    expect(body.system[1].text).toContain('霧島湊');
    expect(body.system[1].text).not.toContain('s1'); // seriesId 不必送
    expect(body.messages).toHaveLength(1); // 不帶前一頁的對話
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toHaveLength(1); // 沒有 Prior Pages
    const sent = JSON.parse(body.messages[0].content[0].text);
    expect(sent).toEqual([
      { id: 'b1', kind: 'balloon', ja: 'おはよう！今日は早いね' },
      { id: 'l1', kind: 'loose', ja: 'ドドドド' },
    ]);
  });

  it('Prior Pages 放在 user message 這頁原文的前面，每句只送 kind、原文、譯文', async () => {
    const { translator, calls } = setup([ok]);
    const prior = [
      [{ kind: 'balloon' as const, 原文: '個性を大事に', 譯文: '重視個性' }],
      [{ kind: 'loose' as const, 原文: 'ガラッ', 譯文: '喀啦' }],
    ];

    await translator.translatePage({ ...input, priorPages: prior });

    const content = body(calls[0]!).messages[0].content;
    expect(content).toHaveLength(2);
    expect(content[0].text).toMatch(/^context/);
    expect(JSON.parse(content[0].text.slice(content[0].text.indexOf('\n') + 1))).toEqual([
      [{ kind: 'balloon', ja: '個性を大事に', zh: '重視個性' }],
      [{ kind: 'loose', ja: 'ガラッ', zh: '喀啦' }],
    ]);
    expect(content[1].text).toContain('おはよう！今日は早いね');
  });

  it('Prior Pages 不同，system 仍逐字相同（prompt cache 照樣命中）', async () => {
    const { translator, calls } = setup([ok, ok]);

    await translator.translatePage(input);
    await translator.translatePage({ ...input, priorPages: [[{ kind: 'balloon', 原文: '前', 譯文: '前' }]] });

    const [a, b] = calls.map(body);
    expect(a.system).toEqual(b.system);
  });

  it('同樣的 Series Notes 每頁送出的 system 逐字相同（prompt cache 才會命中）', async () => {
    const { translator, calls } = setup([ok, ok]);

    await translator.translatePage(input);
    await translator.translatePage({ ...input, items: [{ id: 'x', kind: 'balloon', 原文: '別のページ', orientation: 'vertical' }] });

    const [a, b] = calls.map((c) => JSON.parse(c.init.body as string));
    expect(a.system).toEqual(b.system);
    expect(a.output_config).toEqual(b.output_config);
  });

  it('Series Notes 變了（前一頁新增了條目）：指示那段仍逐字相同，第 2 頁起吃得到它的快取', async () => {
    const { translator, calls } = setup([ok, ok]);

    await translator.translatePage({ ...input, seriesNotes: [] });
    await translator.translatePage(input);

    const [a, b] = calls.map((c) => JSON.parse(c.init.body as string));
    expect(a.system).toEqual([b.system[0]]);
  });
});

describe('Claude 翻譯：structured output 回應解析', () => {
  it('把讀音、譯文、unreadable、sfx 依 id 對回來', async () => {
    const { translator } = setup([ok]);

    const output = await translator.translatePage(input);

    expect(output.items).toEqual([
      { id: 'b1', 讀音: 'おはよう！きょうははやいね', 譯文: '早安！今天好早喔', unreadable: false, sfx: false },
      { id: 'l1', 讀音: 'どどどど', 譯文: '', unreadable: true, sfx: true },
    ]);
    expect(output.model).toBe('claude-haiku-5-5');
  });

  it('記錄延遲、token 用量（input 含快取的部分）與費用', async () => {
    const { translator } = setup([ok]);

    const output = await translator.translatePage(input);

    expect(output.latencyMs).toBe(2300);
    expect(output.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 700,
      // 300 × 0.10 + 700 × 0.01 + 200 × 0.50（$/MTok）
      costUsd: 0.000137,
    });
  });

  it('回應被截斷（max_tokens）時視為失敗', async () => {
    const { translator } = setup([
      () => response({ model: CLAUDE_MODEL, stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"items":[' }], usage }),
    ]);

    await expect(translator.translatePage(input)).rejects.toThrow(/max_tokens/);
  });

  it('拒絕回答（refusal）時視為失敗', async () => {
    const { translator } = setup([() => response({ model: CLAUDE_MODEL, stop_reason: 'refusal', content: [], usage })]);

    await expect(translator.translatePage(input)).rejects.toThrow(/refusal/);
  });

  it('回應不符合 schema 時視為失敗', async () => {
    const { translator } = setup([
      () => response({ model: CLAUDE_MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text: '{"items":[{"id":1}]}' }], usage }),
    ]);

    await expect(translator.translatePage(input)).rejects.toThrow(/格式/);
  });
});

describe('Claude 整理 Notes（②）', () => {
  it('不關 thinking、effort high（仔細比對既有條目，#64）；只回 notes_changes；送這頁的原文與 ① 的譯文，Series Notes 在 system 第二段', async () => {
    const { translator, calls } = setup([okNotes]);

    await translator.proposeNotes(notesInput);

    const sent = body(calls[0]!);
    expect(sent.model).toBe('claude-haiku-5-5');
    expect(sent).not.toHaveProperty('thinking');
    expect(sent.output_config.effort).toBe('high');
    expect(Object.keys(sent.output_config.format.schema.properties)).toEqual(['notes_changes']);
    expect(sent.system).toHaveLength(2);
    expect(sent.system[1].text).toContain('霧島湊');
    expect(JSON.parse(sent.messages[0].content[0].text)).toEqual([{ kind: 'balloon', ja: '湊、パン屋に行こう', zh: '湊，去麵包店吧' }]);
  });

  it('LLM 不填自稱、語氣、稱呼：schema 裡沒有這些欄位', async () => {
    const { translator, calls } = setup([okNotes]);

    await translator.proposeNotes(notesInput);

    const fields = body(calls[0]!).output_config.format.schema.properties.notes_changes.properties.added.items.properties;
    expect(Object.keys(fields)).toEqual(['ja', 'reading', 'zh', 'category', 'note']);
  });

  it('notes_changes 轉成新增／補空欄位／建議修改三種；空字串代表沒有這個欄位', async () => {
    const { translator } = setup([okNotes]);

    const output = await translator.proposeNotes(notesInput);

    expect(output.notes_changes).toEqual({
      added: [{ 原文: 'パン屋', 讀音: 'ぱんや', 譯文: '麵包店', 類別: '地名' }],
      filled: [{ 原文: '霧島湊', fields: { 備註: '主角' } }],
      suggestions: [{ 原文: '霧島湊', 建議譯文: '霧島港' }],
    });
    expect(output.latencyMs).toBe(2300);
  });

  it('翻譯與整理 Notes 的指示不同，各自的 system 第一段都固定（各自吃得到 prompt cache）', async () => {
    const { translator, calls } = setup([ok, okNotes, okNotes]);

    await translator.translatePage(input);
    await translator.proposeNotes(notesInput);
    await translator.proposeNotes({ ...notesInput, items: [] });

    const [t, n1, n2] = calls.map(body);
    expect(t.system[0]).not.toEqual(n1.system[0]);
    expect(n1.system).toEqual(n2.system);
  });

  it('回應不符合 schema 時視為失敗', async () => {
    const { translator } = setup([ok]);

    await expect(translator.proposeNotes(notesInput)).rejects.toThrow(/格式/);
  });
});

describe('Claude 翻譯：錯誤與重試', () => {
  it('429 依 retry-after 等待後重試', async () => {
    const { translator, deps } = setup([
      () => response({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { status: 429, headers: { 'retry-after': '7' } }),
      ok,
    ]);

    const output = await translator.translatePage(input);

    expect(output.items).toHaveLength(2);
    expect(deps.sleep).toHaveBeenCalledWith(7000, undefined);
  });

  it('429 最多重試 3 次，之後失敗並帶上 API 的錯誤訊息', async () => {
    const limited = () => response({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { status: 429 });
    const { translator, deps } = setup([limited, limited, limited, limited, ok]);

    await expect(translator.translatePage(input)).rejects.toThrow('Claude API 429：slow down');
    expect(deps.fetch).toHaveBeenCalledTimes(4);
  });

  it('沒有 retry-after 時用指數退避', async () => {
    const overloaded = () => response({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { status: 529 });
    const { translator, deps } = setup([overloaded, overloaded, ok]);

    await translator.translatePage(input);

    expect(vi.mocked(deps.sleep).mock.calls.map(([ms]) => ms)).toEqual([2000, 4000]);
  });

  it('401 等用戶端錯誤不重試；錯誤訊息不含 API key', async () => {
    const { translator, deps } = setup([
      () => response({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 }),
    ]);

    const error = await translator.translatePage(input).then(
      () => new Error('should have failed'),
      (e: unknown) => e as Error,
    );

    expect(error.message).toBe('Claude API 401：invalid x-api-key');
    expect(error.message).not.toContain('sk-ant-test-1234');
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });

  it('把 AbortSignal 交給 fetch', async () => {
    const { translator, calls } = setup([ok]);
    const controller = new AbortController();

    await translator.translatePage(input, controller.signal);

    expect(calls[0]!.init.signal).toBe(controller.signal);
  });
});

describe('Claude 翻譯：測試連線', () => {
  it('用同一個 endpoint 與 header 送一個很小的 request，成功就回傳模型', async () => {
    const { translator, calls } = setup([() => response({ model: CLAUDE_MODEL, stop_reason: 'max_tokens', content: [], usage })]);

    await expect(translator.testConnection()).resolves.toEqual({ model: 'claude-haiku-5-5' });
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(JSON.parse(calls[0]!.init.body as string).max_tokens).toBeLessThanOrEqual(16);
  });

  it('key 錯誤時失敗並帶上 API 的錯誤訊息', async () => {
    const { translator } = setup([
      () => response({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 }),
    ]);

    await expect(translator.testConnection()).rejects.toThrow('Claude API 401：invalid x-api-key');
  });
});

describe('費用', () => {
  it('Haiku 5.5：input $0.10、output $0.50、cache read $0.01、cache write $0.125（每百萬 token）', () => {
    expect(
      costUsd('claude-haiku-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }),
    ).toBeCloseTo(0.1 + 0.5 + 0.01 + 0.125, 10);
  });

  it('不認得的模型不猜價格（回傳 NaN，由呼叫端顯示「未知」）', () => {
    expect(costUsd('claude-unknown', { input_tokens: 1, output_tokens: 1 })).toBeNaN();
  });
});
