/**
 * 把每個 tab 的 Page 狀態（shared/page-status.ts）送到 content script、設成圖示 badge（#185）。
 * 依據：transcriber 每次 publish 的 PageView、工作送出 LLM 的事件、offscreen 廣播的模型狀態、額度快用完了沒（#237）。
 * 內容沒變就不重送（模型下載進度、每次擷取都會觸發）。
 */
import type { ModelStatus, PageView } from '../shared/messages.ts';
import { pageStatus, untranslatedWithoutReason, type ActionBadge, type AnchorStatus, type PageStatusInput } from '../shared/page-status.ts';
import type { JobEvent } from './transcribe.ts';

export interface PageStatusSyncDeps {
  send(tabId: number, anchors: AnchorStatus[]): void;
  /** undefined＝沒啟動，拿掉 badge。 */
  setBadge(tabId: number, badge: ActionBadge | undefined): void;
  /** 現在不能翻譯的原因；只在有 Page 沒翻譯、也沒有別的原因時才問。 */
  accessProblem(): Promise<PageStatusInput['access']>;
}

interface TabStatus {
  pages: PageView[];
  /** 已經送出 LLM、還沒做完的 Page。 */
  translating: Set<string>;
  /** 上次送出的內容與 badge；undefined＝還沒送過（或 content script 換新的了）。 */
  sent?: string;
  badge?: ActionBadge;
}

export function createPageStatusSync(deps: PageStatusSyncDeps) {
  const tabs = new Map<number, TabStatus>();
  let model: ModelStatus = { state: 'idle' };
  /** 內建翻譯的額度快用完（#237）：全域的，每個 tab 的綠點都換成橘點。 */
  let lowQuota = false;

  async function refresh(tabId: number): Promise<void> {
    const tab = tabs.get(tabId);
    if (!tab) return;
    const access = tab.pages.some(untranslatedWithoutReason) ? await deps.accessProblem() : undefined;
    // 期間停止了
    if (tabs.get(tabId) !== tab) return;
    const { anchors, badge } = pageStatus({ pages: tab.pages, model, translating: tab.translating, access, lowQuota });
    const sent = JSON.stringify(anchors);
    if (sent !== tab.sent) {
      tab.sent = sent;
      deps.send(tabId, anchors);
    }
    if (badge !== tab.badge) {
      tab.badge = badge;
      deps.setBadge(tabId, badge);
    }
  }

  return {
    /** 沒啟動的 tab 不算（停止時 transcriber 還會 publish 一次空的）。 */
    pagesUpdated(tabId: number, pages: PageView[]): Promise<void> {
      const tab = tabs.get(tabId);
      if (!tab) return Promise.resolve();
      tab.pages = pages;
      return refresh(tabId);
    },
    jobEvent({ tabId, event, pageHash }: JobEvent): Promise<void> {
      const tab = tabs.get(tabId);
      if (!tab) return Promise.resolve();
      if (event === 'llm') tab.translating.add(pageHash);
      else if (event === 'done' || event === 'drop') tab.translating.delete(pageHash);
      else return Promise.resolve();
      return refresh(tabId);
    },
    async modelStatus(status: ModelStatus): Promise<void> {
      model = status;
      await Promise.all([...tabs.keys()].map(refresh));
    },
    /** 能不能翻譯可能變了（同意、登入、模式）。 */
    async accessChanged(): Promise<void> {
      await Promise.all([...tabs.keys()].map(refresh));
    },
    /** 剩餘額度變了（#237）：快用完時已啟動的 tab 都換成橘點，額度又夠了換回綠點。 */
    async quotaChanged(low: boolean): Promise<void> {
      lowQuota = low;
      await Promise.all([...tabs.keys()].map(refresh));
    },
    /** 啟動：badge 是小點。 */
    activated(tabId: number): Promise<void> {
      if (!tabs.has(tabId)) tabs.set(tabId, { pages: [], translating: new Set() });
      return refresh(tabId);
    },
    /** 重新整理、換頁：content script 是新的（圖示的 tab 專屬 badge 也被 Chrome 清掉），之後的狀態都重送。 */
    reset(tabId: number): void {
      const tab = tabs.get(tabId);
      if (!tab) return;
      tab.sent = undefined;
      tab.badge = undefined;
      tab.translating.clear();
    },
    /** 停止或關 tab。 */
    clear(tabId: number): void {
      if (!tabs.delete(tabId)) return;
      deps.setBadge(tabId, undefined);
    },
  };
}
