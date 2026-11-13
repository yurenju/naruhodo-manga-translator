import { describe, expect, it } from 'vitest';
import type { PageView } from '../shared/messages.ts';
import type { PageText, RatioRect } from '../shared/page-text.ts';
import { createOverlaySync } from './overlay-sync.ts';

const TEXT: PageText = { balloons: [], looseText: [] };
const page = (anchorId: string, transcript: PageView['transcript'], pageHash = '0'.repeat(64)): PageView => ({
  anchorId,
  rect: { x: 0, y: 0, width: 430, height: 625 },
  thumbnail: 'data:',
  pageHash,
  transcript,
});

function setup() {
  const shown: [number, string, PageText][] = [];
  const pageHashes: string[] = [];
  const subs: (RatioRect | undefined)[] = [];
  const removed: { tabId: number; anchorId: string; pageHashes: string[] }[] = [];
  const confirmed: { tabId: number; anchorId: string }[] = [];
  const sync = createOverlaySync({
    show: ({ tabId, anchorId, pageHash, subRect, text }) => {
      shown.push([tabId, anchorId, text]);
      pageHashes.push(pageHash);
      subs.push(subRect);
    },
    remove: (r) => removed.push(r),
    confirm: (c) => confirmed.push(c),
  });
  return { sync, shown, pageHashes, subs, removed, confirmed };
}

