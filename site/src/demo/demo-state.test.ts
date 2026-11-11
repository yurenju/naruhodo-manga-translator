import { describe, expect, it } from 'vitest';
import type { PageText } from '../../../src/shared/page-text.ts';
import { DEMO_PAGE_HASH, FREE_PAGES, clickIcon, demoView, nextPhase, type DemoPhase } from './demo-state.ts';

const text: PageText = {
  balloons: [
    {
      id: 'b1',
      order: 1,
      balloonBbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      textBbox: { x: 0.12, y: 0.12, w: 0.1, h: 0.1 },
      orientation: 'vertical',
      原文: 'おはよう',
      讀音: 'おはよう',
      讀音來源: 'llm',
      譯文: '早安',
      unreadable: false,
    },
  ],
  looseText: [],
};

describe('展示的進度', () => {
  it('點圖示前 side panel 沒打開，額度是滿的', () => {
    expect(demoView('closed', text)).toEqual({ panelOpen: false, running: false, pages: [], remaining: FREE_PAGES, overlay: false });
  });

  it('點圖示後先辨識：逐字稿顯示辨識中，頁面上還沒有譯文', () => {
    const view = demoView('recognizing', text);
    expect(view.panelOpen).toBe(true);
    expect(view.pages.map((p) => p.transcript)).toEqual([{ state: 'analyzing' }]);
    expect(view.overlay).toBe(false);
  });

  it('翻譯中：已經有原文、還沒有譯文', () => {
    const [page] = demoView('translating', text).pages;
    expect(page!.transcript).toMatchObject({ state: 'done', translated: false, translating: true });
    if (page!.transcript.state !== 'done') throw new Error('unreachable');
    expect(page!.transcript.text.balloons[0]).toMatchObject({ 原文: 'おはよう', 譯文: '' });
  });

  it('翻完：頁面蓋上譯文，剩餘頁數少一頁（100 → 99）', () => {
    const view = demoView('done', text);
    expect(view.overlay).toBe(true);
    expect(view.remaining).toBe(99);
    expect(view.pages[0]!.pageHash).toBe(DEMO_PAGE_HASH);
    expect(view.pages[0]!.transcript).toMatchObject({ state: 'done', translated: true, text });
  });

  it('點圖示後自動走完 辨識 → 翻譯 → 完成，總共 1～2 秒', () => {
    const steps = [];
    for (let step = nextPhase('recognizing'); step; step = nextPhase(step.phase)) steps.push(step);
    expect(steps.map((s) => s.phase)).toEqual(['translating', 'done']);
    const total = steps.reduce((ms, s) => ms + s.afterMs, 0);
    expect(total).toBeGreaterThanOrEqual(1000);
    expect(total).toBeLessThanOrEqual(2000);
  });
});

describe('圖示是開關（跟外掛的 toggle 一樣）', () => {
  it('點一下開 side panel，再點一下關掉，再點又重新開始翻譯', () => {
    const opened = clickIcon('closed');
    expect(opened).toBe('recognizing');
    expect(demoView(opened, text)).toMatchObject({ panelOpen: true, running: true });
    const closed = clickIcon(opened);
    expect(demoView(closed, text)).toMatchObject({ panelOpen: false, running: false, overlay: false });
    expect(clickIcon(closed)).toBe('recognizing');
  });

  it('翻譯途中或翻完再點，都是停止並關掉 side panel', () => {
    for (const phase of ['recognizing', 'translating', 'done'] satisfies DemoPhase[]) expect(clickIcon(phase)).toBe('closed');
  });

  it('按 side panel 的「停止」：side panel 留著、提示點圖示，頁面上的譯文拿掉；再點圖示重新開始', () => {
    expect(demoView('stopped', text)).toEqual({ panelOpen: true, running: false, pages: [], remaining: FREE_PAGES, overlay: false });
    expect(clickIcon('stopped')).toBe('recognizing');
  });
});
