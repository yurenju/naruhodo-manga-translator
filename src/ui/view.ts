import { FREE_PAGES, LOW_QUOTA, MONTHLY_PAGES, type Quota } from '../shared/hosted-api.ts';
import type { PageView } from '../shared/messages.ts';
import type { SeriesOption } from '../shared/series.ts';
import type { TranslationMode } from '../shared/translation-mode.ts';
import type { BadgeTone } from './components.tsx';

/** Page 在 Spread 裡的哪一邊；undefined＝不是 Spread。 */
export type SpreadSide = 'right' | 'left';

/** 頁首：單頁是「第 N 頁」；Spread 是「右頁」＋「先讀」。 */
export interface PageHeading {
  title: string;
  order?: string;
}

/** side panel 列出的一個 Page。 */
export interface PageEntry {
  page: PageView;
  side: SpreadSide | undefined;
  heading: PageHeading;
  /** 頁首右側的翻譯狀態；undefined＝不顯示。 */
  translationStatus: string | undefined;
}

/** 底部狀態列：翻譯中、或已翻譯的摘要；undefined＝沒有譯文，不顯示。 */
export type OverallStatus = { kind: 'translating' } | { kind: 'summary'; text: string } | undefined;

/** side panel 該顯示什麼（元件只負責畫出來）。 */
export interface SidePanelView {
  pages: PageEntry[];
  status: OverallStatus;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

const centerX = (page: PageView) => page.subRect && page.subRect.x + page.subRect.w / 2;

type OrderedPage = { page: PageView; side: SpreadSide | undefined };

/**
 * side panel 列 Page 的順序與每頁在 Spread 裡的哪一邊（spec #70）。同一個 anchor 切出兩個 Page 才是 Spread：
 * subRect 中心偏右的是右頁、排在前面（日漫由右往左讀），不依賴 SW 給的順序。只看 subRect 不夠：單頁去黑邊後也有
 * subRect。同一個 anchor 的兩個 Page 分不出左右（沒有 subRect）就不標左右，照 SW 的順序。
 */
function readingOrder(pages: PageView[]): OrderedPage[] {
  const byAnchor = new Map<string, PageView[]>();
  for (const page of pages) byAnchor.set(page.anchorId, [...(byAnchor.get(page.anchorId) ?? []), page]);
  return [...byAnchor.values()].flatMap((group): OrderedPage[] => {
    const [a, b] = group;
    const ax = a && centerX(a);
    const bx = b && centerX(b);
    if (group.length !== 2 || ax === undefined || bx === undefined || ax === bx)
      return group.map((page) => ({ page, side: undefined }));
    const [right, left] = ax > bx ? [a!, b!] : [b!, a!];
    return [
      { page: right, side: 'right' },
      { page: left, side: 'left' },
    ];
  });
}

function heading(side: SpreadSide | undefined, number: number): PageHeading {
  if (side === undefined) return { title: `第 ${number} 頁` };
  return side === 'right' ? { title: '右頁', order: '先讀' } : { title: '左頁', order: '後讀' };
}

/**
 * 「已翻譯」或「快取」・模型・秒數・費用（spec #27 第 8 節）；快取時是當初翻譯的模型與數字。翻好、沒在重翻也沒失敗才顯示。
 * 內建翻譯不顯示模型與費用（#92 畫面定案），只有秒數。
 */
function translationStatus({ transcript }: PageView, mode: TranslationMode): string | undefined {
  if (transcript.state !== 'done' || !transcript.translation || transcript.translating || transcript.translateError) return undefined;
  const { source, model, latencyMs, usage } = transcript.translation;
  const label = source === 'cache' ? '快取' : '已翻譯';
  if (mode === 'hosted') return `${label}・${seconds(latencyMs)}`;
  return `${label}・${model}・${seconds(latencyMs)}・$${usage.costUsd.toFixed(4)}`;
}

const dollars = (usd: number) => (Number.isNaN(usd) ? '費用未知' : `$${usd.toFixed(5)}`);

/** 底部狀態列（spec #27 第 8 節）：已翻譯・模型・秒數・費用。多個 Page 時加總。內建翻譯不顯示模型與費用。 */
function overallStatus(pages: PageView[], mode: TranslationMode): OverallStatus {
  const done = pages.flatMap((p) => (p.transcript.state === 'done' ? [p.transcript] : []));
  if (done.some((t) => t.translating)) return { kind: 'translating' };
  const infos = done.flatMap((t) => (t.translated && t.translation ? [t.translation] : []));
  if (infos.length === 0) return undefined;
  // 這頁的提示在逐字稿上方；狀態列只說有更新（#38）
  const notesUpdated = done.some((t) => t.stale === 'notes');
  const models = [...new Set(infos.map((i) => i.model))].join('、');
  const latency = infos.reduce((sum, i) => sum + i.latencyMs, 0);
  const cost = infos.reduce((sum, i) => sum + i.usage.costUsd, 0);
  const prefix = `${notesUpdated ? '角色與用語已更新 · ' : ''}已翻譯 ${infos.length} 頁`;
  const text = mode === 'hosted' ? `${prefix} · ${seconds(latency)}` : `${prefix} · ${models} · ${seconds(latency)} · ${dollars(cost)}`;
  return { kind: 'summary', text };
}

export function sidePanelView(pages: PageView[], mode: TranslationMode): SidePanelView {
  return {
    pages: readingOrder(pages).map(({ page, side }, i) => ({
      page,
      side,
      heading: heading(side, i + 1),
      translationStatus: translationStatus(page, mode),
    })),
    status: overallStatus(pages, mode),
  };
}

/** 能不能翻譯取決於翻譯模式（spec #86）：內建翻譯看有沒有登入，自備金鑰看有沒有 key。 */
export type TranslationAccess = { mode: 'hosted'; signedIn: boolean } | { mode: 'ownKey'; hasKey: boolean };

/** 現在送得出翻譯嗎：目前翻譯模式已登入／有 key，而且同意了。不能時「翻譯此頁」按了也沒用，改由設定提示帶路。 */
export function canTranslate(access: TranslationAccess, consented: boolean | undefined): boolean {
  return consented === true && (access.mode === 'hosted' ? access.signedIn : access.hasKey);
}

/**
 * 逐字稿上方的提示：signedOut＝「尚未登入」（內建翻譯），noKey＝「尚未設定 API key」（自備金鑰），
 * hostedHint＝「現在也可以改用內建翻譯」（從舊版更新、仍用自備金鑰，只出現一次，#93）。
 */
export type SetupNotice = 'signedOut' | 'noKey' | 'hostedHint' | undefined;

/**
 * 翻譯前的設定提示（#91）。同意依翻譯模式各自記（shared/data-consent.ts），consented 是目前模式的。
 * 自備金鑰用說明卡問；內建翻譯的同意在登入時取得（按「同意並寄送驗證碼」），所以有 token 但同意失效時也算「尚未登入」。
 * consented 還在讀（undefined）時什麼都不顯示。
 */
export function setupNotices({
  access,
  consented,
  untranslated,
  hostedHint = false,
}: {
  access: TranslationAccess;
  consented: boolean | undefined;
  /** 有沒翻譯的頁（自備金鑰的提示只在這時出現）。 */
  untranslated: boolean;
  /** 內建翻譯提示還沒關掉。 */
  hostedHint?: boolean;
}): { consentCard: boolean; notice: SetupNotice } {
  if (consented === undefined) return { consentCard: false, notice: undefined };
  if (access.mode === 'hosted') return { consentCard: false, notice: access.signedIn && consented ? undefined : 'signedOut' };
  const notice = untranslated && !access.hasKey ? 'noKey' : hostedHint ? 'hostedHint' : undefined;
  return { consentCard: !consented, notice };
}

/**
 * 整個取代 side panel 內容的一頁（頂部是「← 返回」＋標題，#93）：設定按 ⚙ 打開；
 * 作品頁（作品身分＋Series Notes，#191）從作品卡打開，換一部作品從作品頁（或作品卡的「換一部」）打開；
 * 刪除帳號在帳號與訂閱頁（#213），不在 side panel。
 */
export type PanelPage = 'settings' | 'series' | 'seriesPick';

const PARENT_PAGES: Partial<Record<PanelPage, PanelPage>> = { seriesPick: 'series' };

/** 這一頁的「←」回到哪一頁；undefined＝回到逐字稿。 */
export const parentPage = (page: PanelPage): PanelPage | undefined => PARENT_PAGES[page];

/** side panel 這時顯示哪一個畫面：沒做完 onboarding 時只有「完成設定」（沒有頂部的狀態與 ⚙）。 */
export function sidePanelScreen({ setupComplete, page }: { setupComplete: boolean; page: PanelPage | undefined }): 'finishSetup' | 'transcript' | PanelPage {
  if (!setupComplete) return 'finishSetup';
  return page ?? 'transcript';
}

/** 作品頁與作品卡上，目前這部作品可以做的事（#191）。 */
export interface SeriesActions {
  /**
   * Provisional Series 的問句列（作品卡與作品頁都有）：confirm＝猜到原名，「這是正確的作品嗎？［是］［換一部］」；
   * name＝猜不出來，「看不出是哪部作品［取名字］［選一部］」；undefined＝確認過了，沒有問句列，作品頁改由「不是這部作品？」進換一部作品。
   */
  ask: 'confirm' | 'name' | undefined;
  /** 名稱旁的按鈕：未命名的 Provisional Series 是「取名字」。 */
  rename: '改名' | '取名字';
  /** 「合併進…」的目標：只有 Provisional Series 能當合併的來源，目標是其他確認過的作品。 */
  mergeTargets: SeriesOption[];
}

export function seriesActions(current: SeriesOption, options: SeriesOption[]): SeriesActions {
  if (!current.provisional) return { ask: undefined, rename: '改名', mergeTargets: [] };
  const guessed = (current.originalTitles?.length ?? 0) > 0;
  return {
    ask: guessed ? 'confirm' : 'name',
    rename: guessed ? '改名' : '取名字',
    mergeTargets: options.filter((o) => !o.provisional && o.id !== current.id),
  };
}


/** 「11 月 15 日」：重置日期，依讀者的時區。 */
const monthDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
};

