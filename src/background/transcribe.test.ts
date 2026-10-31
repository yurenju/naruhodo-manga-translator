import { describe, expect, it, vi } from 'vitest';
import { sameLongPage } from '../shared/long-page.ts';
import type { AnalyzeRequest, CropRequest, PageThumb, PageView } from '../shared/messages.ts';
import type { PageText, PageTranslation } from '../shared/page-text.ts';
import { editEntry, type NotesSuggestion, type SeriesNotes } from '../shared/series-notes.ts';
import type { NotesChanges, NotesEntry, NotesInput, TranslateInput, TranslateOutput, Translator } from '../shared/translator.ts';
import { createClaudeTranslator } from '../offscreen/claude-translator.ts';
import { QuotaExhaustedError } from './hosted-translator.ts';
import { createTranscriber, type NotesStore, type PageCache, type TranscriberDeps } from './transcribe.ts';

const rect = { x: 0, y: 0, w: 1, h: 1 };

const pageText: PageText = {
  balloons: [
    {
      id: 'b1',
      order: 1,
      balloonBbox: rect,
      textBbox: rect,
      orientation: 'vertical',
      原文: '今日は',
      讀音: 'こんにちは',
      讀音來源: 'kuromoji',
      譯文: '',
      unreadable: false,
    },
  ],
  looseText: [
    { id: 'l1', order: 2, bbox: rect, orientation: 'horizontal', 原文: 'ドン', 讀音: 'どん', 讀音來源: 'kuromoji', 譯文: '', unreadable: false },
  ],
};

/** 每個 anchor 預設一個互相距離 ≥ 128 bits 的 hash（同 hash＝同一個 Page，會去重）。 */
const HASHES: Record<string, string> = {
  a1: '0'.repeat(64),
  a2: 'f'.repeat(64),
  a3: '0f'.repeat(32),
  a4: 'f0'.repeat(32),
  a5: '00ff'.repeat(16),
};

const thumb = (anchorId: string, pageHash = HASHES[anchorId] ?? '0'.repeat(64)): PageThumb => ({
  anchorId,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  thumbnail: `data:${anchorId}`,
  pageHash,
});
const capture: CropRequest = { screenshot: 'data:shot', viewport: { width: 100, height: 100 }, candidates: [] };

/** 記憶體裡的快取；查詢只比對完全相同的 hash（門檻比對由 page-hash.test.ts 負責）。 */
function memoryCache(): PageCache & { saved: PageTranslation[] } {
  const saved: PageTranslation[] = [];
  return {
    saved,
    find: async (seriesId, pageHash) => saved.find((t) => t.seriesId === seriesId && !t.stripes && t.pageHash === pageHash),
    findLong: async (seriesId, stripes) => saved.find((t) => t.seriesId === seriesId && t.stripes && sameLongPage(t.stripes, stripes)),
    // 跟 IndexedDB 的 put 一樣：同一個 key 覆寫
    async save(translation) {
      const i = saved.findIndex((t) => t.seriesId === translation.seriesId && t.pageHash === translation.pageHash);
      saved.splice(i === -1 ? saved.length : i, i === -1 ? 0 : 1, structuredClone(translation));
    },
  };
}

/** 記憶體裡的 Series Notes。 */
function memoryNotes(initial: NotesEntry[] = []): NotesStore & { entries: NotesEntry[]; suggestions: NotesSuggestion[] } {
  const store = {
    entries: structuredClone(initial),
    suggestions: [] as NotesSuggestion[],
    list: async (seriesId: string) => structuredClone(store.entries.filter((e) => e.seriesId === seriesId)),
    load: async (seriesId: string) =>
      structuredClone({ entries: store.entries.filter((e) => e.seriesId === seriesId), suggestions: store.suggestions.filter((s) => s.seriesId === seriesId) }),
    async save(seriesId: string, notes: SeriesNotes) {
      store.entries = [...store.entries.filter((e) => e.seriesId !== seriesId), ...structuredClone(notes.entries)];
      store.suggestions = [...store.suggestions.filter((s) => s.seriesId !== seriesId), ...structuredClone(notes.suggestions)];
    },
  };
  return store;
}

function setup(overrides: Partial<TranscriberDeps> = {}) {
  const published: PageView[][] = [];
  const deps: TranscriberDeps = {
    analyze: vi.fn(async () => structuredClone(pageText)),
    getTranslator: () => undefined,
    getSeriesId: async () => 'series-1',
    getSeries: async (id) => ({ id, name: '未命名・manga.example・2026-10-31', provisional: true, createdAt: 0 }),
    cache: memoryCache(),
    notes: memoryNotes(),
    publish: (_tabId, pages) => published.push(structuredClone(pages)),
    ...overrides,
  };
  return { transcriber: createTranscriber(deps), published, deps };
}

const noChanges = (): NotesChanges => ({ added: [], filled: [], suggestions: [] });

/** ② 什麼都不改。 */
const noNotes: Pick<Translator, 'proposeNotes'> = {
  async proposeNotes() {
    return { notes_changes: noChanges(), usage: { inputTokens: 500, outputTokens: 80, cacheReadTokens: 0, costUsd: 0.0001 }, model: 'claude-haiku-5-5', latencyMs: 1500 };
  },
};

function translatorReturning(zh: string, calls: TranslateInput[] = []): Translator {
  return {
    ...noNotes,
    async translatePage(input) {
      calls.push(input);
      return {
        items: input.items.map((i) => ({ id: i.id, 讀音: `${i.id}-讀音`, 譯文: `${zh}-${i.id}`, unreadable: false })),
        usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 700, costUsd: 0.000137 },
        model: 'claude-haiku-5-5',
        latencyMs: 2300,
      };
    },
  };
}

const translatedOutput = (): TranslateOutput => ({
  items: [
    { id: 'b1', 讀音: 'きょうは', 譯文: '今天', unreadable: false },
    { id: 'l1', 讀音: 'どん', 譯文: '咚', unreadable: false },
  ],
  usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, costUsd: 0.0003 },
  model: 'claude-haiku-5-5',
  latencyMs: 2300,
});

