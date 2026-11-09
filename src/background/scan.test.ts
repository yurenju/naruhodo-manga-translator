import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageCandidate, PageThumb } from '../shared/messages.ts';
import { createScanner, type ScannerDeps } from './scan.ts';

const VIEWPORT = { width: 1280, height: 720 };
const P1: PageCandidate = { anchorId: 'a1', rect: { x: 425, y: 57, width: 430, height: 625 } };
const WINDOW_ID = 7;

/** 用記憶體模擬 content script、captureVisibleTab、offscreen。 */
function fakeDeps(candidates: PageCandidate[] = [P1]) {
  const captures: number[] = [];
  const published: [number, PageThumb[]][] = [];
  /** 每次公布帶的截圖（與 published 同序）。 */
  const publishedCaptures: Parameters<ScannerDeps['publish']>[2][] = [];
  /** 覆蓋層與截圖的先後順序。 */
  const events: string[] = [];
  const env = {
    viewport: VIEWPORT,
    candidates,
    visible: true,
    /** 每次量 rect 花的時間（ms），依序取用；用完就是 0。 */
    findDelays: [] as number[],
    /** 截圖當下頁面發生的事（例如 side panel 打開、版面重排）。 */
    onCapture: () => {},
    /** anchor 的原圖 hash；沒設就用 anchorId。 */
    cleanHash: {} as Record<string, string>,
    /** anchor 上有覆蓋層而且沒藏起來時，截到的 hash。 */
    overlaidHash: {} as Record<string, string>,
    hidden: false,
    /** 最近一次截圖時覆蓋層有沒有藏起來（crop 用）。 */
    capturedHidden: false,
    /** 每次截完時藏起來的遮擋物有沒有被換掉，依序取用；用完就是 true。 */
    stable: [] as boolean[],
    /** 每次準備截圖時頁面有沒有重繪（rAF 有沒有跑），依序取用；用完就是 true。 */
    painted: [] as boolean[],
  };
  const deps: ScannerDeps = {
    findPageCandidates: async () => {
      const delay = env.findDelays.shift() ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      return { viewport: env.viewport, candidates: env.candidates };
    },
    getVisibleWindowId: async () => (env.visible ? WINDOW_ID : undefined),
    captureWindow: async (windowId) => {
      expect(windowId).toBe(WINDOW_ID);
      captures.push(Date.now());
      events.push('capture');
      env.capturedHidden = env.hidden;
      env.onCapture();
      return `data:image/png;base64,SCREENSHOT${captures.length}`;
    },
    crop: async ({ screenshot, candidates }) =>
      candidates.map((c) => {
        const withOverlay = !env.capturedHidden && (c.overlaid?.length ?? 0) > 0;
        const pageHash = (withOverlay ? env.overlaidHash[c.anchorId] : env.cleanHash[c.anchorId]) ?? c.anchorId;
        return { anchorId: c.anchorId, rect: c.rect, thumbnail: `thumb(${screenshot},${c.anchorId})`, pageHash };
      }),
    publish: (tabId, pages, capture) => {
      published.push([tabId, pages]);
      publishedCaptures.push(capture);
    },
    // hide＝連覆蓋層一起藏；prepare＝只藏網站的遮擋物
    prepareCapture: async (tabId, hideOverlay) => {
      env.hidden = hideOverlay;
      events.push(`${hideOverlay ? 'hide' : 'prepare'} ${tabId}`);
      return { painted: env.painted.shift() ?? true };
    },
    finishCapture: async (tabId) => {
      env.hidden = false;
      events.push(`restore ${tabId}`);
      return { stable: env.stable.shift() ?? true };
    },
  };
  return { deps, captures, published, publishedCaptures, events, env };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** 等掃描做完；中間的限速等待用假時鐘快轉。 */
async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

describe('scan', () => {
  it('截圖、依候選裁切，並公布這個 tab 的 Page 縮圖', async () => {
    const chrome = fakeDeps();
    const scanner = createScanner(chrome.deps);

    await settle(scanner.scan(1));

    const expected = [{ anchorId: 'a1', rect: P1.rect, thumbnail: 'thumb(data:image/png;base64,SCREENSHOT1,a1)', pageHash: 'a1' }];
    expect(chrome.published).toEqual([[1, expected]]);
    expect(scanner.getPages(1)).toEqual(expected);
  });

  it('公布時一併給出截圖與量到的版面，讓後面的流水線用全解析度的 Page', async () => {
    const chrome = fakeDeps();
    const captures: unknown[] = [];
    const scanner = createScanner({ ...chrome.deps, publish: (_tabId, _pages, capture) => void captures.push(capture) });

    await settle(scanner.scan(1));

    expect(captures).toEqual([{ screenshot: 'data:image/png;base64,SCREENSHOT1', viewport: VIEWPORT, candidates: [P1], overlayShown: false }]);
  });

  it('沒有 Page 候選就不截圖，公布空清單', async () => {
    const chrome = fakeDeps([]);
    const scanner = createScanner(chrome.deps);

    await settle(scanner.scan(1));

    expect(chrome.captures).toEqual([]);
    expect(chrome.published).toEqual([[1, []]]);
  });

  it('tab 不在前景就不截圖（否則會截到別的 tab），保留上一次的結果', async () => {
    const chrome = fakeDeps();
    const scanner = createScanner(chrome.deps);
    await settle(scanner.scan(1));

    chrome.env.visible = false;
    await settle(scanner.scan(1));

    expect(chrome.captures).toHaveLength(1);
    expect(chrome.published).toHaveLength(1);
    expect(scanner.getPages(1)).toHaveLength(1);
  });

  it('連續觸發時截圖間隔至少 500 ms（≤2 次/秒），跨 tab 也算', async () => {
    const chrome = fakeDeps();
    const scanner = createScanner(chrome.deps);

    chrome.env.findDelays = [120, 0, 300, 0, 50, 0, 200];
    const scans = [1, 2, 3, 4, 5].map((tabId) => scanner.scan(tabId));
    await settle(Promise.all(scans));

    expect(chrome.captures).toHaveLength(5);
    const gaps = chrome.captures.slice(1).map((t, i) => t - chrome.captures[i]!);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(500);
  });

  it('同一個 tab 還沒開始的掃描會合併：快速連按翻頁，停下後只再截一次（#27 除錯）', async () => {
    const chrome = fakeDeps();
    const scanner = createScanner(chrome.deps);
    const first = scanner.scan(1);
    await vi.advanceTimersByTimeAsync(0);

    const later = [1, 2, 3, 4, 5].map(() => scanner.scan(1));
    await settle(Promise.all([first, ...later]));

    expect(chrome.captures).toHaveLength(2);
  });

  it('clear 之後再觸發的掃描不會併進被取消的那次', async () => {
    const chrome = fakeDeps();
    const scanner = createScanner(chrome.deps);
    const stale = scanner.scan(1);
    scanner.clear(1);
    const fresh = scanner.scan(1);
    await settle(Promise.all([stale, fresh]));

    expect(chrome.captures).toHaveLength(1);
    expect(scanner.getPages(1)).toHaveLength(1);
  });

  it('截圖期間版面變了（例如 side panel 剛打開）就重新量、重新截圖', async () => {
    const chrome = fakeDeps();
    const scanner = createScanner(chrome.deps);
    const shifted: PageCandidate = { anchorId: 'a1', rect: { x: 221, y: 57, width: 430, height: 625 } };
    chrome.env.onCapture = () => {
      chrome.env.viewport = { width: 872, height: 720 };
      chrome.env.candidates = [shifted];
      chrome.env.onCapture = () => {};
    };

    await settle(scanner.scan(1));

    expect(chrome.captures).toHaveLength(2);
    expect(scanner.getPages(1)).toEqual([
      { anchorId: 'a1', rect: shifted.rect, thumbnail: 'thumb(data:image/png;base64,SCREENSHOT2,a1)', pageHash: 'a1' },
    ]);
  });

  it('clear 之後清掉結果，進行中的掃描也不再公布', async () => {
    const chrome = fakeDeps();
    const scanner = createScanner(chrome.deps);
    await settle(scanner.scan(1));

    const inFlight = scanner.scan(1);
    scanner.clear(1);
    await settle(inFlight);

    expect(scanner.getPages(1)).toEqual([]);
    expect(chrome.published.at(-1)).toEqual([1, []]);
  });

  it('截圖前隱藏覆蓋層、截完立刻還原，截圖裡才不會有我們的中文', async () => {
    const chrome = fakeDeps();
    const scanner = createScanner(chrome.deps);

    await settle(scanner.scan(1));

    expect(chrome.events).toEqual(['hide 1', 'capture', 'restore 1']);
  });

  describe('頁面沒在產生新畫面（#197：captureVisibleTab 交回十幾秒前的舊 frame）', () => {
    // trace 實際的值：跨頁 a7/a8 翻好、記過帶覆蓋層的樣子後，翻頁換成 a9/a10；那時頁面的 rAF 不跑，
    // 截到的是上一個跨頁帶覆蓋層的舊 frame（hash 跟 overlaid:record 記的一模一樣），新跨頁就被當成翻好的頁
    const A7 = '7dfe25b46d2ce920535933752e09760a709a25dbae372e717120e40f8c1d62f3';
    const A7_OVERLAID = '7dfe65b46d2ce920535937754e09760a708a05db2e372e717122e40b8c1d52fb';
    const A8_OVERLAID = '2aaa9c0663d80d3594c7e17c1e9281f43fc5de7b3168048c9d0bc7b53f3333f0';
    const RIGHT = { x: 1067.666748046875, y: 0, width: 747, height: 1090.510498046875 };
    const LEFT = { x: 320.66668701171875, y: 0, width: 747, height: 1090.510498046875 };

    function turnedSpread() {
      const chrome = fakeDeps([{ anchorId: 'a9', rect: RIGHT }, { anchorId: 'a10', rect: LEFT }]);
      chrome.env.viewport = { width: 2150, height: 1130 };
      // 拍到的是舊 frame：新 anchor 的位置上是上一個跨頁帶覆蓋層的樣子
      chrome.env.cleanHash = { a9: A7_OVERLAID, a10: A8_OVERLAID };
      return chrome;
    }

    it('準備截圖時頁面沒重繪就不截：截到的會是舊 frame，不公布、不丟錯', async () => {
      const chrome = turnedSpread();
      chrome.env.painted = [false, false, false];
      const scanner = createScanner(chrome.deps);

      await settle(scanner.scan(1));

      expect(chrome.captures).toEqual([]);
      expect(chrome.published).toEqual([]);
      // 藏起來的東西照樣還原
      expect(chrome.events.filter((e) => e === 'restore 1')).toHaveLength(3);
    });

    it('重試時頁面重繪了就照常截圖、公布', async () => {
      const chrome = turnedSpread();
      chrome.env.painted = [false];
      chrome.env.cleanHash = { a9: 'new-right', a10: 'new-left' };
      const scanner = createScanner(chrome.deps);

      await settle(scanner.scan(1));

      expect(chrome.captures).toHaveLength(1);
      expect(chrome.published.at(-1)?.[1].map((p) => p.pageHash)).toEqual(['new-right', 'new-left']);
    });

    it('記帶覆蓋層的樣子時頁面沒重繪也不截（記到舊 frame 會把錯的樣子配給這頁）', async () => {
      const chrome = fakeDeps([{ anchorId: 'a7', rect: RIGHT }]);
      chrome.env.cleanHash.a7 = A7;
      const scanner = createScanner(chrome.deps);
      await settle(scanner.scan(1));
      chrome.env.candidates = [{ anchorId: 'a7', rect: RIGHT, overlaid: [A7] }];
      chrome.env.painted = [false];

      await settle(scanner.recordOverlaid(1));

      expect(chrome.captures).toHaveLength(1);
    });
  });

  describe('疊在 Page 上的網站元素（#59）', () => {
    it('不藏覆蓋層的那種截圖也要先藏網站的遮擋物', async () => {
      const chrome = fakeDeps([{ ...P1, overlaid: ['0'.repeat(64)] }]);
      chrome.env.cleanHash.a1 = '0'.repeat(64);
      const scanner = createScanner(chrome.deps);

      await settle(scanner.scan(1));

      // 最後那次是補記帶覆蓋層的樣子
      expect(chrome.events).toEqual(['hide 1', 'capture', 'restore 1', 'prepare 1', 'capture', 'restore 1']);
    });

    it('藏起來的元素在截圖期間被換掉就丟掉截圖、重截', async () => {
      const chrome = fakeDeps();
      chrome.env.stable = [false];
      const scanner = createScanner(chrome.deps);

      await settle(scanner.scan(1));

      expect(chrome.captures).toHaveLength(2);
      expect(chrome.published).toHaveLength(1);
      expect(scanner.getPages(1)[0]!.thumbnail).toBe('thumb(data:image/png;base64,SCREENSHOT2,a1)');
    });
  });

  describe('翻回已翻譯的 Page（#27 除錯：真實 Chrome 截一次圖要 1–2 秒，藏覆蓋層會讓中文閃回日文）', () => {
    const CLEAN = '0'.repeat(64);
    const WITH_OVERLAY = 'f'.repeat(64);
    /** a1 的原圖是 CLEAN；覆蓋層顯示著時截到的是 WITH_OVERLAY。 */
    function page(overlaid: boolean) {
      const chrome = fakeDeps([overlaid ? { ...P1, overlaid: [CLEAN] } : P1]);
      chrome.env.cleanHash.a1 = CLEAN;
      chrome.env.overlaidHash.a1 = WITH_OVERLAY;
      return chrome;
    }
    const publishedHashes = (chrome: ReturnType<typeof fakeDeps>) => chrome.published.at(-1)?.[1].map((p) => p.pageHash);

    it('Spread（一個 anchor 兩頁）不記帶覆蓋層的樣子（記錄以 anchor 為單位，分不出是哪一頁），也就不多截一次', async () => {
      const RIGHT = CLEAN;
      const LEFT = '0f'.repeat(32);
      const chrome = fakeDeps([P1]);
      chrome.deps.crop = async ({ candidates }) =>
        candidates.flatMap((c) => {
          const overlaid = !chrome.env.capturedHidden && (c.overlaid?.length ?? 0) > 0;
          return [
            { anchorId: c.anchorId, rect: c.rect, subRect: { x: 0.5, y: 0, w: 0.5, h: 1 }, thumbnail: 'r', pageHash: overlaid ? WITH_OVERLAY : RIGHT },
            { anchorId: c.anchorId, rect: c.rect, subRect: { x: 0, y: 0, w: 0.5, h: 1 }, thumbnail: 'l', pageHash: LEFT },
          ];
        });
      const scanner = createScanner(chrome.deps);
      await settle(scanner.scan(1));
      chrome.env.candidates = [{ ...P1, overlaid: [RIGHT] }];
      chrome.events.length = 0;
      await settle(scanner.recordOverlaid(1));
      expect(chrome.events).toEqual([]);

      await settle(scanner.scan(1));

      expect(chrome.events).toEqual(['hide 1', 'capture', 'restore 1']);
      expect(publishedHashes(chrome)).toEqual([RIGHT, LEFT]);
    });

    it('Spread 兩頁都顯示著覆蓋層：截圖前一定藏起來（#55：沒藏時截到自己的譯文，hash 對不上）', async () => {
      const LEFT = '0f'.repeat(32);
      const chrome = fakeDeps([{ ...P1, overlaid: [CLEAN, LEFT] }]);
      const scanner = createScanner(chrome.deps);

      await settle(scanner.scan(1));

      expect(chrome.events.slice(0, 3)).toEqual(['hide 1', 'capture', 'restore 1']);
    });

    it('覆蓋層畫好後不藏覆蓋層截一次，記下「帶覆蓋層的樣子」，而且不公布', async () => {
      const chrome = page(false);
      const scanner = createScanner(chrome.deps);
      await settle(scanner.scan(1));
      chrome.env.candidates = [{ ...P1, overlaid: [CLEAN] }];
      chrome.events.length = 0;

      await settle(scanner.recordOverlaid(1));

      expect(chrome.events).toEqual(['prepare 1', 'capture', 'restore 1']);
      expect(chrome.published).toHaveLength(1);
    });

    it('有覆蓋層但還沒記下時照舊藏起來截，截完補記一次', async () => {
      const chrome = page(true);
      const scanner = createScanner(chrome.deps);

      await settle(scanner.scan(1));

      expect(chrome.events).toEqual(['hide 1', 'capture', 'restore 1', 'prepare 1', 'capture', 'restore 1']);
      expect(chrome.published).toHaveLength(1);
    });

    it('記下之後再截圖就不藏覆蓋層，並把 hash 換回原圖的（快取才對得上）', async () => {
      const chrome = page(true);
      const scanner = createScanner(chrome.deps);
      await settle(scanner.scan(1));
      chrome.events.length = 0;

      await settle(scanner.scan(1));

      expect(chrome.events).toEqual(['prepare 1', 'capture', 'restore 1']);
      expect(publishedHashes(chrome)).toEqual([CLEAN]);
    });

    it('對不上帶覆蓋層的樣子（覆蓋層底下的頁換了）就藏起來重截', async () => {
      const chrome = page(true);
      const scanner = createScanner(chrome.deps);
      await settle(scanner.scan(1));
      chrome.events.length = 0;
      const NEW_PAGE = '5'.repeat(64);
      chrome.env.cleanHash.a1 = NEW_PAGE;
      chrome.env.overlaidHash.a1 = 'a'.repeat(64);

      await settle(scanner.scan(1));

      expect(chrome.events.slice(0, 6)).toEqual(['prepare 1', 'capture', 'restore 1', 'hide 1', 'capture', 'restore 1']);
      expect(publishedHashes(chrome)).toEqual([NEW_PAGE]);
    });

    it('已經記過同一頁（翻回來命中快取、覆蓋層重畫）就不再截', async () => {
      const chrome = page(true);
      const scanner = createScanner(chrome.deps);
      await settle(scanner.scan(1));
      chrome.events.length = 0;

      await settle(scanner.recordOverlaid(1));

      expect(chrome.events).toEqual([]);
    });

    it('上次截到的不是覆蓋層顯示的那頁就不記（免得把錯的頁配上去）', async () => {
      const chrome = page(false);
      const scanner = createScanner(chrome.deps);
      await settle(scanner.scan(1));
      chrome.env.candidates = [{ ...P1, overlaid: ['5'.repeat(64)] }];
      chrome.events.length = 0;

      await settle(scanner.recordOverlaid(1));
      await settle(scanner.scan(1));

      expect(chrome.events.slice(-3)).toEqual(['hide 1', 'capture', 'restore 1']);
    });

    it('要重新辨識的掃描（重新翻譯）記過樣子也藏覆蓋層：OCR 才不會讀到自己的譯文', async () => {
      const chrome = page(true);
      const scanner = createScanner(chrome.deps);
      await settle(scanner.scan(1));
      chrome.events.length = 0;

      await settle(scanner.scan(1, { hideOverlay: true }));

      expect(chrome.events).toEqual(['hide 1', 'capture', 'restore 1']);
      expect(chrome.publishedCaptures.at(-1)?.overlayShown).toBe(false);
      expect(publishedHashes(chrome)).toEqual([CLEAN]);
    });

    it('要藏覆蓋層的掃描併進還沒開始的掃描時，那次也藏', async () => {
      const chrome = page(true);
      const scanner = createScanner(chrome.deps);
      await settle(scanner.scan(1));
      chrome.events.length = 0;

      const first = scanner.scan(1);
      const second = scanner.scan(1, { hideOverlay: true });
      await settle(Promise.all([first, second]));

      expect(chrome.events).toEqual(['hide 1', 'capture', 'restore 1']);
    });

    it('不藏覆蓋層截到的那次公布時註明 overlayShown，後面就知道這張截圖不能拿去辨識', async () => {
      const chrome = page(true);
      const scanner = createScanner(chrome.deps);
      await settle(scanner.scan(1));

      await settle(scanner.scan(1));

      expect(chrome.publishedCaptures.at(-1)?.overlayShown).toBe(true);
    });

    it('clear 之後忘掉帶覆蓋層的樣子', async () => {
      const chrome = page(true);
      const scanner = createScanner(chrome.deps);
      await settle(scanner.scan(1));
      scanner.clear(1);
      chrome.events.length = 0;

      await settle(scanner.scan(1));

      expect(chrome.events.slice(0, 3)).toEqual(['hide 1', 'capture', 'restore 1']);
    });
  });

  it('截圖前的準備失敗也會還原（網站的元素不會一直藏著），而且丟出原本的錯誤', async () => {
    const chrome = fakeDeps();
    const scanner = createScanner({
      ...chrome.deps,
      prepareCapture: async () => {
        chrome.events.push('prepare failed');
        throw new Error('prepare failed');
      },
      finishCapture: async () => {
        chrome.events.push('restore');
        throw new Error('content script gone');
      },
    });

    await expect(settle(scanner.scan(1))).rejects.toThrow('prepare failed');

    expect(chrome.events).toEqual(['prepare failed', 'restore']);
  });

  it('截圖失敗也會還原覆蓋層', async () => {
    const chrome = fakeDeps();
    const scanner = createScanner({
      ...chrome.deps,
      captureWindow: async () => {
        chrome.events.push('capture');
        throw new Error('capture failed');
      },
    });

    await expect(settle(scanner.scan(1))).rejects.toThrow('capture failed');

    expect(chrome.events).toEqual(['hide 1', 'capture', 'restore 1']);
  });
});
