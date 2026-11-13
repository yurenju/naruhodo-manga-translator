import { describe, expect, it } from 'vitest';
import type { ModelStatus, PageView } from './messages.ts';
import type { PageText } from './page-text.ts';
import { pageStatus, type PageStatusInput } from './page-status.ts';

const text: PageText = { balloons: [], looseText: [] };

function page(anchorId: string, pageHash: string, transcript: PageView['transcript']): PageView {
  return { anchorId, pageHash, rect: { x: 0, y: 0, width: 100, height: 140 }, thumbnail: '', transcript };
}

const ready: ModelStatus = { state: 'ready', executionProvider: 'wasm', threads: 4 };

const input = (pages: PageView[], more: Partial<PageStatusInput> = {}): PageStatusInput => ({
  pages,
  model: ready,
  translating: new Set(),
  access: undefined,
  lowQuota: false,
  ...more,
});

describe('翻譯中', () => {
  it('本機流水線在跑：右上角「辨識文字…」、不定進度，圖示是 …', () => {
    expect(pageStatus(input([page('a1', 'h1', { state: 'analyzing' })]))).toEqual({
      anchors: [{ anchorId: 'a1', working: { text: '辨識文字…' } }],
      badge: 'busy',
    });
  });

  it('送去翻譯了：「翻譯中…」', () => {
    const status = pageStatus(input([page('a1', 'h1', { state: 'analyzing' })], { translating: new Set(['h1']) }));

    expect(status.anchors).toEqual([{ anchorId: 'a1', working: { text: '翻譯中…' } }]);
  });

  it('第一次使用、模型在下載：顯示百分比，進度條照實際進度', () => {
    const status = pageStatus(input([page('a1', 'h1', { state: 'analyzing' })], { model: { state: 'downloading', loaded: 50, total: 200 } }));

    expect(status.anchors).toEqual([{ anchorId: 'a1', working: { text: '下載文字辨識模型 25%', progress: 0.25 } }]);
  });

  it('模型載入記憶體中：「載入文字辨識模型…」', () => {
    const status = pageStatus(input([page('a1', 'h1', { state: 'analyzing' })], { model: { state: 'loading' } }));

    expect(status.anchors).toEqual([{ anchorId: 'a1', working: { text: '載入文字辨識模型…' } }]);
  });

  it('按了重新翻譯（done 但 translating）：「翻譯中…」', () => {
    const status = pageStatus(input([page('a1', 'h1', { state: 'done', text, translated: true, translating: true })]));

    expect(status.anchors).toEqual([{ anchorId: 'a1', working: { text: '翻譯中…' } }]);
  });
});

describe('翻完', () => {
  it('翻好的 Page 不留狀態，圖示是已啟動的小點', () => {
    expect(pageStatus(input([page('a1', 'h1', { state: 'done', text, translated: true })]))).toEqual({ anchors: [], badge: 'on' });
  });

  it('沒有任何 Page（還在找、畫面上沒有完整的頁）：小點', () => {
    expect(pageStatus(input([]))).toEqual({ anchors: [], badge: 'on' });
  });
});

describe('出問題：可以點的紅色小標籤，圖示是 !', () => {
  it('免費額度用完：「免費額度用完了・查看方案」', () => {
    expect(pageStatus(input([page('a1', 'h1', { state: 'done', text, translated: false, quotaExhausted: 'free' })]))).toEqual({
      anchors: [{ anchorId: 'a1', problem: { text: '免費額度用完了・查看方案', action: 'plan', pageHash: 'h1' } }],
      badge: 'problem',
    });
  });

  it('今天全站的免費額度發完了：明天再試，跟「免費額度用完了」分開', () => {
    const status = pageStatus(input([page('a1', 'h1', { state: 'done', text, translated: false, quotaExhausted: 'pausedToday' })]));

    expect(status.anchors[0]!.problem).toEqual({ text: '今天的免費額度已經發完，明天再試・查看方案', action: 'plan', pageHash: 'h1' });
  });

  it('本月額度用完：「本月額度用完了・查看方案」', () => {
    const status = pageStatus(input([page('a1', 'h1', { state: 'done', text, translated: false, quotaExhausted: 'monthly' })]));

    expect(status.anchors[0]!.problem?.text).toBe('本月額度用完了・查看方案');
  });

  it('還沒登入（或沒同意）：「還沒登入・登入」', () => {
    const status = pageStatus(input([page('a1', 'h1', { state: 'done', text, translated: false })], { access: 'signIn' }));

    expect(status.anchors).toEqual([{ anchorId: 'a1', problem: { text: '還沒登入・登入', action: 'signIn', pageHash: 'h1' } }]);
  });

  it('自備金鑰沒有 key：「還沒設定 API key・設定」', () => {
    const status = pageStatus(input([page('a1', 'h1', { state: 'done', text, translated: false })], { access: 'ownKey' }));

    expect(status.anchors[0]!.problem).toEqual({ text: '還沒設定 API key・設定', action: 'ownKey', pageHash: 'h1' });
  });

  it('翻譯失敗（LLM 重試後仍失敗，或本機流水線失敗）：「翻譯失敗・重試」', () => {
    const status = pageStatus(
      input([page('a1', 'h1', { state: 'done', text, translated: false, translateError: 'Claude API 500' }), page('a2', 'h2', { state: 'error', message: 'model' })]),
    );

    expect(status.anchors).toEqual([
      { anchorId: 'a1', problem: { text: '翻譯失敗・重試', action: 'retry', pageHash: 'h1' } },
      { anchorId: 'a2', problem: { text: '翻譯失敗・重試', action: 'retry', pageHash: 'h2' } },
    ]);
  });

  it('能翻譯卻沒譯文（長 Page 還沒收到字）：不算問題', () => {
    expect(pageStatus(input([page('a1', 'h1', { state: 'done', text, translated: false })]))).toEqual({ anchors: [], badge: 'on' });
  });

  it('Spread 一頁在翻、一頁出問題：anchor 上顯示翻譯中，圖示照樣是 !', () => {
    const status = pageStatus(
      input([page('a1', 'right', { state: 'done', text, translated: false, translateError: 'boom' }), page('a1', 'left', { state: 'analyzing' })]),
    );

    expect(status).toEqual({ anchors: [{ anchorId: 'a1', working: { text: '辨識文字…' } }], badge: 'problem' });
  });
});

describe('額度快用完（#237）', () => {
  const analyzing = page('a1', 'h1', { state: 'analyzing' });
  const failed = page('a2', 'h2', { state: 'error', message: 'boom' });
  const translated = page('a3', 'h3', { state: 'done', text, translated: true });

  it('平常的綠點換成橘點；翻譯中先顯示藍色，出問題仍是紅色', () => {
    expect(pageStatus(input([translated], { lowQuota: true })).badge).toBe('lowQuota');
    expect(pageStatus(input([analyzing], { lowQuota: true })).badge).toBe('busy');
    expect(pageStatus(input([analyzing, failed], { lowQuota: true })).badge).toBe('problem');
  });
});

describe('正在讀照句數計頁的 Strip（條漫，#282）', () => {
  const analyzing = page('a1', 'h1', { state: 'analyzing' });
  const translated = page('a3', 'h3', { state: 'done', text, translated: true });

  it('圓點換成「條」；快用完是橘色底的「條」；翻譯中、出問題照舊', () => {
    expect(pageStatus(input([translated], { strip: true })).badge).toBe('strip');
    expect(pageStatus(input([translated], { strip: true, lowQuota: true })).badge).toBe('stripLowQuota');
    expect(pageStatus(input([analyzing], { strip: true })).badge).toBe('busy');
  });
});