describe('逐字稿：本機流水線＋Translator', () => {
  it('先列出縮圖（分析中），分析完顯示原文＋kuromoji 讀音，沒有 Translator 時標示未翻譯', async () => {
    const { transcriber, published } = setup();

    await transcriber.update(1, [thumb('a1')], capture);

    expect(published[0]!.map((p) => p.transcript)).toEqual([{ state: 'analyzing' }]);
    expect(published.at(-1)!.map((p) => p.transcript)).toEqual([{ state: 'done', text: pageText, translated: false }]);
    expect(transcriber.get(1)).toEqual(published.at(-1));
  });

  it('有 Translator 時依閱讀順序送出原文，讀音與譯文換成它的結果', async () => {
    let input: TranslateInput | undefined;
    const translator: Translator = {
      ...noNotes,
      async translatePage(i) {
        input = i;
        return {
          items: [
            { id: 'b1', 讀音: 'きょうは', 譯文: '今天', unreadable: false, sfx: false },
            { id: 'l1', 讀音: 'どん', 譯文: '咚', unreadable: true, sfx: true },
          ],
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
          model: 'fake',
          latencyMs: 0,
        };
      },
    };
    const { transcriber, published } = setup({ getTranslator: () => translator });

    await transcriber.update(1, [thumb('a1')], capture);

    expect(input).toEqual({
      seriesNotes: [],
      priorPages: [],
      items: [
        { id: 'b1', kind: 'balloon', 原文: '今日は', orientation: 'vertical' },
        { id: 'l1', kind: 'loose', 原文: 'ドン', orientation: 'horizontal' },
      ],
    });
    const last = published.at(-1)![0]!.transcript;
    expect(last.state === 'done' && last.translated).toBe(true);
    if (last.state !== 'done') return;
    expect(last.text.balloons[0]).toMatchObject({ 讀音: 'きょうは', 讀音來源: 'llm', 譯文: '今天', unreadable: false, sfx: false });
    expect(last.text.looseText[0]).toMatchObject({ 讀音: 'どん', 讀音來源: 'llm', 譯文: '咚', unreadable: true, sfx: true });
  });

  it('Translator 沒回 sfx（部署中的舊版 Worker）：PageText 也沒有 sfx，Loose Text 不覆蓋', async () => {
    const { transcriber, published } = setup({ getTranslator: () => translatorReturning('譯') });

    await transcriber.update(1, [thumb('a1')], capture);

    const last = published.at(-1)![0]!.transcript;
    if (last.state !== 'done') throw new Error(last.state);
    expect(last.text.looseText[0]).toMatchObject({ 譯文: '譯-l1' });
    expect(last.text.looseText[0]).not.toHaveProperty('sfx');
  });

  it('OCR 信心低於門檻的段（本機已判 unreadable）：Translator 回 unreadable: false 也維持 unreadable', async () => {
    const lowConfidence = structuredClone(pageText);
    lowConfidence.balloons[0] = { ...lowConfidence.balloons[0]!, unreadable: true, ocrConfidence: 0.17 };
    const { transcriber, published } = setup({ analyze: vi.fn(async () => structuredClone(lowConfidence)), getTranslator: () => translatorReturning('譯') });

    await transcriber.update(1, [thumb('a1')], capture);

    const last = published.at(-1)![0]!.transcript;
    if (last.state !== 'done') throw new Error('還沒翻完');
    expect(last.text.balloons[0]).toMatchObject({ 譯文: '譯-b1', unreadable: true, ocrConfidence: 0.17 });
    expect(last.text.looseText[0]).toMatchObject({ unreadable: false });
  });

  it('讀者命名過的 Series：翻譯請求帶作品名', async () => {
    const calls: TranslateInput[] = [];
    const { transcriber } = setup({
      getTranslator: () => translatorReturning('譯', calls),
      getSeries: async (id) => ({ id, name: '星屑バンド', provisional: false, createdAt: 0 }),
    });

    await transcriber.update(1, [thumb('a1')], capture);

    expect(calls.map((c) => c.seriesName)).toEqual(['星屑バンド']);
  });

  it('Provisional Series 的名稱是自動產生的，不當作品名送出', async () => {
    const calls: TranslateInput[] = [];
    const { transcriber } = setup({
      getTranslator: () => translatorReturning('譯', calls),
      getSeries: async (id) => ({ id, name: '未命名・manga.example・2026-10-31', provisional: true, createdAt: 0 }),
    });

    await transcriber.update(1, [thumb('a1')], capture);

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('seriesName');
  });

  it('Translator 失敗時保留 kuromoji 讀音、標示未翻譯，並帶上錯誤訊息', async () => {
    const translator: Translator = { ...noNotes, translatePage: async () => Promise.reject(new Error('Claude API 429：slow down')) };
    const { transcriber, published } = setup({ getTranslator: () => translator });

    await transcriber.update(1, [thumb('a1')], capture);

    expect(published.at(-1)![0]!.transcript).toEqual({
      state: 'done',
      text: pageText,
      translated: false,
      translateError: 'Claude API 429：slow down',
    });
  });

  it('翻譯成功時帶上模型、秒數與費用（狀態列用）', async () => {
    const { transcriber } = setup({ getTranslator: async () => translatorReturning('今天') });

    await transcriber.update(1, [thumb('a1')], capture);

    const transcript = transcriber.get(1)[0]!.transcript;
    expect(transcript.state === 'done' && transcript.translation).toEqual({
      source: 'translated',
      model: 'claude-haiku-5-5',
      latencyMs: 2300,
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 700, costUsd: 0.000137 },
    });
  });

  it('本機流水線失敗（例如模型 SHA-256 不符）時這頁顯示錯誤', async () => {
    const { transcriber, published } = setup({ analyze: async () => Promise.reject(new Error('模型檔 SHA-256 不符')) });

    await transcriber.update(1, [thumb('a1')], capture);

    expect(published.at(-1)![0]!.transcript).toEqual({ state: 'error', message: '模型檔 SHA-256 不符' });
  });

  it('每個 Page 依序分析，各自帶上自己的候選', async () => {
    const { transcriber, deps } = setup();

    await transcriber.update(1, [thumb('a1'), thumb('a2')], capture);

    expect(vi.mocked(deps.analyze).mock.calls.map(([request]) => request.candidate.anchorId)).toEqual(['a1', 'a2']);
  });

  it('停止（clear）之後才完成的分析結果丟掉', async () => {
    let finish!: (text: PageText) => void;
    const { transcriber, published } = setup({ analyze: () => new Promise((resolve) => (finish = resolve)) });

    const running = transcriber.update(1, [thumb('a1')], capture);
    await vi.waitFor(() => expect(finish).toBeDefined());
    transcriber.clear(1);
    finish(pageText);
    await running;

    expect(transcriber.get(1)).toEqual([]);
    expect(published.at(-1)).toEqual([]);
  });

  it('新的擷取取代舊的：舊的分析結果不會蓋掉新的', async () => {
    const finishers: ((text: PageText) => void)[] = [];
    const { transcriber } = setup({ analyze: () => new Promise((resolve) => finishers.push(resolve)) });

    const first = transcriber.update(1, [thumb('a1')], capture);
    await vi.waitFor(() => expect(finishers.length).toBeGreaterThan(0));
    const second = transcriber.update(1, [thumb('a2')], capture);
    finishers[0]!(pageText);
    await first;

    expect(transcriber.get(1).map((p) => [p.anchorId, p.transcript.state])).toEqual([['a2', 'analyzing']]);
    await vi.waitFor(() => expect(finishers).toHaveLength(2));
    finishers[1]!(pageText);
    await second;
    expect(transcriber.get(1).map((p) => [p.anchorId, p.transcript.state])).toEqual([['a2', 'done']]);
  });
});

describe('翻譯此頁', () => {
  it('沒有 key 時擷取的 Page 設定 key 後按「翻譯此頁」：不重跑本機流水線，用同一份 OCR 結果翻譯', async () => {
    let translator: Translator | undefined;
    const calls: TranslateInput[] = [];
    const { transcriber, published, deps } = setup({ getTranslator: () => translator });
    await transcriber.update(1, [thumb('a1'), thumb('a2')], capture);
    expect(transcriber.get(1).every((p) => p.transcript.state === 'done' && !p.transcript.translated)).toBe(true);

    translator = translatorReturning('今天', calls);
    published.length = 0;
    await transcriber.translate(1);

    expect(deps.analyze).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
    // 先標翻譯中，再一頁一頁換成譯文
    expect(published[0]!.map((p) => p.transcript.state === 'done' && p.transcript.translating)).toEqual([true, true]);
    const pages = transcriber.get(1);
    for (const page of pages) {
      expect(page.transcript.state === 'done' && page.transcript.translated).toBe(true);
      expect(page.transcript.state === 'done' && page.transcript.translating).toBeFalsy();
    }
    const first = pages[0]!.transcript;
    if (first.state !== 'done') throw new Error('not done');
    expect(first.text.balloons[0]).toMatchObject({ 讀音: 'b1-讀音', 讀音來源: 'llm', 譯文: '今天-b1' });
  });

  it('重新翻譯失敗時退回 kuromoji 讀音（不是上一次的譯文），並顯示錯誤', async () => {
    let translator: Translator = translatorReturning('今天');
    const { transcriber } = setup({ getTranslator: () => translator });
    await transcriber.update(1, [thumb('a1')], capture);

    translator = { ...noNotes, translatePage: async () => Promise.reject(new Error('Claude API 500：boom')) };
    await transcriber.translate(1);

    expect(transcriber.get(1)[0]!.transcript).toEqual({ state: 'done', text: pageText, translated: false, translateError: 'Claude API 500：boom' });
  });

  it('額度用完（QuotaExhaustedError）不算翻譯失敗：顯示原文與 kuromoji 讀音，不帶錯誤', async () => {
    const translator: Translator = {
      ...noNotes,
      translatePage: async () => Promise.reject(new QuotaExhaustedError('Hosted Translation 402：免費額度已用完', 'freePagesExhausted')),
    };
    const { transcriber } = setup({ getTranslator: () => translator });

    await transcriber.update(1, [thumb('a1')], capture);

    expect(transcriber.get(1)[0]!.transcript).toEqual({ state: 'done', text: pageText, translated: false });
  });

  it('還沒設定 key 時按「翻譯此頁」不改變逐字稿', async () => {
    const { transcriber, published } = setup();
    await transcriber.update(1, [thumb('a1')], capture);
    const before = published.length;

    await transcriber.translate(1);

    expect(published).toHaveLength(before);
    expect(transcriber.get(1)[0]!.transcript).toEqual({ state: 'done', text: pageText, translated: false });
  });

  it('能翻譯了（同意、登入）：自動翻譯開著的 tab 直接翻還沒翻譯的頁，已翻好的不重翻', async () => {
    let translator: Translator | undefined;
    const calls: TranslateInput[] = [];
    const cache = memoryCache();
    // a1 已經翻好（快取），a2 沒有 Translator 時辨識完、未翻譯
    await setup({ cache, getTranslator: () => translatorReturning('舊') }).transcriber.update(1, [thumb('a1')], capture);
    const { transcriber } = setup({ cache, getTranslator: () => translator });
    await transcriber.update(1, [thumb('a1'), thumb('a2')], capture);

    translator = translatorReturning('今天', calls);
    await transcriber.translateUntranslated();

    expect(calls).toHaveLength(1);
    const [first, second] = transcriber.get(1).map((p) => p.transcript);
    expect(first!.state === 'done' && first!.translation?.source).toBe('cache');
    expect(second!.state === 'done' && second!.translated).toBe(true);
  });

  it('能翻譯了，但自動翻譯關著的 tab 不動（等讀者按「翻譯此頁」）；還是不能翻時也不動', async () => {
    let translator: Translator | undefined;
    const calls: TranslateInput[] = [];
    const { transcriber, deps } = setup({ getTranslator: () => translator });
    await transcriber.update(1, [thumb('a1')], capture);
    await transcriber.setAutoTranslate(2, false);
    await transcriber.update(2, [thumb('a2')], capture);

    await transcriber.translateUntranslated();
    translator = translatorReturning('今天', calls);
    await transcriber.translateUntranslated();

    expect(calls).toHaveLength(1);
    expect(deps.analyze).toHaveBeenCalledTimes(1);
    expect(transcriber.get(2)[0]!.transcript).toEqual({ state: 'pending' });
  });

  it('分析失敗的 Page 不送翻譯', async () => {
    const calls: TranslateInput[] = [];
    const { transcriber } = setup({ analyze: async () => Promise.reject(new Error('壞掉')), getTranslator: () => translatorReturning('x', calls) });
    await transcriber.update(1, [thumb('a1')], capture);

    await transcriber.translate(1);

    expect(calls).toEqual([]);
    expect(transcriber.get(1)[0]!.transcript.state).toBe('error');
  });

  it('翻譯中又有新的擷取時，舊的翻譯結果丟掉', async () => {
    let finish: (() => void) | undefined;
    const slow: Translator = {
      ...noNotes,
      translatePage: (input) =>
        new Promise((resolve) => {
          finish = () => void translatorReturning('舊').translatePage(input).then(resolve);
        }),
    };
    let translator: Translator | undefined;
    const { transcriber } = setup({ getTranslator: () => translator });
    await transcriber.update(1, [thumb('a1')], capture);

    translator = slow;
    const running = transcriber.translate(1);
    await vi.waitFor(() => expect(finish).toBeDefined());
    translator = undefined;
    await transcriber.update(1, [thumb('a2')], capture);
    finish!();
    await running;

    expect(transcriber.get(1).map((p) => [p.anchorId, p.transcript.state === 'done' && p.transcript.translated])).toEqual([['a2', false]]);
  });
});