describe('overlay sync', () => {
  it('Page 翻好時把譯文送給 content script 覆蓋，同一份結果只送一次', () => {
    const { sync, shown } = setup();
    const done: PageView['transcript'] = { state: 'done', text: TEXT, translated: true };

    sync.publish(1, [page('a1', done), page('a2', { state: 'analyzing' })]);
    sync.publish(1, [page('a1', done), page('a2', { state: 'analyzing' })]);

    expect(shown).toEqual([[1, 'a1', TEXT]]);
  });

  it('沒有譯文（沒有 API key）或辨識失敗的 Page 不覆蓋', () => {
    const { sync, shown } = setup();

    sync.publish(1, [page('a1', { state: 'done', text: TEXT, translated: false }), page('a2', { state: 'error', message: 'x' })]);

    expect(shown).toEqual([]);
  });

  it('同一個 anchor 有新的翻譯結果時再送一次', () => {
    const { sync, shown } = setup();
    const other: PageText = { balloons: [], looseText: [] };

    sync.publish(1, [page('a1', { state: 'done', text: TEXT, translated: true })]);
    sync.publish(1, [page('a1', { state: 'done', text: other, translated: true })]);

    expect(shown.map(([, , text]) => text)).toEqual([TEXT, other]);
  });

  it('同一個 anchor 上的兩個 Page（Spread）各自帶上 Page 身分，hover 同步才分得出是哪一頁', () => {
    const { sync, pageHashes } = setup();
    const left: PageText = { balloons: [], looseText: [] };
    const right: PageText = { balloons: [], looseText: [] };

    sync.publish(1, [page('a1', { state: 'done', text: left, translated: true }, 'aa'.repeat(32)), page('a1', { state: 'done', text: right, translated: true }, 'bb'.repeat(32))]);

    expect(pageHashes).toEqual(['aa'.repeat(32), 'bb'.repeat(32)]);
  });

  it('Spread 的一頁帶上它在 anchor 裡的範圍（subRect）', () => {
    const { sync, subs } = setup();
    const sub = { x: 0.5, y: 0, w: 0.5, h: 1 };

    sync.publish(1, [{ ...page('a1', { state: 'done', text: TEXT, translated: true }), subRect: sub }]);

    expect(subs).toEqual([sub]);
  });

  it('同一頁、同一份結果，但這次擷取量到的 subRect 不一樣（視窗大小變了、合成圖重畫）：帶新的 subRect 再送一次', () => {
    const { sync, subs } = setup();
    const done: PageView['transcript'] = { state: 'done', text: TEXT, translated: true };
    const stale = { x: 0.5, y: 0.17, w: 0.5, h: 0.65 };
    const fresh = { x: 0.5, y: 0.27, w: 0.5, h: 0.45 };

    sync.publish(1, [{ ...page('a1', done), subRect: stale }]);
    sync.publish(1, [{ ...page('a1', done), subRect: fresh }]);
    sync.publish(1, [{ ...page('a1', done), subRect: { ...fresh } }]);

    expect(subs).toEqual([stale, fresh]);
  });

  it('重新擷取時 anchor 上已經沒有這頁的覆蓋（例如 img 換了 src 又換回來、視窗大小變了重畫）：再送一次', () => {
    const { sync, shown } = setup();
    const done: PageView['transcript'] = { state: 'done', text: TEXT, translated: true };

    sync.publish(1, [page('a1', done)]);
    sync.captured(1, [page('a1', done)]);
    sync.publish(1, [page('a1', done)]);

    expect(shown).toHaveLength(2);
  });

  it('重新擷取時 anchor 上還顯示著這頁：不重送', () => {
    const { sync, shown } = setup();
    const done: PageView['transcript'] = { state: 'done', text: TEXT, translated: true };
    const hash = '0'.repeat(64);

    sync.publish(1, [page('a1', done)]);
    sync.captured(1, [{ ...page('a1', done), overlaid: [hash] }]);
    sync.publish(1, [page('a1', done)]);

    expect(shown).toHaveLength(1);
  });

  it('這次擷取沒看到那個 anchor（捲走了）：覆蓋還掛在它上面，捲回來時不重送', () => {
    const { sync, shown } = setup();
    const done: PageView['transcript'] = { state: 'done', text: TEXT, translated: true };

    sync.publish(1, [page('a1', done)]);
    sync.captured(1, [page('a2', { state: 'analyzing' }, 'f'.repeat(64))]);
    sync.publish(1, [page('a1', done)]);

    expect(shown).toHaveLength(1);
  });

  // #276：電子書閱讀器兩張 canvas 輪流畫頁，canvas 重畫沒有 src 可看；截圖才知道 anchor 上已經換頁
  describe('擷取到的 anchor 上換了別的 Page（覆蓋層還是舊的）', () => {
    const done: PageView['transcript'] = { state: 'done', text: TEXT, translated: true };
    const OLD_RIGHT = 'a'.repeat(64);
    const OLD_LEFT = 'b'.repeat(64);
    const NEW_RIGHT = '1'.repeat(64);
    const NEW_LEFT = '2'.repeat(64);

    it('Spread：兩頁都換了，兩層舊覆蓋一起拿掉，不等新頁翻好；沒有剩下的層要確認', () => {
      const { sync, removed, confirmed } = setup();
      const overlaid = [OLD_RIGHT, OLD_LEFT];

      sync.captured(1, [{ ...page('a1', { state: 'analyzing' }, NEW_RIGHT), overlaid }, { ...page('a1', { state: 'analyzing' }, NEW_LEFT), overlaid }]);

      expect(removed).toEqual([{ tabId: 1, anchorId: 'a1', pageHashes: [OLD_RIGHT, OLD_LEFT] }]);
      expect(confirmed).toEqual([]);
    });

    it('還是同一頁（hash 只差一點）：不拿掉，確認覆蓋層可以顯示（anchor 重新出現時先藏著等這個）', () => {
      const { sync, removed, confirmed } = setup();
      const nearlySame = `${'0'.repeat(63)}1`;

      sync.captured(1, [{ ...page('a1', done), overlaid: [nearlySame] }]);

      expect(removed).toEqual([]);
      expect(confirmed).toEqual([{ tabId: 1, anchorId: 'a1' }]);
    });

    it('只換了一頁：只拿掉換掉的那層，另一層確認', () => {
      const { sync, removed, confirmed } = setup();
      const overlaid = [OLD_RIGHT, OLD_LEFT];

      sync.captured(1, [{ ...page('a1', done, OLD_RIGHT), overlaid }, { ...page('a1', { state: 'analyzing' }, NEW_LEFT), overlaid }]);

      expect(removed).toEqual([{ tabId: 1, anchorId: 'a1', pageHashes: [OLD_LEFT] }]);
      expect(confirmed).toEqual([{ tabId: 1, anchorId: 'a1' }]);
    });

    it('長 Page（visible）不比：它的 pageHash 是橫條，不是 Page 身分；直接確認', () => {
      const { sync, removed, confirmed } = setup();
      const visible = { x: 0, y: 0, width: 430, height: 300 };

      sync.captured(1, [{ ...page('a1', { state: 'analyzing' }, NEW_RIGHT), visible, overlaid: [OLD_RIGHT] }]);

      expect(removed).toEqual([]);
      expect(confirmed).toEqual([{ tabId: 1, anchorId: 'a1' }]);
    });

    it('anchor 上沒有覆蓋層：不拿也不確認', () => {
      const { sync, removed, confirmed } = setup();

      sync.captured(1, [page('a1', { state: 'analyzing' }, NEW_RIGHT)]);

      expect(removed).toEqual([]);
      expect(confirmed).toEqual([]);
    });

    it('拿掉之後同一頁換回這個 anchor：再送一次', () => {
      const { sync, shown } = setup();

      sync.publish(1, [page('a1', done, OLD_RIGHT)]);
      sync.captured(1, [{ ...page('a1', { state: 'analyzing' }, NEW_RIGHT), overlaid: [OLD_RIGHT] }]);
      sync.publish(1, [page('a1', done, OLD_RIGHT)]);

      expect(shown).toHaveLength(2);
    });
  });
});