/** 「2027 年 10 月 15 日」：續訂日與訂閱結束日。 */
const fullDate = (ms: number) => `${new Date(ms).getFullYear()} 年 ${monthDay(ms)}`;

/** 內建翻譯的額度在 side panel 上怎麼顯示（#92、#94 畫面定案）。 */
export interface QuotaView {
  /** 底部狀態列（系列與翻譯狀態之間）多的那一行；subscribeLink＝右邊的「訂閱」小字連結。undefined＝不顯示。 */
  line: { text: string; warn: boolean; subscribeLink: boolean } | undefined;
  /** 額度用完：逐字稿上方的 warn Callout（粗體標題、說明、subscribe＝有沒有「訂閱」，「使用自備金鑰」一定有）。undefined＝還能翻。 */
  exhausted: { title: string; body: string; subscribe: boolean } | undefined;
  /** 底部狀態列右邊的按鈕：translate＝「翻譯此頁」（還要有沒翻譯的頁、送得出翻譯才出現），subscribe＝primary「訂閱」，none＝不放（本月額度用完，等重置）。 */
  footerButton: 'translate' | 'subscribe' | 'none';
}

/**
 * 依翻譯模式、登入與 Worker 回傳的額度（GET /v1/account）算出要顯示什麼。只有內建翻譯、已登入、讀到額度時才有東西；
 * 數字一律是 Worker 給的，這裡不自己扣。訂閱者不顯示免費額度；扣款失敗、排定取消照常可以翻，side panel 不提示。
 */
