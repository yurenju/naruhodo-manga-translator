/**
 * 翻好的 Page → content script 原地覆蓋（spec #27 第 3 節最後一步）。
 * 沒有譯文（沒有 API key）時不覆蓋（第 5 節）；unreadable 與 Loose Text 由 content script 略過。
 */
import { spilledLines } from '../shared/long-page.ts';
import type { PageCandidate, PageOnAnchor, PageView } from '../shared/messages.ts';
import { findSamePage } from '../shared/page-hash.ts';
import { overlaidTexts, type PageText, type RatioRect } from '../shared/page-text.ts';

/** 一個翻好的 Page 要覆蓋到哪：anchor（元素）＋ subRect（Page 在 anchor 裡的範圍）＋ pageHash（Page 身分，hover 同步用）。 */
export interface OverlayShow extends PageOnAnchor {
  tabId: number;
  subRect?: RatioRect;
  text: PageText;
}

export interface OverlaySyncDeps {
  show(show: OverlayShow): void;
  /** 拿掉 anchor 上這幾頁的覆蓋層（截圖看到 anchor 上已經不是它們了）。 */
  remove(remove: { tabId: number; anchorId: string; pageHashes: string[] }): void;
  /** anchor 上剩下的覆蓋層截圖確認過還是同一頁：anchor 重新出現時先藏著的層可以顯示了。 */
  confirm(confirm: { tabId: number; anchorId: string }): void;
}

/** 送過的一筆：哪個 anchor 上的哪一頁、送的是哪一份結果、蓋在 anchor 的哪個範圍。 */
interface Sent extends PageOnAnchor {
  text: PageText;
  subRect?: RatioRect;
  /** 隔壁元素伸過來的 Line（直式排版的一串，#282）：內容一樣就不重送。 */
  spill: string;
}

const EMPTY: PageText = { balloons: [], looseText: [] };

/**
 * 直式排版的一串（#282）裡，同一串其他元素翻好、要覆蓋的 Line 伸到這個元素上的部分（這個元素的座標）。
 * 不在一串裡、或沒有伸過來的是空的。
 */
export function spillOnto(page: PageView, pages: readonly PageView[]): PageText {
  const spill: PageText = { balloons: [], looseText: [] };
  if (!page.column) return spill;
  for (const other of pages) {
    const { transcript } = other;
    if (other === page || other.column?.id !== page.column.id || transcript.state !== 'done' || !transcript.translated) continue;
    const lines = spilledLines(overlaidTexts(transcript.text), other.rect, page.rect, `@${other.anchorId}`);
    spill.balloons.push(...lines.balloons);
    spill.looseText.push(...lines.looseText);
  }
  return spill;
}

/** 伸過來的 Line 的內容（不含擦除小圖）：位置或譯文變了才重送。 */
const spillKey = ({ balloons, looseText }: PageText) =>
  JSON.stringify([...balloons.map((b) => [b.id, b.譯文, b.balloonBbox]), ...looseText.map((l) => [l.id, l.譯文, l.bbox])]);

/**
 * 同一個範圍。視窗大小一變，合成圖重畫前後的截圖會量到不一樣的 subRect（同一頁、hash 一樣）；
 * 結果比較早翻好時用的是舊截圖量的，下一次擷取量到新的就要重送，覆蓋才不會留在舊的位置。
 */