describe('翻譯快取', () => {
  function countingTranslator() {
    const translator = { ...noNotes, translatePage: vi.fn(async () => translatedOutput()) } satisfies Translator;
    return translator;
  }

  it('翻譯完寫進快取：key 是這個 tab 的 Series ID 與 Page hash，只存文字與座標', async () => {
    const cache = memoryCache();
    const translator = countingTranslator();
    const { transcriber } = setup({ cache, getTranslator: () => translator });

    await transcriber.update(1, [thumb('a1', 'ab'.repeat(32))], capture);

    expect(cache.saved).toHaveLength(1);
    const saved = cache.saved[0]!;
    expect(saved).toMatchObject({
      seriesId: 'series-1',
      pageHash: 'ab'.repeat(32),
      model: 'claude-haiku-5-5',
      latencyMs: 2300,
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, costUsd: 0.0003 },
    });
    expect(saved.balloons[0]).toMatchObject({ id: 'b1', 原文: '今日は', 譯文: '今天', 讀音來源: 'llm' });
    expect(saved.looseText[0]).toMatchObject({ id: 'l1', 原文: 'ドン', 譯文: '咚' });
    expect(JSON.stringify(saved)).not.toContain('data:');
  });

  it('翻譯完的狀態是「已翻譯」，帶模型、秒數、費用', async () => {
    const { transcriber, published } = setup({ getTranslator: () => countingTranslator() });

    await transcriber.update(1, [thumb('a1')], capture);

    const last = published.at(-1)![0]!.transcript;
    expect(last.state === 'done' && last.translation).toEqual({
      source: 'translated',
      model: 'claude-haiku-5-5',
      latencyMs: 2300,
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, costUsd: 0.0003 },
    });
  });

  it('同一個 Series 已有這個 Page：直接用快取，不跑本機流水線也不呼叫 Translator，狀態是「快取」', async () => {
    const cache = memoryCache();
    const translator = countingTranslator();
    const first = setup({ cache, getTranslator: () => translator });
    await first.transcriber.update(1, [thumb('a1')], capture);

    // 重新整理後 anchor 換了，但 Page 一樣
    const second = setup({ cache, getTranslator: () => translator });
    await second.transcriber.update(1, [thumb('a7')], capture);

    expect(translator.translatePage).toHaveBeenCalledTimes(1);
    expect(second.deps.analyze).not.toHaveBeenCalled();
    const last = second.published.at(-1)![0]!;
    expect(last.anchorId).toBe('a7');
    expect(last.transcript.state === 'done' && last.transcript.translation?.source).toBe('cache');
    if (last.transcript.state !== 'done') return;
    expect(last.transcript.translated).toBe(true);
    expect(last.transcript.text.balloons[0]).toMatchObject({ 原文: '今日は', 譯文: '今天' });
    expect(last.transcript.translation).toMatchObject({ model: 'claude-haiku-5-5', latencyMs: 2300, usage: { costUsd: 0.0003 } });
  });

  it('別的 Series 的快取不算數', async () => {
    const cache = memoryCache();
    const translator = countingTranslator();
    await setup({ cache, getTranslator: () => translator, getSeriesId: async () => 'series-1' }).transcriber.update(1, [thumb('a1')], capture);

    await setup({ cache, getTranslator: () => translator, getSeriesId: async () => 'series-2' }).transcriber.update(1, [thumb('a1')], capture);

    expect(translator.translatePage).toHaveBeenCalledTimes(2);
  });

  it('擷取後才設定 key、按「翻譯此頁」成功時也寫進快取', async () => {
    const cache = memoryCache();
    let translator: Translator | undefined;
    const { transcriber } = setup({ cache, getTranslator: () => translator });
    await transcriber.update(1, [thumb('a1', 'cd'.repeat(32))], capture);
    expect(cache.saved).toEqual([]);

    translator = countingTranslator();
    await transcriber.translate(1);

    expect(cache.saved).toHaveLength(1);
    expect(cache.saved[0]).toMatchObject({ seriesId: 'series-1', pageHash: 'cd'.repeat(32) });
  });

  it('沒有 Translator（未翻譯）或翻譯失敗時不寫快取', async () => {
    const cache = memoryCache();
    await setup({ cache }).transcriber.update(1, [thumb('a1')], capture);
    const failing: Translator = { ...noNotes, translatePage: async () => Promise.reject(new Error('429')) };
    await setup({ cache, getTranslator: () => failing }).transcriber.update(1, [thumb('a2')], capture);

    expect(cache.saved).toEqual([]);
  });
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 本機流水線由測試一個一個放行；calls 依開始順序記 anchorId。 */
function gatedAnalyze() {
  const calls: string[] = [];
  const pending: (() => void)[] = [];
  const analyze = vi.fn(
    (request: AnalyzeRequest) =>
      new Promise<PageText>((resolve) => {
        calls.push(request.candidate.anchorId);
        pending.push(() => resolve(structuredClone(pageText)));
      }),
  );
  /** 放行最早開始、還沒放行的那一個，並等佇列往下走。 */
  async function finishNext() {
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    pending.shift()!();
    await flush();
  }
  return { analyze, calls, finishNext };
}