describe('直式排版的一串：跨過交界的 Line 兩邊的元素都畫（#282）', () => {
  // 真實網站量到的版面：canvas 800×1000 上下緊貼；對白框歸下面那個元素，上緣伸到上面那個元素裡
  const column = { id: 'c1', region: { x: 209, y: 0, width: 800, height: 924 }, cutTop: true, cutBottom: true };
  const crossing: PageText = {
    balloons: [
      {
        id: 'b1',
        order: 1,
        balloonBbox: { x: 0.4, y: -0.145, w: 0.22, h: 0.367 },
        textBbox: { x: 0.45, y: -0.1, w: 0.12, h: 0.3 },
        orientation: 'vertical',
        原文: 'おはよう',
        讀音: '',
        讀音來源: 'kuromoji',
        譯文: '早安',
        unreadable: false,
      },
    ],
    looseText: [],
  };
  const member = (anchorId: string, y: number, hash: string, transcript: PageView['transcript']): PageView => ({
    anchorId,
    rect: { x: 209, y, width: 800, height: 1000 },
    visible: { x: 209, y: Math.max(0, y), width: 800, height: 400 },
    thumbnail: 'data:',
    pageHash: hash,
    column,
    transcript,
  });

  it('上面那個元素還沒有自己的譯文也畫伸過來的那一句，位置換成它自己的座標；內容沒變不重送', () => {
    const { sync, shown } = setup();
    const pages = [
      member('a7', -600, '0'.repeat(64), { state: 'done', text: TEXT, translated: false }),
      member('a8', 400, 'f'.repeat(64), { state: 'done', text: crossing, translated: true }),
    ];

    sync.publish(1, pages);
    sync.publish(1, pages);

    expect(shown.map(([, anchorId]) => anchorId)).toEqual(['a7', 'a8']);
    const [onUpper] = shown[0]![2].balloons;
    expect(onUpper).toMatchObject({ id: 'b1@a8', 譯文: '早安' });
    expect(onUpper!.balloonBbox.y).toBeCloseTo(0.855);
    expect(onUpper!.balloonBbox.h).toBeCloseTo(0.367);
    expect(shown[1]![2]).toBe(crossing);
  });

  it('沒有伸到隔壁的 Line、不在一串裡的 Page 照舊', () => {
    const { sync, shown } = setup();
    const inside: PageText = { ...crossing, balloons: [{ ...crossing.balloons[0]!, balloonBbox: { x: 0.4, y: 0.3, w: 0.2, h: 0.2 } }] };

    sync.publish(1, [
      member('a7', -600, '0'.repeat(64), { state: 'done', text: TEXT, translated: false }),
      member('a8', 400, 'f'.repeat(64), { state: 'done', text: inside, translated: true }),
    ]);

    expect(shown.map(([, anchorId]) => anchorId)).toEqual(['a8']);
  });
});
