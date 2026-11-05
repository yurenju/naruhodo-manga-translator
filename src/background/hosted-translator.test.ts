import { describe, expect, it, vi } from 'vitest';
import type { NotesInput, NotesOutput, TranslateInput, TranslateOutput } from '../shared/translator.ts';
import { createHostedTranslator, QuotaExhaustedError, type HostedDeps } from './hosted-translator.ts';

const input: TranslateInput = {
  seriesNotes: [{ seriesId: 's1', 原文: '霧島湊', 讀音: 'きりしまみなと', 譯文: '霧島湊', 類別: '人名', locked: false }],
  priorPages: [[{ kind: 'balloon', 原文: '個性を大事に', 譯文: '重視個性' }]],
  items: [{ id: 'b1', kind: 'balloon', 原文: 'おはよう！今日は早いね', orientation: 'vertical' }],
};

const notesInput: NotesInput = {
  seriesNotes: input.seriesNotes,
  items: [{ kind: 'balloon', 原文: '湊、パン屋に行こう', 譯文: '湊，去麵包店吧' }],
};

const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 700, costUsd: 0.000137 };

/** Worker 回的 TranslateOutput（latencyMs 是 Worker 到 Anthropic 的時間，外掛用自己量的）。 */
const translated: TranslateOutput = {
  items: [{ id: 'b1', 譯文: '早安！今天好早喔', unreadable: false }],
  usage,
  model: 'claude-haiku-5-5',
  latencyMs: 1800,
};

const notesOutput: NotesOutput = {
  notes_changes: { added: [{ 原文: 'パン屋', 讀音: 'ぱんや', 譯文: '麵包店', 類別: '地名' }], filled: [], suggestions: [] },
  usage,
  model: 'claude-haiku-5-5',
  latencyMs: 4000,
};

function response(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json', ...init.headers } });
}

function setup(responses: (() => Response)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let clock = 1000;
  const deps: HostedDeps = {
    apiUrl: 'http://localhost:8788',
    token: 'session-token-1234',
    fetch: vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      clock += 2300;
      const next = responses.shift();
      if (!next) throw new Error('no more responses');
      return next();
    }),
    sleep: vi.fn(async () => {}),
    now: () => clock,
    onSignedOut: vi.fn(),
    onQuotaChanged: vi.fn(),
  };
  return { translator: createHostedTranslator(deps), calls, deps };
}

describe('Hosted Translation：request', () => {
  it('翻譯送到 Worker 的翻譯端點，帶 token；body 是結構化輸入，不是 prompt', async () => {
    const { translator, calls } = setup([() => response(translated)]);

    await translator.translatePage(input);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('http://localhost:8788/v1/translate');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer session-token-1234' });
    const body = JSON.parse(init.body as string);
    expect(body).toEqual(input);
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('system');
  });

  it('Notes 送到 Notes 端點', async () => {
    const { translator, calls } = setup([() => response(notesOutput)]);

    const output = await translator.proposeNotes(notesInput);

    expect(calls[0]!.url).toBe('http://localhost:8788/v1/notes');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(notesInput);
    expect(output.notes_changes).toEqual(notesOutput.notes_changes);
  });
});

describe('Hosted Translation：回應', () => {
  it('回傳 Worker 的譯文、用量與模型；延遲是外掛自己量的（含 Worker 那一段）', async () => {
    const { translator } = setup([() => response(translated)]);

    const output = await translator.translatePage(input);

    expect(output).toEqual({ ...translated, latencyMs: 2300 });
  });

  it('Worker 回錯誤：丟出 Worker 的訊息，不重試', async () => {
    const { translator, calls, deps } = setup([() => response({ error: '輸入格式不符' }, { status: 400 })]);

    await expect(translator.translatePage(input)).rejects.toThrow('Hosted Translation 400：輸入格式不符');
    expect(calls).toHaveLength(1);
    expect(deps.onSignedOut).not.toHaveBeenCalled();
  });

  it('token 已失效（401 signedOut）：通知外掛已登出，丟出 Worker 的訊息，不重試', async () => {
    const { translator, calls, deps } = setup([() => response({ error: '請先登入', reason: 'signedOut' }, { status: 401 })]);

    await expect(translator.translatePage(input)).rejects.toThrow('Hosted Translation 401：請先登入');
    expect(calls).toHaveLength(1);
    expect(deps.onSignedOut).toHaveBeenCalledOnce();
  });

  it('免費額度用完（402 freePagesExhausted）：丟出 QuotaExhaustedError 並通知額度變了，不重試', async () => {
    const { translator, calls, deps } = setup([() => response({ error: '免費額度已用完', reason: 'freePagesExhausted' }, { status: 402 })]);

    const error = await translator.translatePage(input).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect(error).toMatchObject({ reason: 'freePagesExhausted', message: 'Hosted Translation 402：免費額度已用完' });
    expect(calls).toHaveLength(1);
    expect(deps.onQuotaChanged).toHaveBeenCalledOnce();
  });

  it('翻譯成功通知額度變了（扣了一頁）；Notes 不扣，不通知', async () => {
    const { translator, deps } = setup([() => response(translated), () => response(notesOutput)]);

    await translator.translatePage(input);
    await translator.proposeNotes(notesInput);

    expect(deps.onQuotaChanged).toHaveBeenCalledOnce();
  });

  it('Anthropic 失敗（502）：Worker 已經重試過，外掛不再重試', async () => {
    const { translator, calls } = setup([() => response({ error: 'Claude API 529：Overloaded' }, { status: 502 })]);

    await expect(translator.translatePage(input)).rejects.toThrow('Hosted Translation 502：Claude API 529：Overloaded');
    expect(calls).toHaveLength(1);
  });

  it('429／503：依 retry-after 等待後重試，最多 3 次', async () => {
    const busy = () => response({ error: 'busy' }, { status: 429, headers: { 'retry-after': '2' } });
    const { translator, calls, deps } = setup([busy, () => response({ error: 'down' }, { status: 503 }), () => response(translated)]);

    const output = await translator.translatePage(input);

    expect(output.items).toEqual(translated.items);
    expect(calls).toHaveLength(3);
    expect(deps.sleep).toHaveBeenNthCalledWith(1, 2000, undefined);
    expect(deps.sleep).toHaveBeenNthCalledWith(2, 4000, undefined);
  });

  it('429 重試 3 次仍失敗就丟錯', async () => {
    const busy = () => response({ error: 'busy' }, { status: 429 });
    const { translator, calls } = setup([busy, busy, busy, busy]);

    await expect(translator.translatePage(input)).rejects.toThrow('Hosted Translation 429：busy');
    expect(calls).toHaveLength(4);
  });
});