describe('翻譯佇列（#34）', () => {
  it('後進先出：本機段一次一個，新出現的可見 Page 先做', async () => {
    const gate = gatedAnalyze();
    const { transcriber } = setup({ analyze: gate.analyze });

    void transcriber.update(1, [thumb('a1')], capture);
    await vi.waitFor(() => expect(gate.calls).toEqual(['a1']));
    void transcriber.update(1, [thumb('a1'), thumb('a2')], capture);
    void transcriber.update(1, [thumb('a1'), thumb('a2'), thumb('a3')], capture);
    await flush();
    expect(gate.calls).toEqual(['a1']);

    await gate.finishNext();
    expect(gate.calls).toEqual(['a1', 'a3']);
    await gate.finishNext();
    expect(gate.calls).toEqual(['a1', 'a3', 'a2']);
  });

  it('翻太快：已不在畫面上、還沒開始的工作丟掉；之後再出現時重新排', async () => {
    const gate = gatedAnalyze();
    const { transcriber } = setup({ analyze: gate.analyze });

    void transcriber.update(1, [thumb('a1')], capture);
    await vi.waitFor(() => expect(gate.calls).toEqual(['a1']));
    void transcriber.update(1, [thumb('a2')], capture);
    void transcriber.update(1, [thumb('a3')], capture);
    await flush();
    await gate.finishNext();
    await gate.finishNext();
    expect(gate.calls).toEqual(['a1', 'a3']);

    void transcriber.update(1, [thumb('a2')], capture);
    await gate.finishNext();
    expect(gate.calls).toEqual(['a1', 'a3', 'a2']);
  });

  it('已排進佇列、還沒開始的工作，翻走之後也丟掉', async () => {
    const gate = gatedAnalyze();
    const { transcriber } = setup({ analyze: gate.analyze });

    void transcriber.update(1, [thumb('a1')], capture);
    await vi.waitFor(() => expect(gate.calls).toEqual(['a1']));
    // 每翻一頁都等它排進佇列（查完快取），才翻下一頁
    void transcriber.update(1, [thumb('a2')], capture);
    await flush();
    void transcriber.update(1, [thumb('a3')], capture);
    await flush();
    await gate.finishNext();
    await gate.finishNext();
    await flush();

    expect(gate.calls).toEqual(['a1', 'a3']);
  });

  it('已開始的工作翻走後照樣做完、寫進快取，但不顯示也不覆蓋', async () => {
    const gate = gatedAnalyze();
    const cache = memoryCache();
    const { transcriber, published } = setup({ analyze: gate.analyze, cache, getTranslator: () => translatorReturning('今天') });

    void transcriber.update(1, [thumb('a1')], capture);
    await vi.waitFor(() => expect(gate.calls).toEqual(['a1']));
    void transcriber.update(1, [thumb('a2')], capture);
    await flush();
    published.length = 0;
    await gate.finishNext();
    await flush();

    expect(cache.saved.map((t) => t.pageHash)).toEqual([HASHES.a1]);
    expect(published.flat().some((p) => p.anchorId === 'a1')).toBe(false);
    expect(transcriber.get(1).map((p) => p.anchorId)).toEqual(['a2']);
  });

  it('同一個 Page（hash 在門檻內）已有工作在跑：不重複排，等那份結果', async () => {
    const gate = gatedAnalyze();
    const { transcriber } = setup({ analyze: gate.analyze });
    // 跟 a1 差 1 bit：同一頁重新截圖
    const nearlyA1 = '1' + '0'.repeat(63);

    const first = transcriber.update(1, [thumb('a1')], capture);
    await vi.waitFor(() => expect(gate.calls).toEqual(['a1']));
    const second = transcriber.update(1, [thumb('a9', nearlyA1)], capture);
    await gate.finishNext();
    await Promise.all([first, second]);

    expect(gate.analyze).toHaveBeenCalledTimes(1);
    expect(transcriber.get(1).map((p) => [p.anchorId, p.transcript.state])).toEqual([['a9', 'done']]);
  });

  it('翻走再翻回來：命中快取（狀態是「快取」），不再翻譯', async () => {
    const translator = { ...noNotes, translatePage: vi.fn(async () => translatedOutput()) } satisfies Translator;
    const { transcriber } = setup({ getTranslator: () => translator });
    await transcriber.update(1, [thumb('a1')], capture);
    await transcriber.update(1, [thumb('a2')], capture);

    await transcriber.update(1, [thumb('a1')], capture);

    expect(translator.translatePage).toHaveBeenCalledTimes(2);
    const t = transcriber.get(1)[0]!.transcript;
    expect(t.state === 'done' && t.translation?.source).toBe('cache');
  });

  it('本機流水線失敗的 Page 下次擷取時重跑（例如修好模型後按重試）', async () => {
    let fail = true;
    const { transcriber } = setup({ analyze: async () => (fail ? Promise.reject(new Error('模型檔 SHA-256 不符')) : structuredClone(pageText)) });
    await transcriber.update(1, [thumb('a1')], capture);
    expect(transcriber.get(1)[0]!.transcript.state).toBe('error');

    fail = false;
    await transcriber.update(1, [thumb('a1')], capture);

    expect(transcriber.get(1)[0]!.transcript.state).toBe('done');
  });

  it('Series 換了 ID（reassignSeries，#36 合併）：之後重新翻譯寫進新的 ID', async () => {
    const translator = { ...noNotes, translatePage: vi.fn(async () => translatedOutput()) } satisfies Translator;
    const cache = memoryCache();
    const { transcriber } = setup({ getTranslator: () => translator, cache });
    await transcriber.update(1, [thumb('a1')], capture);
    expect(cache.saved.map((t) => t.seriesId)).toEqual(['series-1']);

    transcriber.reassignSeries(1, 'series-2');
    await transcriber.translate(1);

    expect(cache.saved.map((t) => t.seriesId)).toEqual(['series-1', 'series-2']);
  });

  it('同 origin 重新整理（resetPages）：同一頁重新從快取拿，自動翻譯設定保留', async () => {
    const translator = { ...noNotes, translatePage: vi.fn(async () => translatedOutput()) } satisfies Translator;
    const { transcriber, published } = setup({ getTranslator: () => translator });
    await transcriber.update(1, [thumb('a1')], capture);
    await transcriber.setAutoTranslate(1, false);

    transcriber.resetPages(1);
    expect(published.at(-1)).toEqual([]);
    await transcriber.update(1, [thumb('a5', HASHES.a1)], capture);

    const t = transcriber.get(1)[0]!.transcript;
    expect(t.state === 'done' && t.translation?.source).toBe('cache');
    expect(transcriber.isAutoTranslate(1)).toBe(false);
  });

  // 同一批的頁依閱讀順序一頁一頁送 ①（Prior Pages），併發要用不同 tab 的頁來看（佇列跨 tab 共用）
  it('LLM 段併發 2；等 LLM 時本機段繼續做下一頁', async () => {
    const llmCalls: (() => void)[] = [];
    const translator: Translator = {
      ...noNotes,
      translatePage: (input) =>
        new Promise((resolve) => llmCalls.push(() => void translatorReturning('x').translatePage(input).then(resolve))),
    };
    const { transcriber, deps } = setup({ getTranslator: () => translator });

    const running = Promise.all([1, 2, 3].map((tabId) => transcriber.update(tabId, [thumb(`a${tabId}`)], capture)));
    await vi.waitFor(() => expect(deps.analyze).toHaveBeenCalledTimes(3));
    await flush();
    expect(llmCalls).toHaveLength(2);

    llmCalls[0]!();
    await vi.waitFor(() => expect(llmCalls).toHaveLength(3));
    llmCalls[1]!();
    llmCalls[2]!();
    await running;
    expect([1, 2, 3].every((tabId) => transcriber.get(tabId).every((p) => p.transcript.state === 'done' && p.transcript.translated))).toBe(true);
  });

  it('LLM 段同時最多 2 個，本機段同時最多 1 個', async () => {
    let localInFlight = 0;
    let localMax = 0;
    const analyze = async () => {
      localMax = Math.max(localMax, ++localInFlight);
      await flush();
      localInFlight--;
      return structuredClone(pageText);
    };
    let llmInFlight = 0;
    let llmMax = 0;
    const translator: Translator = {
      ...noNotes,
      async translatePage(input) {
        llmMax = Math.max(llmMax, ++llmInFlight);
        await flush();
        await flush();
        llmInFlight--;
        return translatorReturning('x').translatePage(input);
      },
    };
    const { transcriber } = setup({ analyze, getTranslator: () => translator });

    const tabIds = [1, 2, 3, 4, 5];
    await Promise.all(tabIds.map((tabId) => transcriber.update(tabId, [thumb(`a${tabId}`)], capture)));

    expect(localMax).toBe(1);
    expect(llmMax).toBe(2);
    expect(tabIds.every((tabId) => transcriber.get(tabId).every((p) => p.transcript.state === 'done' && p.transcript.translated))).toBe(true);
  });

  it('429：依 retry-after 等待後重試，最多 3 次；等待期間這頁仍是「辨識中」，之後顯示錯誤', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '7' },
          }),
      );
      const translator = createClaudeTranslator({
        apiKey: 'sk-ant-test',
        fetch,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
      });
      const { transcriber } = setup({ getTranslator: () => translator });

      const running = transcriber.update(1, [thumb('a1')], capture);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(6999);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(transcriber.get(1)[0]!.transcript.state).toBe('analyzing');
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(14_000);
      await running;
      expect(fetch).toHaveBeenCalledTimes(4);
      const t = transcriber.get(1)[0]!.transcript;
      expect(t.state === 'done' && t.translateError).toBe('Claude API 429：slow down');

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('429 重試後仍失敗：顯示錯誤；按「重試」只重送 LLM、不重跑本機流水線', async () => {
    let translator: Translator = { ...noNotes, translatePage: async () => Promise.reject(new Error('Claude API 429：rate limited')) };
    const { transcriber, deps } = setup({ getTranslator: () => translator });
    await transcriber.update(1, [thumb('a1')], capture);
    const failed = transcriber.get(1)[0]!.transcript;
    expect(failed.state === 'done' && failed.translateError).toBe('Claude API 429：rate limited');

    translator = translatorReturning('今天');
    await transcriber.translate(1);

    expect(deps.analyze).toHaveBeenCalledTimes(1);
    const retried = transcriber.get(1)[0]!.transcript;
    expect(retried.state === 'done' && retried.translated && !retried.translateError).toBe(true);
  });
});

describe('自動翻譯開關', () => {
  it('預設開；關掉後新 Page 停在「未翻譯」，不跑本機流水線；按「翻譯此頁」才翻', async () => {
    const calls: TranslateInput[] = [];
    const { transcriber, deps } = setup({ getTranslator: () => translatorReturning('今天', calls) });
    expect(transcriber.isAutoTranslate(1)).toBe(true);

    await transcriber.setAutoTranslate(1, false);
    await transcriber.update(1, [thumb('a1')], capture);

    expect(deps.analyze).not.toHaveBeenCalled();
    expect(transcriber.get(1)[0]!.transcript).toEqual({ state: 'pending' });

    await transcriber.translate(1);
    expect(deps.analyze).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    const t = transcriber.get(1)[0]!.transcript;
    expect(t.state === 'done' && t.translated).toBe(true);
  });

  it('關著時快取命中照樣直接顯示', async () => {
    const cache = memoryCache();
    await setup({ cache, getTranslator: () => translatorReturning('今天') }).transcriber.update(1, [thumb('a1')], capture);
    const { transcriber } = setup({ cache, getTranslator: () => translatorReturning('今天') });

    await transcriber.setAutoTranslate(1, false);
    await transcriber.update(1, [thumb('a1')], capture);

    const t = transcriber.get(1)[0]!.transcript;
    expect(t.state === 'done' && t.translation?.source).toBe('cache');
  });

  it('停止後回到預設（開）', async () => {
    const { transcriber } = setup();
    await transcriber.setAutoTranslate(1, false);

    transcriber.clear(1);

    expect(transcriber.isAutoTranslate(1)).toBe(true);
  });
});

const note = (原文: string, 譯文: string, more: Partial<NotesEntry> = {}): NotesEntry => ({
  seriesId: 'series-1',
  原文,
  讀音: '',
  譯文,
  類別: '用語',
  locked: false,
  ...more,
});

/**
 * ① 回傳「譯-id」；② 每次呼叫依序回傳 changes 裡的一份 notes_changes。
 * inputs 記下每次 ① 送出的內容，notesInputs 記下每次 ② 送出的內容。
 */
function translatorWithNotes(changes: NotesChanges[], inputs: TranslateInput[] = [], notesInputs: NotesInput[] = []): Translator {
  let call = 0;
  return {
    translatePage: (input) => translatorReturning('譯', inputs).translatePage(input),
    async proposeNotes(input) {
      notesInputs.push(structuredClone(input));
      return { ...(await noNotes.proposeNotes(input)), notes_changes: changes[call++] ?? noChanges() };
    },
  };
}

/** ② 由測試一個一個回覆；sent 依 ② 送出順序。 */
function gatedNotes(sent: { input: NotesInput; reply(changes: NotesChanges): void; fail(): void }[]): Translator {
  return {
    translatePage: (input) => translatorReturning('譯').translatePage(input),
    proposeNotes: (input) =>
      new Promise((resolve, reject) =>
        sent.push({
          input,
          reply: (changes) => void noNotes.proposeNotes(input).then((output) => resolve({ ...output, notes_changes: changes })),
          fail: () => reject(new Error('Claude API 500')),
        }),
      ),
  };
}

const adds = (原文: string, 譯文: string, 讀音 = ''): NotesChanges => ({ ...noChanges(), added: [{ 原文, 讀音, 譯文, 類別: '用語' }] });

