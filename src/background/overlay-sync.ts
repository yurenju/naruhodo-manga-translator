/**
 * 翻好的 Page → content script 原地覆蓋（spec #27 第 3 節最後一步）。
 * 沒有譯文（沒有 API key）時不覆蓋（第 5 節）；unreadable 與 Loose Text 由 content script 略過。
 */
import type { PageCandidate, PageOnAnchor, PageView } from '../shared/messages.ts';
import { findSamePage } from '../shared/page-hash.ts';
import type { PageText, RatioRect } from '../shared/page-text.ts';

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
}

/** 送過的一筆：哪個 anchor 上的哪一頁、送的是哪一份結果、蓋在 anchor 的哪個範圍。 */
interface Sent extends PageOnAnchor {
  text: PageText;
  subRect?: RatioRect;
}

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
      if (transcript.state !== 'done' || !transcript.translated) continue;
      if (list.some((s) => s.text === transcript.text && isSamePage(s, page) && sameSubRect(s.subRect, page.subRect))) continue;
      const others = list.filter((s) => !isSamePage(s, page));
      list.splice(0, list.length, ...others, { anchorId: page.anchorId, pageHash: page.pageHash, text: transcript.text, subRect: page.subRect });
      deps.show({ tabId, anchorId: page.anchorId, pageHash: page.pageHash, subRect: page.subRect, text: transcript.text });
    }
    sent.set(tabId, list);
  }

  /**
   * 每次擷取後：擷取到的 anchor 只記得上面確實還顯示著的覆蓋（PageCandidate.overlaid）。content script 清掉的
   * （img 換了 src、電子書閱讀器視窗大小變了重新產生合成圖）下次 publish 會重送，同一頁換回來時覆蓋才回得來。
   * 截圖認出 anchor 上已經換成別頁、覆蓋層卻還是舊的（canvas 重畫沒有 src 可看，#276）：馬上拿掉舊層，不等新頁翻好。
   */
  function captured(tabId: number, pages: readonly PageThumbLike[]): void {
    for (const { anchorId, pageHashes } of staleOverlays(pages)) {
      deps.remove({ tabId, anchorId, pageHashes });
      sent.set(tabId, (sent.get(tabId) ?? []).filter((s) => s.anchorId !== anchorId || !pageHashes.includes(s.pageHash)));
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
 * 每個擷取到的 anchor 上，覆蓋層顯示的 Page 已經不在這次截圖裡的那幾頁。長 Page（visible）不算：
 * 它的 pageHash 是第一條橫條、不是 Page 身分（spec #142）。
 */
export function staleOverlays(pages: readonly PageThumbLike[]): { anchorId: string; pageHashes: string[] }[] {
  const anchors = new Map<string, PageThumbLike[]>();
  for (const page of pages) if (!page.visible) anchors.set(page.anchorId, [...(anchors.get(page.anchorId) ?? []), page]);
  return [...anchors].flatMap(([anchorId, onAnchor]) => {
    const pageHashes = (onAnchor[0]?.overlaid ?? []).filter((hash) => !findSamePage(onAnchor, hash));
    return pageHashes.length > 0 ? [{ anchorId, pageHashes }] : [];
  });
}