export function quotaView(access: TranslationAccess, quota: Quota | undefined): QuotaView {
  if (access.mode !== 'hosted' || !access.signedIn || !quota) return { line: undefined, exhausted: undefined, footerButton: 'translate' };
  if (quota.plan === 'subscribed') {
    const reset = monthDay(quota.resetsAt);
    if (quota.remaining === 0) {
      const title = `本月額度已用完，${reset}重置`;
      return {
        line: { text: title, warn: true, subscribeLink: false },
        exhausted: { title, body: '已翻過的頁面照常顯示譯文；新的頁面先顯示原文與讀音，重置後就能繼續翻。', subscribe: false },
        footerButton: 'none',
      };
    }
    return {
      line: { text: `本月剩 ${quota.remaining} 頁・${reset}重置`, warn: quota.remaining <= LOW_QUOTA, subscribeLink: false },
      exhausted: undefined,
      footerButton: 'translate',
    };
  }
  // 沒有訂閱、免費額度是 0（包含訂閱結束後也用完的讀者）就是用完
  if (quota.remaining === 0)
    return {
      line: { text: '免費額度已用完', warn: true, subscribeLink: false },
      exhausted: { title: '免費額度已用完', body: `已翻過的頁面照常顯示譯文；新的頁面先顯示原文與讀音。訂閱後每月可翻 ${MONTHLY_PAGES} 頁。`, subscribe: true },
      footerButton: 'subscribe',
    };
  return {
    line: { text: `免費額度剩 ${quota.remaining} 頁`, warn: quota.remaining <= LOW_QUOTA, subscribeLink: true },
    exhausted: undefined,
    footerButton: 'translate',
  };
}