describe('Series Notes 累積（#37、ADR 0005）', () => {
  it('第 1 頁背景整理 Notes（②）新增的條目存進 Notes，第 2 頁翻譯時就帶著它', async () => {
    const inputs: TranslateInput[] = [];
    const notes = memoryNotes();
    const translator = translatorWithNotes([adds('今日', '今天', 'きょう')], inputs);
    const { transcriber } = setup({ getTranslator: () => translator, notes });

    await transcriber.update(1, [thumb('a1')], capture);
    await transcriber.notesSettled();
    await transcriber.update(1, [thumb('a2')], capture);

    expect(inputs.map((i) => i.seriesNotes)).toEqual([[], [note('今日', '今天', { 讀音: 'きょう' })]]);
    expect(notes.entries).toEqual([note('今日', '今天', { 讀音: 'きょう' })]);
  });

  it('② 送這頁的原文與 ① 的譯文（依閱讀順序，跳過 unreadable），帶送出時的 Notes', async () => {
    const notesInputs: NotesInput[] = [];
    const translator = translatorWithNotes([], [], notesInputs);
    const unreadableLoose: Translator = {
      ...translator,
      async translatePage(input) {
        const output = await translator.translatePage(input);
        return { ...output, items: output.items.map((i) => (i.id === 'l1' ? { ...i, 讀音: '', 譯文: '', unreadable: true } : i)) };
      },
    };
    const { transcriber } = setup({ getTranslator: () => unreadableLoose, notes: memoryNotes([note('明日', '明天')]) });

    await transcriber.update(1, [thumb('a1')], capture);
    await transcriber.notesSettled();

    expect(notesInputs).toEqual([{ seriesNotes: [note('明日', '明天')], items: [{ kind: 'balloon', 原文: '今日は', 譯文: '譯-b1' }] }]);
  });

  it('① 帶回用量紀錄 id（Hosted Translation）時，② 把它帶回去，Notes 的用量歸到這一頁', async () => {
    const notesInputs: NotesInput[] = [];
    const translator = translatorWithNotes([], [], notesInputs);
    const hosted: Translator = { ...translator, translatePage: async (input) => ({ ...(await translator.translatePage(input)), usageRecordId: 42 }) };
    const { transcriber } = setup({ getTranslator: () => hosted, notes: memoryNotes() });

    await transcriber.update(1, [thumb('a1')], capture);
    await transcriber.notesSettled();

    expect(notesInputs.map((i) => i.pageUsageRecordId)).toEqual([42]);
  });

  it('① 回來就顯示、寫快取，不等 ②', async () => {
    const cache = memoryCache();
    const sent: Parameters<typeof gatedNotes>[0] = [];
    const { transcriber, published } = setup({ getTranslator: () => gatedNotes(sent), cache });

    await transcriber.update(1, [thumb('a1')], capture);

    expect(sent).toHaveLength(1); // ② 還沒回來
    expect(published.at(-1)![0]!.transcript).toMatchObject({ state: 'done', translated: true, translation: { source: 'translated' } });
    expect(cache.saved).toHaveLength(1);
  });

  it('依 ② 送出的順序套用：後送出的先回來也要等，同一個原文先送出的那頁先贏', async () => {
    const notes = memoryNotes();
    const sent: Parameters<typeof gatedNotes>[0] = [];
    const { transcriber } = setup({ getTranslator: () => gatedNotes(sent), notes });

    await transcriber.update(1, [thumb('a1'), thumb('a2')], capture);
    expect(sent).toHaveLength(2);
    sent[1]!.reply(adds('今日', '今兒'));
    await flush();
    expect(notes.entries).toEqual([]);

    sent[0]!.reply(adds('今日', '今天'));
    await transcriber.notesSettled();
    expect(notes.entries).toEqual([note('今日', '今天')]);
    expect(notes.suggestions).toEqual([{ seriesId: 'series-1', 原文: '今日', 建議譯文: '今兒', 來源: { pageHash: HASHES.a2 } }]);
  });

  it('② 失敗：跳過、不重試，譯文照常；不擋住後面的', async () => {
    const notes = memoryNotes();
    const sent: Parameters<typeof gatedNotes>[0] = [];
    const { transcriber, published } = setup({ getTranslator: () => gatedNotes(sent), notes });

    await transcriber.update(1, [thumb('a1'), thumb('a2')], capture);
    sent[1]!.reply(adds('今日', '今天'));
    sent[0]!.fail();
    await transcriber.notesSettled();

    expect(sent).toHaveLength(2);
    expect(notes.entries).toEqual([note('今日', '今天')]);
    expect(published.at(-1)!.map((p) => p.transcript.state === 'done' && p.transcript.translated)).toEqual([true, true]);
  });

  it('① 失敗就不送 ②', async () => {
    const translator: Translator = { ...noNotes, proposeNotes: vi.fn(noNotes.proposeNotes), translatePage: async () => Promise.reject(new Error('Claude API 500')) };
    const { transcriber } = setup({ getTranslator: () => translator });

    await transcriber.update(1, [thumb('a1')], capture);
    await transcriber.notesSettled();

    expect(translator.proposeNotes).not.toHaveBeenCalled();
  });

  it('快取記錄 ① 送出時 Notes 裡、這頁原文出現的條目（usedNotes），這頁 ② 才新增的不算', async () => {
    const cache = memoryCache();
    const notes = memoryNotes([note('ドン', '咚', { 類別: '狀聲詞' }), note('明日', '明天')]);
    const translator = translatorWithNotes([adds('今日', '今天', 'きょう')]);
    const { transcriber } = setup({ getTranslator: () => translator, notes, cache });

    await transcriber.update(1, [thumb('a1')], capture);
    await transcriber.notesSettled();

    expect(cache.saved[0]!.usedNotes).toEqual([{ 原文: 'ドン', 譯文: '咚' }]);
    expect(notes.entries).toContainEqual(note('今日', '今天', { 讀音: 'きょう' }));
  });
});

