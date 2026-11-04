import { describe, expect, it } from 'vitest';
import { CLAUDE_MODEL, notesRequest, parseNotesResponse, parseSeriesGuessResponse, parseTranslateResponse, seriesGuessRequest, translateRequest } from './claude-request.ts';
import type { NotesInput, TitleSignals, TranslateInput } from './translator.ts';

const input: TranslateInput = {
  seriesNotes: [{ seriesId: 's1', 原文: '霧島湊', 讀音: 'きりしまみなと', 譯文: '霧島湊', 類別: '人名', locked: true }],
  priorPages: [[{ kind: 'balloon', 原文: '湊！', 譯文: '湊！' }]],
  items: [{ id: 'b1', kind: 'balloon', 原文: 'おはよう', orientation: 'vertical' }],
};

const notesInput: NotesInput = {
  seriesNotes: [],
  items: [{ kind: 'balloon', 原文: 'パン屋に行こう', 譯文: '去麵包店吧' }],
};

const usage = { input_tokens: 300, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 700 };

const apiResponse = (answer: unknown, stop_reason = 'end_turn') => ({
  model: CLAUDE_MODEL,
  stop_reason,
  content: [{ type: 'text', text: JSON.stringify(answer) }],
  usage,
});

describe('共用的 request 組裝模組（Own API Key 與 Worker 共用）', () => {
  it('翻譯的 request body 只由結構化輸入決定：model、max_tokens、system、Prior Pages 都由模組定', () => {
    const body = translateRequest(input);

    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.max_tokens).toBe(16_000);
    expect(body.system).toHaveLength(2);
    // Series Notes 只送內容，不送本機才有意義的 seriesId、locked
    expect(body.system[1]?.text).toContain('"原文":"霧島湊"');
    expect(body.system[1]?.text).not.toContain('seriesId');
    expect(body.system[1]?.text).not.toContain('locked');
    expect(body.messages[0]?.content.map((c) => c.text)).toEqual([
      'context（前面的頁，依閱讀順序）：\n[[{"kind":"balloon","ja":"湊！","zh":"湊！"}]]',
      '這一頁要翻譯的文字：\n[{"id":"b1","kind":"balloon","ja":"おはよう"}]',
    ]);
  });

  it('Series 有名稱時，作品名放在 user message 最前面，之後是 Prior Pages 與這一頁', () => {
    const body = translateRequest({ ...input, seriesName: '星屑バンド' });

    expect(body.messages[0]?.content.map((c) => c.text)).toEqual([
      '作品名：星屑バンド',
      'context（前面的頁，依閱讀順序）：\n[[{"kind":"balloon","ja":"湊！","zh":"湊！"}]]',
      '這一頁要翻譯的文字：\n[{"id":"b1","kind":"balloon","ja":"おはよう"}]',
    ]);
    // 作品名每部不同，不放進 system，指示那段的 prompt cache 照樣命中
    expect(body.system).toEqual(translateRequest(input).system);
  });

  it('沒有 Prior Pages 也有作品名時，這一頁的原文同樣標出來', () => {
    const body = translateRequest({ ...input, priorPages: [], seriesName: '星屑バンド' });

    expect(body.messages[0]?.content.map((c) => c.text)).toEqual([
      '作品名：星屑バンド',
      '這一頁要翻譯的文字：\n[{"id":"b1","kind":"balloon","ja":"おはよう"}]',
    ]);
  });

  it('沒有作品名時不送作品名', () => {
    const body = translateRequest(input);

    expect(JSON.stringify(body.messages)).not.toContain('作品名');
  });

  it('翻譯的指示含作品名、真實專有名詞與敬稱的翻法', () => {
    const [instructions] = translateRequest(input).system;

    // 作品名：不當狀聲詞，有官方譯名就用
    expect(instructions?.text).toMatch(/作品名[^\n]*狀聲詞/);
    // T2：真實世界的樂團、品牌、作品名用官方寫法或保留原文
    expect(instructions?.text).toMatch(/真實世界[^\n]*樂團[^\n]*品牌[^\n]*官方[^\n]*保留原文/);
    // T3：さん 依場景翻成「同學」、只叫名字或省略，不要一律翻成先生／小姐
    expect(instructions?.text).toMatch(/さん[^\n]*同學[^\n]*省略[^\n]*先生／小姐/);
  });

  it('翻譯的 schema 每一項都要回 sfx，指示寫明擬音、擬態算 Sound Effect，角色自己的感嘆不算', () => {
    const body = translateRequest(input);
    const item = (body.output_config.format.schema as { properties: { items: { items: { properties: Record<string, { type: string }>; required: string[] } } } }).properties.items.items;

    expect(item.properties.sfx?.type).toBe('boolean');
    expect(item.required).toContain('sfx');
    expect(body.system[0]?.text).toMatch(/sfx[^\n]*擬音[^\n]*擬態[^\n]*感嘆[^\n]*不算/);
  });

  it('unreadable 只指 OCR 亂碼與劇情上本來就看不懂的字，變體表記照常翻譯（#179）', () => {
    const text = translateRequest(input).system[0]?.text;

    expect(text).toMatch(/unreadable[^\n]*OCR 亂碼[^\n]*本來就[^\n]*看不懂/);
    expect(text).toMatch(/變體表記不是亂碼（只適用於 kind 是 balloon[^\n]*loose 照上面的規則[^\n]*假名[^\n]*照常翻譯[^\n]*改字[^\n]*不算/);
  });

  it('整理 Notes 的 request body：沒有 Series Notes 時 system 只有指示一段', () => {
    const body = notesRequest(notesInput);

    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.system).toHaveLength(1);
    expect(body.messages[0]?.content[0]?.text).toBe('[{"kind":"balloon","ja":"パン屋に行こう","zh":"去麵包店吧"}]');
  });

  it('解析翻譯回應：譯文、讀音、用量與模型', () => {
    const out = parseTranslateResponse(
      apiResponse({ items: [{ id: 'b1', reading: 'おはよう', zh: '早安', unreadable: false, sfx: false }] }),
    );

    expect(out).toEqual({
      items: [{ id: 'b1', 讀音: 'おはよう', 譯文: '早安', unreadable: false, sfx: false }],
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 700, costUsd: 0.000137 },
      model: CLAUDE_MODEL,
    });
  });

  it('解析 Notes 回應：轉成新增／補空欄位／建議修改', () => {
    const out = parseNotesResponse(
      apiResponse({
        notes_changes: {
          added: [{ ja: 'パン屋', reading: 'ぱんや', zh: '麵包店', category: '地名', note: '' }],
          filled: [],
          suggestions: [],
        },
      }),
    );

    expect(out.notes_changes).toEqual({
      added: [{ 原文: 'パン屋', 讀音: 'ぱんや', 譯文: '麵包店', 類別: '地名' }],
      filled: [],
      suggestions: [],
    });
  });

  it('回應被截斷或不符合 schema 時丟錯', () => {
    expect(() => parseTranslateResponse(apiResponse({ items: [] }, 'max_tokens'))).toThrow('stop_reason: max_tokens');
    expect(() => parseNotesResponse(apiResponse({ items: [] }))).toThrow('不符合 schema');
    expect(() => parseTranslateResponse(apiResponse({ items: [{ id: 'b1', reading: '', zh: '', unreadable: false }] }))).toThrow('不符合 schema');
  });
});