/** 設定頁「內建翻譯」卡片裡的方案：email 旁的 Badge、剩餘說明（一行一個），subscribed＝動作是「管理訂閱」而不是「訂閱」。 */
export interface AccountPlanView {
  badge: { text: string; tone: BadgeTone };
  lines: string[];
  subscribed: boolean;
}

/** 設定頁的方案（#94 畫面定案）：免費、訂閱中、排定取消、扣款失敗重試中。 */
export function accountPlanView(quota: Quota): AccountPlanView {
  if (quota.plan === 'free') return { badge: { text: '免費', tone: 'neutral' }, lines: [`免費額度剩 ${quota.remaining} / ${FREE_PAGES} 頁`], subscribed: false };
  const month = `本月剩 ${quota.remaining} / ${quota.limit} 頁，${monthDay(quota.resetsAt)}重置`;
  if (quota.status === 'pastDue')
    return {
      badge: { text: '扣款失敗，重試中', tone: 'warn' },
      lines: [month, 'Paddle 會再嘗試扣款，這段期間照常可以使用；請到「管理訂閱」更新付款方式'],
      subscribed: true,
    };
  if (quota.cancelScheduled)
    return { badge: { text: '訂閱中・不會續訂', tone: 'warn' }, lines: [month, `訂閱在 ${fullDate(quota.periodEndsAt)}結束`], subscribed: true };
  return { badge: { text: '訂閱中', tone: 'ok' }, lines: [month, `下次續訂：${fullDate(quota.periodEndsAt)}`], subscribed: true };
}

/**
 * 帳號與訂閱頁（#213）的輸入：翻譯模式、有沒有登入、Worker 給的額度（讀不到是 undefined）；
 * justPaid＝在這頁付完款，justSignedIn＝在這頁登入，hasOrigin＝從漫畫分頁卡住來的（才有「回到漫畫」）。
 */
export interface AccountPageInput {
  mode: TranslationMode;
  signedIn: boolean;
  quota: Quota | undefined;
  justPaid: boolean;
  justSignedIn: boolean;
  hasOrigin: boolean;
}