describe('Prior Pages（ADR 0005）', () => {
  /** 原文標上是哪個 anchor，看 Prior Pages 帶了哪幾頁。 */
  const analyzeByAnchor = async (request: AnalyzeRequest): Promise<PageText> => {
    const text = structuredClone(pageText);
    text.balloons[0]!.原文 = request.candidate.anchorId;
    return text;
  };
  /** 每次 ① 送出時帶的 Prior Pages，只看每頁第一句的原文。 */
  const priorOf = (inputs: TranslateInput[]) => inputs.map((i) => i.priorPages.map((p) => p[0]!.原文));

  it('帶這一批之前最近看過的 2 頁，依看過的順序；每句只有 kind、原文、譯文', async () => {
    const inputs: TranslateInput[] = [];
    const { transcriber } = setup({ analyze: analyzeByAnchor, getTranslator: () => translatorWithNotes([], inputs) });

    for (const anchor of ['a1', 'a2', 'a3', 'a4']) await transcriber.update(1, [thumb(anchor)], capture);

    expect(priorOf(inputs)).toEqual([[], ['a1'], ['a1', 'a2'], ['a2', 'a3']]);
    expect(inputs[1]!.priorPages).toEqual([
      [
        { kind: 'balloon', 原文: 'a1', 譯文: '譯-b1' },
        { kind: 'loose', 原文: 'ドン', 譯文: '譯-l1' },
      ],
    ]);
  });

  it('依讀者看過的順序：往回翻時，前頁是剛剛看的那頁', async () => {
    const inputs: TranslateInput[] = [];
    const cache = memoryCache();
    const { transcriber } = setup({ cache, analyze: analyzeByAnchor, getTranslator: () => translatorWithNotes([], inputs) });

    for (const anchor of ['a3', 'a2']) await transcriber.update(1, [thumb(anchor)], capture);
    await transcriber.update(1, [thumb('a1')], capture);

    expect(priorOf(inputs)).toEqual([[], ['a3'], ['a3', 'a2']]);
  });

  it('同一批裡閱讀順序在前的頁也算：Spread 的左頁帶同一個 Spread 的右頁＋上一個 Spread 的左頁', async () => {
    const inputs: TranslateInput[] = [];
    const { transcriber } = setup({ analyze: analyzeByAnchor, getTranslator: () => translatorWithNotes([], inputs) });

    await transcriber.update(1, [thumb('a1'), thumb('a2')], capture);
    await transcriber.update(1, [thumb('a3'), thumb('a4')], capture);

    expect(priorOf(inputs)).toEqual([[], ['a1'], ['a1', 'a2'], ['a2', 'a3']]);
  });

  it('同一批裡在後的頁等前頁的 ① 回來才送出', async () => {
    const inputs: TranslateInput[] = [];
    let releaseFirst!: () => void;
    const firstReturns = new Promise<void>((resolve) => (releaseFirst = resolve));
    const translator = translatorWithNotes([], inputs);
    const { transcriber, published } = setup({
      analyze: analyzeByAnchor,
      getTranslator: () => ({
        ...translator,
        async translatePage(input) {
          const output = await translator.translatePage(input);
          if (input.items[0]!.原文 === 'a1') await firstReturns;
          return output;
        },
      }),
    });

    const running = transcriber.update(1, [thumb('a1'), thumb('a2')], capture);
    await vi.waitFor(() => expect(inputs).toHaveLength(1));
    await flush();
    await flush();
    expect(inputs).toHaveLength(1);

    releaseFirst();
    await running;
    expect(priorOf(inputs)).toEqual([[], ['a1']]);
    expect(published.at(-1)!.map((p) => p.transcript)).toMatchObject([
      { state: 'done', translated: true },
      { state: 'done', translated: true },
    ]);
  });

  it('只等同一次擷取裡在前的頁：前一次擷取還在翻的頁不等（spec D2「前一批的頁維持現狀」）', async () => {
    const inputs: TranslateInput[] = [];
    let releaseFirst!: () => void;
    const firstReturns = new Promise<void>((resolve) => (releaseFirst = resolve));
    const translator = translatorWithNotes([], inputs);
    const { transcriber } = setup({
      analyze: analyzeByAnchor,
      getTranslator: () => ({
        ...translator,
        async translatePage(input) {
          const output = await translator.translatePage(input);
          if (input.items[0]!.原文 === 'a1') await firstReturns;
          return output;
        },
      }),
    });

    const first = transcriber.update(1, [thumb('a1')], capture);
    await vi.waitFor(() => expect(inputs).toHaveLength(1));
    // 捲動後 a1 還在畫面上、a2 露出來：a1 是前一次擷取的工作，a2 不等它
    const second = transcriber.update(1, [thumb('a1'), thumb('a2')], capture);
    await vi.waitFor(() => expect(inputs).toHaveLength(2));
    expect(transcriber.get(1)[1]!.transcript).toMatchObject({ state: 'done', translated: true });

    releaseFirst();
    await Promise.all([first, second]);
  });

  it('前頁翻譯失敗：後頁照樣送出，不帶它', async () => {
    const inputs: TranslateInput[] = [];
    const translator = translatorWithNotes([], inputs);
    const { transcriber } = setup({
      analyze: analyzeByAnchor,
      getTranslator: () => ({
        ...translator,
        async translatePage(input) {
          if (input.items[0]!.原文 === 'a1') throw new Error('Claude API 500');
          return translator.translatePage(input);
        },
      }),
    });

    await transcriber.update(1, [thumb('a1'), thumb('a2')], capture);

    expect(priorOf(inputs)).toEqual([[]]);
    expect(transcriber.get(1)[1]!.transcript).toMatchObject({ state: 'done', translated: true });
  });

  it('前頁還沒開始就被丟掉（讀者翻走它）：還在畫面上的後頁照樣送出', async () => {
    const inputs: TranslateInput[] = [];
    const gate = gatedAnalyze();
    const { transcriber } = setup({ analyze: gate.analyze, getTranslator: () => translatorWithNotes([], inputs) });

    void transcriber.update(1, [thumb('a3')], capture);
    await vi.waitFor(() => expect(gate.calls).toEqual(['a3']));
    const spread = transcriber.update(1, [thumb('a1'), thumb('a2')], capture);
    await flush();
    // a1、a2 都還在本機段排隊；a1 捲出畫面被丟掉，a2 還在
    const turned = transcriber.update(1, [thumb('a2')], capture);
    await flush();
    await gate.finishNext();
    await gate.finishNext();
    await Promise.all([spread, turned]);

    expect(gate.calls).toEqual(['a3', 'a2']);
    // a2 帶 a3（a1 沒翻）
    expect(inputs.map((i) => i.priorPages.length)).toEqual([0, 1]);
    expect(transcriber.get(1)[0]!.transcript).toMatchObject({ state: 'done', translated: true });
  });

  it('命中快取的頁也算看過', async () => {
    const inputs: TranslateInput[] = [];
    const cache = memoryCache();
    const first = setup({ cache, analyze: analyzeByAnchor, getTranslator: () => translatorWithNotes([]) });
    await first.transcriber.update(1, [thumb('a1')], capture);

    const { transcriber } = setup({ cache, analyze: analyzeByAnchor, getTranslator: () => translatorWithNotes([], inputs) });
    await transcriber.update(1, [thumb('a1')], capture);
    await transcriber.update(1, [thumb('a2')], capture);

    expect(priorOf(inputs)).toEqual([['a1']]);
  });

  it('前頁還沒翻完就不等，只帶已經翻好的', async () => {
    const inputs: TranslateInput[] = [];
    let releaseFirst!: () => void;
    const firstReturns = new Promise<void>((resolve) => (releaseFirst = resolve));
    const translator = translatorWithNotes([], inputs);
    const { transcriber } = setup({
      analyze: analyzeByAnchor,
      getTranslator: () => ({
        ...translator,
        async translatePage(input) {
          const output = await translator.translatePage(input);
          if (input.items[0]!.原文 === 'a1') await firstReturns;
          return output;
        },
      }),
    });

    const firstRunning = transcriber.update(1, [thumb('a1')], capture);
    await vi.waitFor(() => expect(inputs).toHaveLength(1));
    // 翻走：a1 已開始，照樣做完
    await transcriber.update(1, [thumb('a2')], capture);
    releaseFirst();
    await firstRunning;
    await transcriber.update(1, [thumb('a3')], capture);

    expect(priorOf(inputs)).toEqual([[], [], ['a1', 'a2']]);
  });

  it('跳過 unreadable 的句子；整頁都 unreadable 的頁送空的', async () => {
    const inputs: TranslateInput[] = [];
    const translator = translatorWithNotes([], inputs);
    const { transcriber } = setup({
      analyze: analyzeByAnchor,
      getTranslator: () => ({
        ...translator,
        async translatePage(input) {
          const output = await translator.translatePage(input);
          return { ...output, items: output.items.map((i) => (i.id === 'l1' ? { ...i, 讀音: '', 譯文: '', unreadable: true } : i)) };
        },
      }),
    });

    await transcriber.update(1, [thumb('a1')], capture);
    await transcriber.update(1, [thumb('a2')], capture);

    expect(inputs[1]!.priorPages).toEqual([[{ kind: 'balloon', 原文: 'a1', 譯文: '譯-b1' }]]);
  });

  it('Series 換了就清空；同一部 Series 同 origin 重新整理（換話）保留；停止就忘掉', async () => {
    const inputs: TranslateInput[] = [];
    let seriesId = 'series-1';
    const { transcriber } = setup({ analyze: analyzeByAnchor, getSeriesId: async () => seriesId, getTranslator: () => translatorWithNotes([], inputs) });

    await transcriber.update(1, [thumb('a1')], capture);
    transcriber.resetPages(1);
    await transcriber.update(1, [thumb('a2')], capture);
    seriesId = 'series-2';
    await transcriber.update(1, [thumb('a3')], capture);
    transcriber.clear(1);
    await transcriber.update(1, [thumb('a4')], capture);

    expect(priorOf(inputs)).toEqual([[], ['a1'], [], []]);
  });

  it('沒有 Series 時不帶（分不出前頁是不是同一部作品）', async () => {
    const inputs: TranslateInput[] = [];
    const { transcriber } = setup({ analyze: analyzeByAnchor, getSeriesId: async () => undefined, getTranslator: () => translatorWithNotes([], inputs) });

    await transcriber.update(1, [thumb('a1')], capture);
    await transcriber.update(1, [thumb('a2')], capture);

    expect(priorOf(inputs)).toEqual([[], []]);
  });

  it('每個 tab 各自記', async () => {
    const inputs: TranslateInput[] = [];
    const { transcriber } = setup({ analyze: analyzeByAnchor, getTranslator: () => translatorWithNotes([], inputs) });

    await transcriber.update(1, [thumb('a1')], capture);
    await transcriber.update(2, [thumb('a2')], capture);

    expect(priorOf(inputs)).toEqual([[], []]);
  });

  it('重新翻譯：同樣帶這頁之前最近看過的頁，含同一批裡在前的頁', async () => {
    const inputs: TranslateInput[] = [];
    const { transcriber } = setup({ analyze: analyzeByAnchor, getTranslator: () => translatorWithNotes([], inputs) });
    await transcriber.update(1, [thumb('a1')], capture);
    await transcriber.update(1, [thumb('a2'), thumb('a3')], capture);

    await transcriber.translate(1, HASHES.a3);

    expect(priorOf(inputs).at(-1)).toEqual(['a1', 'a2']);
  });
});

