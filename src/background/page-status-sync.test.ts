import { describe, expect, it } from 'vitest';
import type { AnchorStatus, ActionBadge } from '../shared/page-status.ts';
import type { ModelStatus, PageView } from '../shared/messages.ts';
import { createPageStatusSync } from './page-status-sync.ts';

const analyzing = (anchorId: string, pageHash: string): PageView => ({
  anchorId,
  pageHash,
  rect: { x: 0, y: 0, width: 100, height: 140 },
  thumbnail: '',
  transcript: { state: 'analyzing' },
});

const done = (page: PageView): PageView => ({ ...page, transcript: { state: 'done', text: { balloons: [], looseText: [] }, translated: true } });

function setup() {
  const sent: [number, AnchorStatus[]][] = [];
  const badges: [number, ActionBadge | undefined][] = [];
  const sync = createPageStatusSync({
    send: (tabId, anchors) => void sent.push([tabId, anchors]),
    setBadge: (tabId, badge) => void badges.push([tabId, badge]),
    accessProblem: async () => undefined,
  });
  return { sync, sent, badges };
}

describe('Page 狀態送到 content script 與圖示 badge', () => {
  it('翻譯中送出小標籤、badge 是 …；翻完拿掉、badge 回到小點', async () => {
    const { sync, sent, badges } = setup();
    const page = analyzing('a1', 'h1');
    await sync.activated(1);

    await sync.pagesUpdated(1, [page]);
    await sync.pagesUpdated(1, [done(page)]);

    expect(sent).toEqual([
      [1, []],
      [1, [{ anchorId: 'a1', working: { text: '辨識文字…' } }]],
      [1, []],
    ]);
    expect(badges).toEqual([
      [1, 'on'],
      [1, 'busy'],
      [1, 'on'],
    ]);
  });

  it('送去 LLM 之後改成「翻譯中…」；內容沒變就不重送', async () => {
    const { sync, sent } = setup();
    const page = analyzing('a1', 'h1');
    await sync.activated(1);
    await sync.pagesUpdated(1, [page]);
    sent.length = 0;

    await sync.jobEvent({ tabId: 1, event: 'llm', pageHash: 'h1' });
    await sync.pagesUpdated(1, [page]);

    expect(sent.map(([, anchors]) => anchors[0]?.working?.text)).toEqual(['翻譯中…']);
  });

  it('模型下載進度：每個有 Page 在等的 tab 都更新', async () => {
    const { sync, sent } = setup();
    await Promise.all([sync.activated(1), sync.activated(2)]);
    await sync.pagesUpdated(1, [analyzing('a1', 'h1')]);
    await sync.pagesUpdated(2, [done(analyzing('a1', 'h2'))]);
    const downloading: ModelStatus = { state: 'downloading', loaded: 1, total: 2 };

    await sync.modelStatus(downloading);

    expect(sent.at(-1)).toEqual([1, [{ anchorId: 'a1', working: { text: '下載文字辨識模型 50%', progress: 0.5 } }]]);
    expect(sent.filter(([tabId]) => tabId === 2)).toHaveLength(1);
  });

  it('停止：拿掉 badge；重新整理後（content script 是新的）同樣的狀態也照樣重送', async () => {
    const { sync, sent, badges } = setup();
    const page = analyzing('a1', 'h1');
    await sync.activated(1);
    await sync.pagesUpdated(1, [page]);
    sent.length = 0;

    sync.reset(1);
    await sync.pagesUpdated(1, [page]);
    sync.clear(1);
    await sync.pagesUpdated(1, []);

    expect(sent).toEqual([[1, [{ anchorId: 'a1', working: { text: '辨識文字…' } }]]]);
    expect(badges.at(-1)).toEqual([1, undefined]);
  });
});

describe('額度快用完（#237）', () => {
  it('所有已啟動的 tab 都換成橘點，之後才啟動的也是；沒啟動的不動', async () => {
    const { sync, badges } = setup();
    await Promise.all([sync.activated(1), sync.activated(2)]);
    badges.length = 0;

    await sync.quotaChanged(true);
    await sync.activated(3);
    await sync.quotaChanged(true);

    expect(badges).toEqual([
      [1, 'lowQuota'],
      [2, 'lowQuota'],
      [3, 'lowQuota'],
    ]);
  });

  it('額度又夠了（訂閱、重置）：回到綠點', async () => {
    const { sync, badges } = setup();
    await sync.activated(1);
    await sync.quotaChanged(true);

    await sync.quotaChanged(false);

    expect(badges.at(-1)).toEqual([1, 'on']);
  });
});