describe('從頁面標題猜作品原名（#186）', () => {
  const signals: TitleSignals = { title: '[第12話]星降る町の郵便屋 - 作者名 | 漫畫網站', ogTitle: '', headings: ['第12話', '星降る町の郵便屋'] };

  it('request 只送頁面文字：標題、og:title、標題列，不送網址；回答固定是 JSON schema', () => {
    const body = seriesGuessRequest(signals);

    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.output_config.format.schema).toMatchObject({ required: ['status', 'original_title', 'zh_title'] });
    expect(JSON.parse(body.messages[0]!.content[0]!.text)).toEqual({
      title: '[第12話]星降る町の郵便屋 - 作者名 | 漫畫網站',
      og_title: '',
      headings: ['第12話', '星降る町の郵便屋'],
    });
  });

  it('指示寫明要去掉集數、話數、レーベル、作者、網站名、特典標記，保留副標題、外傳與續作名稱；首頁與列表回 unknown', () => {
    const instructions = seriesGuessRequest(signals).system.map((b) => b.text).join('\n');

    for (const word of ['集數', '話數', 'レーベル', '作者', '網站名', '特典', '副標題', '外傳', '續作', '首頁', '列表', '搜尋', '登入', '雜誌合集', 'unknown']) {
      expect(instructions).toContain(word);
    }
  });

  it('解析回應：原名、中文譯名與用量', () => {
    const parsed = parseSeriesGuessResponse(apiResponse({ status: 'work', original_title: '星降る町の郵便屋', zh_title: '星落小鎮的郵差' }));

    expect(parsed).toMatchObject({ status: 'work', 原名: '星降る町の郵便屋', 中文譯名: '星落小鎮的郵差', model: CLAUDE_MODEL });
    expect(parsed.usage.outputTokens).toBe(200);
  });

  it('status 不是 work／unknown 時丟錯', () => {
    expect(() => parseSeriesGuessResponse(apiResponse({ status: 'maybe', original_title: '', zh_title: '' }))).toThrow('schema');
  });
});