describe('Spread（#35）', () => {
  const RIGHT = { x: 0.5, y: 0, w: 0.5, h: 1 };
  const LEFT = { x: 0, y: 0, w: 0.5, h: 1 };
  /** 同一個 anchor 切出來的兩個 Page，依閱讀順序先右後左。 */
  const spread = (): PageThumb[] => [
    { ...thumb('a1', HASHES.a1), subRect: RIGHT },
    { ...thumb('a1', HASHES.a2), subRect: LEFT },
  ];

  it('兩個 Page 各自帶 subRect 給本機流水線（同一個 anchor）', async () => {
    const { transcriber, deps } = setup();

    await transcriber.update(1, spread(), capture);

    expect(vi.mocked(deps.analyze).mock.calls.map(([request]) => [request.candidate.anchorId, request.subRect])).toEqual([
      ['a1', RIGHT],
      ['a1', LEFT],
    ]);
  });

  it('本機段忙著時翻到 Spread：兩頁依閱讀順序排，右頁先做', async () => {
    const gate = gatedAnalyze();
    const { transcriber } = setup({ analyze: gate.analyze });

    void transcriber.update(1, [thumb('a3')], capture);
    await vi.waitFor(() => expect(gate.calls).toEqual(['a3']));
    void transcriber.update(1, spread(), capture);
    await flush();
    await gate.finishNext();
    await gate.finishNext();

    expect(gate.analyze.mock.calls.slice(1).map(([request]) => request.subRect)).toEqual([RIGHT, LEFT]);
  });

  it('右頁先送出 LLM，即使左頁的快取查詢先回來', async () => {
    const calls: TranslateInput[] = [];
    const cache = memoryCache();
    let releaseRight!: () => void;
    const rightLookup = new Promise<void>((resolve) => (releaseRight = resolve));
    const { transcriber } = setup({
      cache: {
        ...cache,
        async find(seriesId, pageHash) {
          if (pageHash === HASHES.a1) await rightLookup;
          return cache.find(seriesId, pageHash);
        },
      },
      // 原文標上是哪一頁，看送出 LLM 的順序
      analyze: async (request) => {
        const text = structuredClone(pageText);
        text.balloons[0]!.原文 = request.subRect === RIGHT ? '右' : '左';
        return text;
      },
      getTranslator: () => translatorReturning('譯', calls),
    });

    const running = transcriber.update(1, spread(), capture);
    await flush();
    releaseRight();
    await running;

    expect(calls.map((input) => input.items[0]!.原文)).toEqual(['右', '左']);
  });

  it('兩頁的 ② 拿到同一份 Notes 快照：右頁的變更在左頁送出前就套用了，左頁仍送右頁送出時的 Notes；左頁看不到的新增不變成建議', async () => {
    const notesInputs: NotesInput[] = [];
    const notes = memoryNotes([note('明日', '明天')]);
    let releaseLeft!: () => void;
    const leftAnalyzed = new Promise<void>((resolve) => (releaseLeft = resolve));
    const translator = translatorWithNotes([adds('今日', '今天'), adds('今日', '今兒', 'きょう')], [], notesInputs);
    const { transcriber } = setup({
      notes,
      getTranslator: () => translator,
      analyze: async (request) => {
        if (request.subRect === LEFT) await leftAnalyzed;
        return structuredClone(pageText);
      },
    });

    const running = transcriber.update(1, spread(), capture);
    await vi.waitFor(() => expect(notes.entries).toHaveLength(2));
    releaseLeft();
    await running;
    await transcriber.notesSettled();

    expect(notesInputs.map((i) => i.seriesNotes)).toEqual([[note('明日', '明天')], [note('明日', '明天')]]);
    // 套用仍依送出順序：右頁先贏。左頁的快照裡沒有右頁剛新增的條目，給不同譯名不算想改它：丟掉，空欄位照補
    expect(notes.entries).toEqual([note('明日', '明天'), note('今日', '今天', { 讀音: 'きょう' })]);
    expect(notes.suggestions).toEqual([]);
  });

  it('不同 anchor 的兩頁不共用快照：後送出的帶著前一頁套用後的 Notes', async () => {
    const inputs: TranslateInput[] = [];
    const notesInputs: NotesInput[] = [];
    const notes = memoryNotes();
    let releaseSecond!: () => void;
    const secondAnalyzed = new Promise<void>((resolve) => (releaseSecond = resolve));
    const translator = translatorWithNotes([adds('今日', '今天')], inputs, notesInputs);
    const { transcriber } = setup({
      notes,
      getTranslator: () => translator,
      analyze: async (request) => {
        if (request.candidate.anchorId === 'a2') await secondAnalyzed;
        return structuredClone(pageText);
      },
    });

    const running = transcriber.update(1, [thumb('a1'), thumb('a2')], capture);
    await vi.waitFor(() => expect(notes.entries).toHaveLength(1));
    releaseSecond();
    await running;
    await transcriber.notesSettled();

    expect(inputs.map((i) => i.seriesNotes)).toEqual([[], [note('今日', '今天')]]);
    expect(notesInputs.map((i) => i.seriesNotes)).toEqual([[], [note('今日', '今天')]]);
  });
});

describe('過時提示（#38）', () => {
  /** 用 Notes 裡「今日＝今天」翻好的快取。 */
  const cachedPage = (pageHash: string, more: Partial<PageTranslation> = {}): PageTranslation => ({
    ...structuredClone(pageText),
    seriesId: 'series-1',
    pageHash,
    usedNotes: [{ 原文: '今日', 譯文: '今天' }],
    model: 'claude-haiku-5-5',
    promptVersion: 'v2',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: 0 },
    latencyMs: 1,
    translatedAt: 0,
    ...more,
  });
  const staleOf = (pages: PageView[]) => pages.map((p) => (p.transcript.state === 'done' ? p.transcript.stale : p.transcript.state));

  it('快取命中時，這頁用到的條目譯文被改了：標成過時；只新增條目不算', async () => {
    const cache = memoryCache();
    cache.saved.push(cachedPage(HASHES.a1!), cachedPage(HASHES.a2!));
    const notes = memoryNotes([note('今日', '今兒', { locked: true }), note('明日', '明天')]);
    const { transcriber, published } = setup({ cache, notes });
    await transcriber.update(1, [thumb('a1')], capture);
    expect(staleOf(published.at(-1)!)).toEqual(['notes']);

    notes.entries = [note('今日', '今天'), note('明日', '明天'), note('ドン', '咚')];
    await transcriber.update(1, [thumb('a2')], capture);
    expect(staleOf(published.at(-1)!)).toEqual([undefined]);
  });

  it('模型或 prompt 版本跟目前的不同也標成過時；翻譯時寫進快取的是目前的 prompt 版本', async () => {
    const cache = memoryCache();
    cache.saved.push(cachedPage(HASHES.a1!, { promptVersion: 'v1' }));
    const version = { model: 'claude-haiku-5-5', promptVersion: 'v2' };
    const { transcriber, published } = setup({
      cache,
      notes: memoryNotes([note('今日', '今天')]),
      getTranslator: () => translatorReturning('譯'),
      translatorVersion: () => version,
    });

    await transcriber.update(1, [thumb('a1'), thumb('a2')], capture);

    expect(staleOf(published.at(-1)!)).toEqual(['version', undefined]);
    expect(cache.saved.find((t) => t.pageHash === HASHES.a2)?.promptVersion).toBe('v2');
  });

  it('API 回報的模型 ID 跟送出時的不同（例如帶日期）：快取記的是送出時的版本，之後命中不算過時', async () => {
    const cache = memoryCache();
    const version = { model: 'claude-haiku-5-5', promptVersion: 'v2' };
    const dated: Translator = {
      ...noNotes,
      async translatePage(input) {
        return { ...(await translatorReturning('譯').translatePage(input)), model: 'claude-haiku-5-5-20261001' };
      },
    };
    const first = setup({ cache, notes: memoryNotes(), getTranslator: () => dated, translatorVersion: () => version });
    await first.transcriber.update(1, [thumb('a1')], capture);

    const second = setup({ cache, notes: memoryNotes(), getTranslator: () => dated, translatorVersion: () => version });
    await second.transcriber.update(1, [thumb('a1')], capture);

    expect(second.published.at(-1)![0]!.transcript).toMatchObject({ state: 'done', translation: { source: 'cache' } });
    expect(staleOf(second.published.at(-1)!)).toEqual([undefined]);
  });

  it('Notes 改了（notesChanged）：畫面上用到那個條目的頁馬上更新提示，改回來就消失', async () => {
    const notes = memoryNotes([note('今日', '今天')]);
    const { transcriber, published } = setup({ notes, getTranslator: () => translatorReturning('譯') });
    await transcriber.update(1, [thumb('a1')], capture);
    expect(staleOf(published.at(-1)!)).toEqual([undefined]);

    notes.entries = [note('今日', '今兒', { locked: true })];
    await transcriber.notesChanged('series-1');
    expect(staleOf(published.at(-1)!)).toEqual(['notes']);
    expect(staleOf(transcriber.get(1))).toEqual(['notes']);

    notes.entries = [note('今日', '今天', { locked: true })];
    await transcriber.notesChanged('series-1');
    expect(staleOf(published.at(-1)!)).toEqual([undefined]);
  });

  it('只重翻指定的那頁：命中快取的頁用快取裡的原文送出（不重跑 OCR），翻完不再過時、快取換成新的', async () => {
    const cache = memoryCache();
    cache.saved.push(cachedPage(HASHES.a1!), cachedPage(HASHES.a2!));
    const notes = memoryNotes([note('今日', '今兒', { locked: true })]);
    const calls: TranslateInput[] = [];
    const { transcriber, published, deps } = setup({ cache, notes, getTranslator: () => translatorReturning('新', calls) });
    await transcriber.update(1, [thumb('a1'), thumb('a2')], capture);
    expect(staleOf(published.at(-1)!)).toEqual(['notes', 'notes']);

    await transcriber.translate(1, HASHES.a1);

    expect(deps.analyze).not.toHaveBeenCalled();
    expect(calls.map((c) => c.items.map((i) => i.原文))).toEqual([['今日は', 'ドン']]);
    expect(calls[0]!.seriesNotes).toEqual([note('今日', '今兒', { locked: true })]);
    const [first, second] = published.at(-1)!;
    expect(first!.transcript).toMatchObject({ state: 'done', translation: { source: 'translated' } });
    expect(staleOf([first!, second!])).toEqual([undefined, 'notes']);
    expect(cache.saved.find((t) => t.pageHash === HASHES.a1)!.usedNotes).toEqual([{ 原文: '今日', 譯文: '今兒' }]);
  });

  it('updateNotes：人的修改寫進 Notes，畫面上用到那個條目的頁馬上標成過時', async () => {
    const notes = memoryNotes([note('今日', '今天')]);
    const { transcriber, published } = setup({ notes, getTranslator: () => translatorReturning('譯') });
    await transcriber.update(1, [thumb('a1')], capture);

    await transcriber.updateNotes('series-1', (current) => ({ ...current, entries: editEntry(current.entries, '今日', { 譯文: '今兒' }) }));

    expect(notes.entries).toEqual([note('今日', '今兒', { locked: true })]);
    expect(staleOf(published.at(-1)!)).toEqual(['notes']);
  });
});