/** 帳號與訂閱頁要顯示什麼（#213，prototype/account-status 的方案 B）。 */
export interface AccountPageView {
  /** 頂部的說明；backToManga＝有「回到漫畫」。 */
  notice: { tone: 'info' | 'warn'; title: string; body: string; backToManga: boolean } | undefined;
  /** 「目前方案」：left＝額度的剩餘文字，fraction＝進度條畫的剩餘比例（用完是 0）。讀不到額度時 undefined。 */
  plan: { name: string; note: string | undefined; quotaLabel: string; left: string; fraction: number; warn: boolean } | undefined;
  /** 有沒有「訂閱」那一段（只有免費方案）。 */
  subscribe: boolean;
  /** 自備金鑰模式但帳號還登入著：說明不會用到這個帳號的頁數。 */
  ownKeyNote: boolean;
  /** 沒登入：「登入」上面的說明。 */
  signedOut: string | undefined;
}

const UNTRANSLATED_PAGES_KEEP_ORIGINAL = '已翻過的頁面照常顯示譯文；新的頁面先顯示原文與讀音';

/** 帳號頁沒登入時「登入」上面的說明：正在用自備金鑰的話說不需要登入。 */
export const signedOutText = (mode: TranslationMode): string =>
  mode === 'ownKey'
    ? `目前用自備金鑰翻譯，不需要登入。想改用內建翻譯的話可以登入，新帳號有 ${FREE_PAGES} 頁免費額度。`
    : `尚未登入。登入後就能用內建翻譯，新帳號有 ${FREE_PAGES} 頁免費額度。`;

export function accountPageView({ mode, signedIn, quota, justPaid, justSignedIn, hasOrigin }: AccountPageInput): AccountPageView {
  const empty = { notice: undefined, plan: undefined, subscribe: false, ownKeyNote: false, signedOut: undefined };
  if (!signedIn) return { ...empty, signedOut: signedOutText(mode) };
  if (!quota) return { ...empty, ownKeyNote: mode === 'ownKey' };
  const usedUp = quota.remaining === 0;
  // 自備金鑰不會用到帳號的頁數：用完了也不必說明
  const usesAccount = mode === 'hosted';
  const meter = (total: number, usedUpText: string) => ({
    left: usedUp ? usedUpText : `剩 ${quota.remaining} / ${total} 頁`,
    fraction: quota.remaining / total,
    warn: quota.remaining <= LOW_QUOTA,
  });
  const signedInNotice: AccountPageView['notice'] =
    justSignedIn && hasOrigin && !usedUp ? { tone: 'info', title: '✓ 已登入', body: '回到漫畫後會接著翻譯。', backToManga: true } : undefined;
  if (quota.plan === 'free')
    return {
      ...empty,
      notice: usesAccount && usedUp ? { tone: 'warn', title: '免費額度已用完', body: `${UNTRANSLATED_PAGES_KEEP_ORIGINAL}。`, backToManga: false } : signedInNotice,
      plan: { name: '免費', note: `新帳號一次 ${FREE_PAGES} 頁，不會過期`, quotaLabel: '免費額度', ...meter(FREE_PAGES, '已用完') },
      subscribe: true,
      ownKeyNote: !usesAccount,
    };
  const notice: AccountPageView['notice'] = justPaid
    ? { tone: 'info', title: '✓ 訂閱完成', body: `每月可翻 ${quota.limit} 頁。`, backToManga: hasOrigin }
    : usesAccount && usedUp
      ? { tone: 'warn', title: `本月額度已用完，${monthDay(quota.resetsAt)}重置`, body: `${UNTRANSLATED_PAGES_KEEP_ORIGINAL}，重置後就會繼續翻。`, backToManga: hasOrigin }
      : signedInNotice;
  return {
    ...empty,
    notice,
    plan: { name: '訂閱（年繳）', note: undefined, quotaLabel: '本月額度', ...meter(quota.limit, '本月已用完') },
    ownKeyNote: !usesAccount,
  };
}