const sameSubRect = (a: RatioRect | undefined, b: RatioRect | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

export function createOverlaySync(deps: OverlaySyncDeps) {
  /** 每個 tab 送過、應該還顯示著的覆蓋；transcriber 每次 publish 都帶整串 Page，同一份結果不重送。 */
  const sent = new Map<number, Sent[]>();

  const isSamePage = (s: PageOnAnchor, page: PageOnAnchor) =>
    s.anchorId === page.anchorId && findSamePage([s], page.pageHash) !== undefined;

  function publish(tabId: number, pages: readonly PageView[]): void {
    const list = sent.get(tabId) ?? [];
    for (const page of pages) {
      const { transcript } = page;
      const spill = spillOnto(page, pages);
      const spilled = spill.balloons.length + spill.looseText.length > 0;
      const translated = transcript.state === 'done' && transcript.translated;
      // 自己還沒翻好、但隔壁有 Line 伸過來的元素也要畫（只畫伸過來的）
      if (!translated && !spilled) continue;
      const own = translated ? transcript.text : EMPTY;
      const key = spillKey(spill);
      if (list.some((s) => s.text === own && s.spill === key && isSamePage(s, page) && sameSubRect(s.subRect, page.subRect))) continue;
      const others = list.filter((s) => !isSamePage(s, page));
      list.splice(0, list.length, ...others, { anchorId: page.anchorId, pageHash: page.pageHash, text: own, subRect: page.subRect, spill: key });
      const text = spilled ? { balloons: [...own.balloons, ...spill.balloons], looseText: [...own.looseText, ...spill.looseText] } : own;
      deps.show({ tabId, anchorId: page.anchorId, pageHash: page.pageHash, subRect: page.subRect, text });
    }
    sent.set(tabId, list);
  }

  /**
   * 每次擷取後：擷取到的 anchor 只記得上面確實還顯示著的覆蓋（PageCandidate.overlaid）。content script 清掉的
   * （img 換了 src、電子書閱讀器視窗大小變了重新產生合成圖）下次 publish 會重送，同一頁換回來時覆蓋才回得來。
   * 截圖認出 anchor 上已經換成別頁、覆蓋層卻還是舊的（canvas 重畫沒有 src 可看，#276）：馬上拿掉舊層，不等新頁翻好；
   * 剩下的層確認可以顯示（content script 在 anchor 重新出現時先藏著，等這次截圖）。
   */
  function captured(tabId: number, pages: readonly PageThumbLike[]): void {
    for (const { anchorId, stale, kept } of verifyOverlays(pages)) {
      if (stale.length > 0) {
        deps.remove({ tabId, anchorId, pageHashes: stale });
        sent.set(tabId, (sent.get(tabId) ?? []).filter((s) => s.anchorId !== anchorId || !stale.includes(s.pageHash)));
      }
      if (kept.length > 0) deps.confirm({ tabId, anchorId });
    }
    // 這次沒擷取到的 anchor（捲走了）不知道，當作還顯示著
    const isStillShown = (s: Sent) => {
      const onAnchor = pages.filter((p) => p.anchorId === s.anchorId);
      return onAnchor.length === 0 || onAnchor.some((p) => findSamePage((p.overlaid ?? []).map((pageHash) => ({ pageHash })), s.pageHash));
    };
    sent.set(tabId, (sent.get(tabId) ?? []).filter(isStillShown));
  }

  return { publish, captured };
}

/** 擷取到的一頁：哪個 anchor、截圖算出的 Page 身分、anchor 上顯示著哪幾頁的覆蓋層。 */
type PageThumbLike = PageCandidate & { pageHash: string };

/**
 * 每個擷取到、有覆蓋層的 anchor：覆蓋層顯示的 Page 哪些已經不在這次截圖裡（stale），哪些還在（kept）。
 * 長 Page（visible）不比，全部算 kept：它的 pageHash 是第一條橫條、不是 Page 身分（spec #142）。
 */
export function verifyOverlays(pages: readonly PageThumbLike[]): { anchorId: string; stale: string[]; kept: string[] }[] {
  const anchors = new Map<string, PageThumbLike[]>();
  for (const page of pages) anchors.set(page.anchorId, [...(anchors.get(page.anchorId) ?? []), page]);
  return [...anchors].flatMap(([anchorId, onAnchor]) => {
    const overlaid = onAnchor[0]?.overlaid ?? [];
    if (overlaid.length === 0) return [];
    if (onAnchor.some((page) => page.visible)) return [{ anchorId, stale: [], kept: overlaid }];
    const stale = overlaid.filter((hash) => !findSamePage(onAnchor, hash));
    return [{ anchorId, stale, kept: overlaid.filter((hash) => !stale.includes(hash)) }];
  });
}