describe('直式捲動的長 Page（spec #142）', () => {
  /** 長 Page 上的一個 Balloon，Page 座標。 */
  const balloonAt = (y: number, 原文: string): PageText['balloons'][number] => ({
    ...pageText.balloons[0]!,
    balloonBbox: { x: 0.1, y, w: 0.3, h: 0.05 },
    textBbox: { x: 0.15, y, w: 0.2, h: 0.05 },
    原文,
  });
  const sliceText = (...balloons: PageText['balloons']): PageText => ({ balloons: balloons.map((b, i) => ({ ...b, id: `b${i + 1}`, order: i + 1 })), looseText: [] });

  /** 長 canvas 捲到 Page 的 top～top+0.3 這一截；stripes 是這一截裡的橫條（第幾條＝hash 表裡的位置）。 */
  const longThumb = (anchorId: string, top: number, stripes: [number, string][]): PageThumb => ({
    anchorId,
    rect: { x: 0, y: -top * 2000, width: 400, height: 2000 },
    visible: { x: 0, y: 0, width: 400, height: 600 },
    thumbnail: `data:${anchorId}`,
    pageHash: stripes[0]?.[1] ?? '',
    stripes: stripes.map(([index, hash]) => ({ index, hash })),
  });

  it('每一截新收的 Line 併進同一個 Page，只翻新收的；下一截帶著已收 Line 的外框送去辨識', async () => {
    const calls: TranslateInput[] = [];
    const analyze = vi
      .fn<(request: AnalyzeRequest) => Promise<PageText>>()
      .mockResolvedValueOnce(sliceText(balloonAt(0.1, 'うえ')))
      .mockResolvedValueOnce(sliceText(balloonAt(0.4, 'した')));
    const { transcriber, published } = setup({ analyze, getTranslator: () => translatorReturning('譯', calls) });

    await transcriber.update(1, [longThumb('a1', 0, [[0, HASHES.a1!], [1, HASHES.a2!]])], capture);
    await transcriber.update(1, [longThumb('a1', 0.3, [[3, HASHES.a3!]])], capture);

    expect(calls.map((c) => c.items.map((i) => [i.id, i.原文]))).toEqual([[['b1', 'うえ']], [['b2', 'した']]]);
    expect(analyze.mock.calls[1]![0].collected).toEqual([balloonAt(0.1, '').balloonBbox]);
    const pages = published.at(-1)!;
    expect(pages).toHaveLength(1);
    const { transcript } = pages[0]!;
    expect(transcript.state === 'done' && transcript.text.balloons.map((b) => [b.原文, b.譯文, b.order])).toEqual([
      ['うえ', '譯-b1', 1],
      ['した', '譯-b2', 2],
    ]);
  });

  it('同一個 Page 前面翻好的段算一頁 Prior Pages（在 2 頁上限內，放在最後）', async () => {
    const calls: TranslateInput[] = [];
    const analyze = vi
      .fn<(request: AnalyzeRequest) => Promise<PageText>>()
      .mockResolvedValueOnce(sliceText(balloonAt(0.1, 'まえ1')))
      .mockResolvedValueOnce(sliceText(balloonAt(0.1, 'まえ2')))
      .mockResolvedValueOnce(sliceText(balloonAt(0.1, 'うえ')))
      .mockResolvedValueOnce(sliceText(balloonAt(0.4, 'なか')))
      .mockResolvedValueOnce(sliceText(balloonAt(0.7, 'した')));
    const { transcriber } = setup({ analyze, getTranslator: () => translatorReturning('譯', calls) });

    await transcriber.update(1, [thumb('a1')], capture);
    await transcriber.update(1, [thumb('a2')], capture);
    await transcriber.update(1, [longThumb('a3', 0, [[0, HASHES.a3!]])], capture);
    await transcriber.update(1, [longThumb('a3', 0.3, [[3, HASHES.a4!]])], capture);
    await transcriber.update(1, [longThumb('a3', 0.6, [[5, HASHES.a5!]])], capture);

    expect(calls.map((c) => c.priorPages.map((p) => p.map((l) => l.原文)))).toEqual([
      [],
      [['まえ1']],
      [['まえ1'], ['まえ2']],
      [['まえ2'], ['うえ']],
      [['まえ2'], ['うえ', 'なか']],
    ]);
    expect(calls[3]!.priorPages[1]).toEqual([{ kind: 'balloon', 原文: 'うえ', 譯文: '譯-b1' }]);
  });

  it('Hosted Translation 的接續：後面的段帶這一頁的 usageRecordId；重新翻譯整個 Page 不帶，之後的段改帶它回的', async () => {
    const calls: TranslateInput[] = [];
    // Worker 回的是這一頁扣頁那次的紀錄 id：接續的回原本的，不帶的（扣一頁）回新的
    let records = 0;
    const base = translatorReturning('譯', calls);
    const translator: Translator = {
      ...base,
      async translatePage(input) {
        return { ...(await base.translatePage(input)), usageRecordId: input.pageUsageRecordId ?? ++records };
      },
    };
    const analyze = vi
      .fn<(request: AnalyzeRequest) => Promise<PageText>>()
      .mockResolvedValueOnce(sliceText(balloonAt(0.1, 'うえ')))
      .mockResolvedValueOnce(sliceText(balloonAt(0.4, 'なか')))
      .mockResolvedValueOnce(sliceText(balloonAt(0.7, 'した')));
    const { transcriber } = setup({ analyze, getTranslator: () => translator });

    await transcriber.update(1, [longThumb('a1', 0, [[0, HASHES.a1!]])], capture);
    await transcriber.update(1, [longThumb('a1', 0.3, [[3, HASHES.a3!]])], capture);
    await transcriber.translate(1);
    await transcriber.update(1, [longThumb('a1', 0.6, [[5, HASHES.a5!]])], capture);

    expect(calls.map((c) => [c.items.length, c.pageUsageRecordId])).toEqual([
      [1, undefined],
      [1, 1],
      [2, undefined],
      [1, 2],
    ]);
  });

  it('扣頁紀錄存進快取：重新整理（或 SW 被回收）後接續照樣帶原本的 usageRecordId，扣頁超過 1 小時就不帶', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const calls: TranslateInput[] = [];
      let records = 0;
      const base = translatorReturning('譯', calls);
      const translator: Translator = {
        ...base,
        async translatePage(input) {
          return { ...(await base.translatePage(input)), usageRecordId: input.pageUsageRecordId ?? ++records };
        },
      };
      const cache = memoryCache();
      const analyze = vi
        .fn<(request: AnalyzeRequest) => Promise<PageText>>()
        .mockResolvedValueOnce(sliceText(balloonAt(0.1, 'うえ')))
        .mockResolvedValueOnce(sliceText(balloonAt(0.4, 'なか')))
        .mockResolvedValueOnce(sliceText(balloonAt(0.7, 'した')));
      const scan = async (anchorId: string, top: number, stripes: [number, string][]) => {
        // 每次都是新的 transcriber：記憶體裡什麼都沒有，只剩快取
        const { transcriber } = setup({ cache, analyze, getTranslator: () => translator });
        await transcriber.update(1, [longThumb(anchorId, top, stripes)], capture);
      };

      vi.setSystemTime(0);
      await scan('a1', 0, [[0, HASHES.a1!]]);
      vi.setSystemTime(59 * 60_000);
      await scan('a8', 0.3, [[0, HASHES.a1!], [3, HASHES.a3!]]);
      vi.setSystemTime(61 * 60_000);
      await scan('a9', 0.6, [[3, HASHES.a3!], [5, HASHES.a5!]]);

      expect(calls.map((c) => c.pageUsageRecordId)).toEqual([undefined, 1, undefined]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('同一截再出現（例如覆蓋層畫好後再掃一次）不重新辨識', async () => {
    const { transcriber, deps } = setup();
    await transcriber.update(1, [longThumb('a1', 0, [[0, HASHES.a1!]])], capture);
    await transcriber.update(1, [longThumb('a1', 0, [[0, HASHES.a1!]])], capture);
    expect(deps.analyze).toHaveBeenCalledTimes(1);
  });

  it('快取存整個 Page 的 Line 與看過的橫條；重新整理後任何一條橫條對得上就命中，沒有新的 Line 就不翻譯', async () => {
    const cache = memoryCache();
    const calls: TranslateInput[] = [];
    const analyze = vi
      .fn<(request: AnalyzeRequest) => Promise<PageText>>()
      .mockResolvedValueOnce(sliceText(balloonAt(0.1, 'うえ')))
      .mockResolvedValueOnce(sliceText(balloonAt(0.4, 'した')))
      .mockResolvedValue({ balloons: [], looseText: [] });
    const { transcriber, published } = setup({ cache, analyze, getTranslator: () => translatorReturning('譯', calls) });
    await transcriber.update(1, [longThumb('a1', 0, [[0, HASHES.a1!]])], capture);
    await transcriber.update(1, [longThumb('a1', 0.3, [[3, HASHES.a3!]])], capture);
    expect(cache.saved).toHaveLength(1);
    expect(cache.saved[0]!.balloons.map((b) => b.原文)).toEqual(['うえ', 'した']);
    expect(cache.saved[0]!.stripes).toEqual([
      { index: 0, hash: HASHES.a1 },
      { index: 3, hash: HASHES.a3 },
    ]);

    // 重新整理：anchor 換了，只靠橫條認
    transcriber.resetPages(1);
    await transcriber.update(1, [longThumb('a9', 0.3, [[3, HASHES.a3!]])], capture);

    expect(calls).toHaveLength(2);
    expect(analyze.mock.calls[2]![0].collected).toHaveLength(2);
    const { transcript } = published.at(-1)![0]!;
    expect(transcript).toMatchObject({ state: 'done', translated: true, translation: { source: 'cache' } });
    expect(transcript.state === 'done' && transcript.text.balloons.map((b) => b.譯文)).toEqual(['譯-b1', '譯-b2']);
  });

  it('看不到任何有內容的橫條、anchor 也還沒認出 Page 時，先不處理', async () => {
    const { transcriber, published, deps } = setup();
    await transcriber.update(1, [longThumb('a1', 0, [])], capture);
    expect(deps.analyze).not.toHaveBeenCalled();
    expect(published.at(-1)).toEqual([]);
  });
});
