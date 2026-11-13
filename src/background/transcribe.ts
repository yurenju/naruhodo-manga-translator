/**
 * 擷取到 Page 之後：本機流水線（offscreen）→ Translator（有的話）→ side panel 逐字稿（spec #27 第 3 節）。
 * 沒有 Translator（沒有 API key）時只顯示 OCR 原文＋kuromoji 讀音、標「未翻譯」（spec 第 5 節）；
 * 翻譯失敗時也退回 kuromoji 讀音，並帶上錯誤訊息。設定 key 之後按「翻譯此頁」用同一份辨識結果重新翻譯。
 * 翻譯快取（#33）：先查 (Series ID, Page hash)，命中就直接用、不跑本機流水線也不呼叫 Translator；翻譯成功才寫入。
 * 翻一頁、寫快取、查快取與過時判斷在 page-translation.ts；這裡管每個 tab 的 Page、工作與畫面。
 *
 * 翻譯佇列（#34、spec 第 3.4 節；排程在 translation-queue.ts）：
 * - 兩段：本機段（偵測／OCR）併發 1、LLM 段併發 2，跨 tab 共用（offscreen 只有一份模型）。
 * - 後進先出：新出現的可見 Page 先做；同一次擷取裡依閱讀順序。工作帶 priority（v1 只有可見頁）。
 * - 翻太快：已不在畫面上、還沒開始的工作丟掉（之後再出現會重新排）；已開始的做完、寫進快取，但不顯示也不覆蓋。
 * - 去重：同一個 Page（hash 在門檻內）已有工作在跑就不重複排，等那份結果。
 * - 429 依 retry-after 退避重試在 Translator 裡（claude-translator.ts）；重試後仍失敗就帶 translateError，按「重試」重送 LLM。
 *
 * Series Notes（#37、ADR 0005；順序在 notes-ledger.ts）：翻譯（①）帶這個 Series 的 Notes 快照，回來就寫快取、顯示；
 * 接著在背景整理 Notes（②），依 ② 送出順序套用。同一次排程裡同一個 anchor 的 Page（Spread 的兩頁）是一個
 * SnapshotGroup，共用 ② 的快照。沒有 Series 時不帶 Notes 也不整理。
 *
 * Prior Pages（ADR 0005）：每個 tab 記住讀者依序看過的頁（命中快取的也算），① 帶這頁之前最近看過的 2 頁中
 * 已經翻好的，同一批裡閱讀順序在前的頁也算（Spread 的左頁帶同一個 Spread 的右頁）。同一批裡在後的頁等前頁的 ①
 * 結束（翻好、失敗或被丟掉）才送；前一批的頁不等。Series 換了就清空；同 origin 重新整理（換話）保留，停止或關 tab 才忘掉。
 *
 * 直式捲動的長 Page（spec #142，PageThumb.visible）：每次擷取處理看得到的那一截，新收的 Line 併進同一個 Page、馬上翻譯
 * （同一個 Page 已翻好的 Line 算一頁 Prior Pages；Hosted Translation 的接續請求帶這個 Page 的 usageRecordId，Worker 不重複扣頁），
 * 顯示與快取的是整個 Page。身分先看 anchor，認不出才比橫條指紋（記憶體裡的，再來是快取）。
 * 同一個 Page 一次只有一截在本機段排隊：還沒開始時換成最新的那一截。
 *
 * 直式排版的一串（#282，PageThumb.column）：一串裡的每個元素照長 Page 處理（身分、快取、Line 都以元素為單位），
 * 但辨識的範圍是整串看得到的那一塊，跨元素交界的框由中心所在的元素收；被可見範圍邊緣切到的框帶上這一串
 * 上一次的截圖，offscreen 拼起來再辨識。看到接得起來的交界（PageThumb.junctionAbove）這一串就是 Strip（條漫）：
 * Hosted Translation 改照句數計頁，累計記在這一串上（ColumnState.charge），不走長 Page 的接續。
 *
 * Page 上的外圈（#285、#283，shared/page-outlines.ts）：送出 ① 到回來之間，這次送去翻的句子列在 PageView.translatingLines；
 * 長 Page 最近辨識的那一截裡被可見範圍邊緣切到、先不收的框列在 PageView.waitingLines。
 */
import { addLines, collectedBoxes, matchingStripe, pickLines, replaceLines, sliceOf, withoutEdgeHalves, type Slice, type Stripe } from '../shared/long-page.ts';
import { STRIP_WINDOW_MS } from '../shared/hosted-api.ts';
import type { AnalyzeRequest, CropRequest, LineBox, PageThumb, PageView, PreviousCapture, Rect, StripStatus } from '../shared/messages.ts';
import { translatingLines } from '../shared/page-outlines.ts';
import type { Capture } from './scan.ts';
import { findSamePage } from '../shared/page-hash.ts';
import { pageLines, type PageCharge, type PageText, type StripCharge } from '../shared/page-text.ts';
import type { SeriesNotes, TranslatorVersion } from '../shared/series-notes.ts';
import type { Series } from '../shared/series.ts';
import { createTrace } from '../shared/trace.ts';
import type { TranslatedLine, PriorPage, Translator } from '../shared/translator.ts';
import { createNotesLedger, newSnapshotGroup, type NotesStore, type SnapshotGroup } from './notes-ledger.ts';
import { createPageTranslation, type LongPageRequest, type PageCache, type Transcript } from './page-translation.ts';
import { createTranslationQueue, type QueuedJob } from './translation-queue.ts';

export type { NotesStore, PageCache };

/** 給 e2e 量排程用：enqueue＝排進本機段、start＝本機段開始、drop＝沒開始就丟掉、llm＝送出 LLM、done＝做完（含 LLM）。 */
export type JobEventKind = 'enqueue' | 'start' | 'drop' | 'llm' | 'done';

export interface JobEvent {
  tabId: number;
  event: JobEventKind;
  pageHash: string;
}

export interface TranscriberDeps {
  /** waiting：長 Page 的這一截裡被可見範圍邊緣切到、先不收的框（Page 座標，#283）。 */
  analyze(request: AnalyzeRequest): Promise<PageText & { waiting?: LineBox[] }>;
  /** 沒有 API key 時回傳 undefined。 */
  getTranslator(): Translator | undefined | Promise<Translator | undefined>;
  /** 目前會用來翻譯的模型與 prompt 版本（過時提示比對用）；沒有 Translator 時 undefined，就不比版本。 */
  translatorVersion?(): TranslatorVersion | undefined | Promise<TranslatorVersion | undefined>;
  /** 原文 → kuromoji 整句讀音（offscreen 算）；命中舊快取時換掉 LLM 給的讀音（#195）。 */
  kuromojiReadings?(texts: string[]): Promise<string[]>;
  /** 這個 tab 啟動時選定的 Series（或 Provisional Series）；沒有就不查也不寫快取。正在猜作品原名時等猜完才回答（#186）。 */
  getSeriesId(tabId: number): Promise<string | undefined>;
  /** 這個 tab 的 Series 還在猜（#186）：新 Page 先跑 OCR，翻譯前才等 Series、查快取。 */
  isSeriesPending?(tabId: number): boolean;
  /** 送出翻譯時讀 Series 的名稱（讀者在這之間可能改名）。 */
  getSeries(seriesId: string): Promise<Series | undefined>;
  cache: PageCache;
  notes: NotesStore;
  /** strip：畫面上的這一串是 Strip（條漫，#282）時，它到目前計了幾句、幾頁（還沒有 Hosted Translation 的累計時是 0）。 */
  publish(tabId: number, pages: PageView[], strip?: StripStatus): void;
  onJobEvent?(event: JobEvent): void;
}

const trace = createTrace('sw');

/** 工作的 priority：可見頁 > 預翻頁（v1 只有可見頁，spec 第 10 節）。 */
export const PRIORITY_VISIBLE = 1;

/** Prior Pages 帶幾頁（ADR 0005）。 */
export const PRIOR_PAGES = 2;
/** 每個 tab 記住最近看過的幾頁：Prior Pages 加上一批畫面上的頁（Spread 兩頁）就夠了，多留一點餘裕。 */
const SEEN_LIMIT = 8;

/** 讀者看過的一頁。同一頁再看一次時移到最後（同一個物件）。 */
interface SeenPage {
  pageHash: string;
  /** 翻好了才有（翻譯完成或命中快取）。 */
  lines?: TranslatedLine[];
}

/** 一個 tab 在一部 Series 裡依序看過的頁（舊的在前）。 */
/** 翻好了但一句都沒有（全部 unreadable，例如話末推薦縮圖、空白頁）：當 Prior Pages 沒有內容。 */
function isEmpty(page: SeenPage): boolean {
  return page.lines?.length === 0;
}

interface SeenPages {
  seriesId: string | undefined;
  pages: SeenPage[];
}

/** 一個 tab 這次啟動看過的一個 Page（以 hash 認）。 */
interface PageRecord {
  pageHash: string;
  seriesId: string | undefined;
  /** 第一次看到它時的截圖與候選；本機流水線從這張截圖裁 Page。 */
  request: AnalyzeRequest;
  transcript: Transcript;
  /** 本機流水線的結果，「翻譯此頁／重試」用它重新翻譯，不必重跑 OCR。命中快取時沒有。 */
  text?: PageText;
  /** 有工作在排或在跑。 */
  job?: Job;
  /** 目前的工作做完（或被丟掉）時 resolve。 */
  settled: Promise<void>;
  /** 長 Page 才有；text 是到目前收到的整個 Page 的 Line（Page 座標）。 */
  long?: LongPage;
  /** Retranslation（側邊欄的「重新翻譯」）：當作第一次看到，不拿快取的結果（長 Page 只拿身分）。 */
  ignoreCache?: true;
  /** 已經送出 ①、還沒回來的每一次送的句子（#285）；長 Page 可能同時有兩截在翻。 */
  sending?: PageText[];
}

interface LongPage {
  /** 最近一次看到它的 anchor：同一個 anchor 就是同一個 Page，不必比橫條。 */
  anchorId: string;
  /** 看過的橫條（每一條只記第一次看到的 hash）。 */
  stripes: Stripe[];
  /** 最近一次排進本機段的那一截；同一截不重做。 */
  slice: Slice;
  /** Hosted Translation：這個 Page 扣頁的那次，接續的截帶上它。也存在快取裡，翻走、重新整理後再出現照樣接續。 */
  charge?: PageCharge;
  /** 最近一次看到它時所在的那一串（直式排版，#282）；單獨一個長 Page 沒有。 */
  column?: string;
  /** 最近辨識的那一截裡被可見範圍邊緣切到、先不收的框（#283）；下一截辨識完整個換掉。 */
  waiting?: LineBox[];
}

/** 一個 tab 裡直式排版的一串（#282）。 */
interface ColumnState {
  /** 看過接得起來的交界：這一串是 Strip（條漫），Hosted Translation 照句數計頁。認定之後不會變回來。 */
  strip: boolean;
  /** Strip 的計費累計（Hosted Translation 翻過才有）；也存在每個元素的快取裡，SW 重新啟動後接著算。 */
  charge?: StripCharge;
  /** 上一次的截圖：下一次有框被可見範圍邊緣切到時拿來拼接。 */
  last?: ColumnCapture;
}

interface ColumnCapture {
  capture: CropRequest;
  region: Rect;
  cutTop: boolean;
  cutBottom: boolean;
  /** 那次每個看得到的元素的位置：跟下一次同一個元素的位置相減就是捲了多少。 */
  rects: Map<string, Rect>;
}

/** 捲動不到這麼多 CSS px 的兩次截圖當成同一個位置，不拼接。 */
const MIN_SCROLL = 1;

/**
 * 這一串這次的截圖能不能跟上一次拼：兩次都看得到同一個元素（anchor）才知道捲了多少；位置一樣就不必拼。
 * members：這次這一串裡看得到的元素。
 */
function previousCapture(last: ColumnCapture | undefined, members: readonly PageThumb[]): PreviousCapture | undefined {
  const shared = last && members.find((m) => last.rects.has(m.anchorId));
  if (!last || !shared) return undefined;
  const dy = last.rects.get(shared.anchorId)!.y - shared.rect.y;
  if (Math.abs(dy) < MIN_SCROLL) return undefined;
  const { screenshot, frameMark, viewport } = last.capture;
  return { screenshot, frameMark, viewport, region: last.region, cutTop: last.cutTop, cutBottom: last.cutBottom, dy };
}

/** 兩份 Strip 累計裡比較新的：同一串取句數多的，不同串取後來的。 */
function newerStripCharge(a: StripCharge | undefined, b: StripCharge): StripCharge {
  if (!a) return b;
  if (a.usageRecordId === b.usageRecordId) return b.lines > a.lines ? b : a;
  return b.chargedAt > a.chargedAt ? b : a;
}

/** 扣頁之後多久內接續（跟 Worker 的條件一樣，worker/src/quota.ts）；超過就不帶，Worker 當成新的一頁扣。 */
const CONTINUATION_WINDOW_MS = 60 * 60_000;

const EMPTY_TEXT: PageText = { balloons: [], looseText: [] };

interface TabState {
  tabId: number;
  /** 最近一次擷取到的可見 Page（依閱讀順序）。 */
  pages: PageThumb[];
  records: PageRecord[];
  /** 直式排版的每一串（#282），key＝ColumnView.id。 */
  columns: Map<string, ColumnState>;
  /** 按了「重新翻譯」時畫面上的 Page（retranslate）：下一次擷取還看得到的那些從頭來過（startOver）。 */
  retranslating?: PageRecord[];
}

interface Job extends QueuedJob {
  tab: TabState;
  record: PageRecord;
  /** 這個工作要辨識的截圖（長 Page 是其中一截；一般 Page 就是 record.request）。 */
  request: AnalyzeRequest;
  /** 本機段開始了。 */
  started?: boolean;
  /** 長 Page：這一截新收的 Line（LLM 段只翻它們）；重新翻譯整個 Page 時沒有。 */
  added?: PageText;
  /** 進到 LLM 段才有。 */
  translator?: Translator;
  /** 共用 ② 的 Notes 快照的那一組（同一次排程裡同一個 anchor）。 */
  group: SnapshotGroup;
  /** 排程時這頁之前最近看過的頁（含同一批裡閱讀順序在前的頁）；送出 ① 時才看哪些已經翻好。 */
  prior: SeenPage[];
  /** Series 還在猜時先排進本機段的頁（#186）：翻譯前等它、記到這頁上、再查一次快取。 */
  seriesPending?: Promise<string | undefined>;
  resolve(): void;
}

/** 同一次排程裡，同一個 anchor 切出來的 Page（Spread 的兩頁）拿到同一組。 */
function snapshotGroups(): (record: PageRecord) => SnapshotGroup {
  const byAnchor = new Map<string, SnapshotGroup>();
  return (record) => {
    const { anchorId } = record.request.candidate;
    let group = byAnchor.get(anchorId);
    if (!group) byAnchor.set(anchorId, (group = newSnapshotGroup()));
    return group;
  };
}

/** 一個工作要的東西（newJob）。 */
interface JobSpec {
  tab: TabState;
  record: PageRecord;
  batch: number;
  index: number;
  group: SnapshotGroup;
  /** 省略＝record.request。 */
  request?: AnalyzeRequest;
}

/** 同一截：上下緣差不到這麼多（Page 高度的比例）。 */
const SAME_SLICE = 1e-3;
const sameSlice = (a: Slice, b: Slice) => Math.abs(a.top - b.top) < SAME_SLICE && Math.abs(a.bottom - b.bottom) < SAME_SLICE;

/** 長 Page 這次要辨識的範圍（畫面 CSS px）：單獨一個是自己看得到的那一截，一串裡的是整串看得到的範圍（#282）。 */
const analyzedRect = (page: PageThumb): Rect | undefined => page.column?.region ?? page.visible;

/**
 * 擷取到的 Page 要送去辨識的內容（一般 Page 是整個 Page，長 Page 是看得到的那一截，一串裡的是整串看得到的範圍）。
 * previous：這一串上一次的截圖（接得上時）。
 */
function analyzeRequestOf(page: PageThumb, capture: CropRequest, previous?: PreviousCapture): AnalyzeRequest {
  const visible = analyzedRect(page);
  const { column } = page;
  return {
    screenshot: capture.screenshot,
    frameMark: capture.frameMark,
    viewport: capture.viewport,
    candidate: { anchorId: page.anchorId, rect: page.rect, ...(visible ? { visible } : {}) },
    subRect: page.subRect,
    ...(column ? { column: { cutTop: column.cutTop, cutBottom: column.cutBottom, ...(previous ? { previous } : {}) } } : {}),
  };
}

/** 長 Page 裡已經翻好的 Line（有譯文的；unreadable 的 pageLines 會略過），這次要翻的（added）除外。 */
function translatedLines(page: PageText, added: PageText): TranslatedLine[] {
  const sending = new Set([...added.balloons, ...added.looseText].map((t) => t.id));
  const done = new Set([...page.balloons, ...page.looseText].filter((t) => t.譯文 !== '' && !sending.has(t.id)).map((t) => t.id));
  return pageLines(pickLines(page, done));
}

/** 兩份橫條併成一份，同一條留先看到的。 */
const mergeStripes = (a: readonly Stripe[], b: readonly Stripe[]) => [...a, ...b.filter((t) => !a.some((u) => u.index === t.index))];

/** 辨識完、還沒翻譯（沒有 Translator、翻譯失敗、額度用完）：「翻譯此頁」與能翻譯時要翻的頁。 */
function isUntranslated(record: PageRecord): boolean {
  return record.transcript.state === 'done' && !record.transcript.translated;
}

export function createTranscriber(deps: TranscriberDeps) {
  const ledger = createNotesLedger({ store: deps.notes, seriesExists: async (seriesId) => (await deps.getSeries(seriesId)) !== undefined });
  const pageTranslation = createPageTranslation({
    cache: deps.cache,
    ledger,
    getSeries: deps.getSeries,
    translatorVersion: deps.translatorVersion,
    kuromojiReadings: deps.kuromojiReadings,
  });
  const tabs = new Map<number, TabState>();
  const views = new Map<number, { pages: PageView[]; strip?: StripStatus }>();
  const seen = new Map<number, SeenPages>();
  let batches = 0;

  const isCurrent = (tab: TabState) => tabs.get(tab.tabId) === tab;
  const isVisible = (tab: TabState, record: PageRecord) => isCurrent(tab) && findSamePage(tab.pages, record.pageHash) !== undefined;
  const report = (job: Job, event: JobEventKind) => deps.onJobEvent?.({ tabId: job.tab.tabId, event, pageHash: job.record.pageHash });

  const queue = createTranslationQueue<Job>({
    runLocal,
    runLlm,
    isWanted: (job) => isVisible(job.tab, job.record),
    onDrop(job) {
      job.tab.records = job.tab.records.filter((r) => r !== job.record);
      report(job, 'drop');
      finish(job, undefined);
    },
  });

  /**
   * 這一批畫面上的頁依閱讀順序記成最近看過的。Series 換了就從頭記；沒有 Series 也從頭記（分不出是不是同一部作品）。
   * 已經翻好、還在記憶體裡的頁補上原文與譯文（例如一直在畫面上、被擠出紀錄的頁）。
   */
  function see(tab: TabState, seriesId: string | undefined, pages: readonly { pageHash: string }[]): void {
    let history = seen.get(tab.tabId);
    if (!history || seriesId === undefined || history.seriesId !== seriesId) seen.set(tab.tabId, (history = { seriesId, pages: [] }));
    for (const { pageHash } of pages) {
      const page = findSamePage(history.pages, pageHash) ?? { pageHash };
      history.pages = [...history.pages.filter((p) => p !== page), page];
      const record = findSamePage(tab.records, pageHash);
      if (record && !page.lines) remember(tab.tabId, pageHash, record.transcript);
    }
    history.pages = history.pages.slice(-SEEN_LIMIT);
  }

  /** 畫面上這一批裡，閱讀順序在這頁之前的頁。 */
  function earlierInBatch(tab: TabState, record: PageRecord): PageThumb[] {
    const page = findSamePage(tab.pages, record.pageHash);
    return page ? tab.pages.slice(0, tab.pages.indexOf(page)) : [];
  }

  /**
   * 這頁的 Prior Pages 位置：這一批之前最近看過的頁，接著同一批裡閱讀順序在前的頁，取最後 2 頁
   * （還沒翻好的也算位置，送出時才略過）。翻好但一句都沒有的頁（話末推薦縮圖、空白頁）不算，往前補到有句子的頁。
   */
  function priorOf(tab: TabState, record: PageRecord): SeenPage[] {
    const pages = (seen.get(tab.tabId)?.pages ?? []).filter((p) => !isEmpty(p));
    const before = pages.filter((p) => findSamePage(tab.pages, p.pageHash) === undefined);
    const earlier = earlierInBatch(tab, record).flatMap((p) => findSamePage(pages, p.pageHash) ?? []);
    return [...before, ...earlier].slice(-PRIOR_PAGES);
  }

  /**
   * 同一次排程（batch）裡閱讀順序在前的頁，它們這次的工作都結束（翻好、失敗或被丟掉）時 resolve。
   * 前一次排程的工作不等（spec「前一批的頁維持現狀，還沒翻完就不等」）；前面沒有這次排的頁（單頁 viewer）就不等。
   */
  function earlierSettled(tab: TabState, record: PageRecord, batch: number): Promise<unknown> | undefined {
    const earlier = earlierInBatch(tab, record).flatMap((p) => {
      const r = findSamePage(tab.records, p.pageHash);
      return r?.job?.batch === batch ? [r.settled] : [];
    });
    return earlier.length === 0 ? undefined : Promise.all(earlier);
  }

  /**
   * 送出 ① 的這一刻已經翻好的 Prior Pages。長 Page 的接續（spec #142）：同一個 Page 已經翻好的 Line 也算一頁，
   * 放在最後（離這次最近），一樣算在 PRIOR_PAGES 之內。
   */
  function priorPages(job: Job): PriorPage[] {
    const pages = job.prior.flatMap((p) => (p.lines && !isEmpty(p) ? [p.lines] : []));
    const same = job.added && job.record.text ? translatedLines(job.record.text, job.added) : [];
    return (same.length > 0 ? [...pages, same] : pages).slice(-PRIOR_PAGES);
  }

  /** 這頁翻好了（翻譯完成或命中快取）：記下它的原文與譯文，之後的頁拿來當 Prior Pages。 */
  function remember(tabId: number, pageHash: string, transcript: Transcript): void {
    if (transcript.state !== 'done' || !transcript.translated) return;
    const page = findSamePage(seen.get(tabId)?.pages ?? [], pageHash);
    if (page) page.lines = pageLines(transcript.text);
  }

  function publish(tab: TabState): void {
    if (!isCurrent(tab)) return;
    const current = tab.pages.map((page): PageView => {
      const record = findSamePage(tab.records, page.pageHash);
      const translating = (record?.sending ?? []).flatMap(translatingLines);
      const waiting = record?.long?.waiting ?? [];
      return {
        ...page,
        transcript: record?.transcript ?? { state: 'analyzing' },
        ...(translating.length > 0 ? { translatingLines: translating } : {}),
        ...(waiting.length > 0 ? { waitingLines: waiting } : {}),
      };
    });
    const strip = stripStatus(tab);
    views.set(tab.tabId, { pages: current, ...(strip ? { strip } : {}) });
    deps.publish(tab.tabId, current, strip);
  }

  /** 畫面上的 Page 所在的那一串是 Strip 時，它到目前計了幾句、幾頁（#282）。 */
  function stripStatus(tab: TabState): StripStatus | undefined {
    for (const page of tab.pages) {
      const column = page.column && tab.columns.get(page.column.id);
      if (column?.strip) return { lines: column.charge?.lines ?? 0, pages: column.charge?.pages ?? 0 };
    }
    return undefined;
  }

  /**
   * 這次擷取裡的每一串（#282）：看到接得起來的交界就認定是 Strip；算出這次能不能跟上一次的截圖拼，再記下這次的。
   * 回傳每一串能拼的上一次截圖。
   */
  function seeColumns(tab: TabState, pages: readonly PageThumb[], capture: CropRequest): Map<string, PreviousCapture> {
    const members = new Map<string, PageThumb[]>();
    for (const page of pages) if (page.column) members.set(page.column.id, [...(members.get(page.column.id) ?? []), page]);
    const previous = new Map<string, PreviousCapture>();
    for (const [id, thumbs] of members) {
      let column = tab.columns.get(id);
      if (!column) tab.columns.set(id, (column = { strip: false }));
      const continuous = thumbs.find((p) => p.junctionAbove === 'continuous');
      if (continuous && !column.strip) {
        column.strip = true;
        trace('strip:detected', { tabId: tab.tabId, column: id, anchorId: continuous.anchorId });
      }
      const { region, cutTop, cutBottom } = thumbs[0]!.column!;
      const rects = new Map(thumbs.map((p) => [p.anchorId, p.rect]));
      const before = previousCapture(column.last, thumbs);
      if (before) previous.set(id, before);
      // 位置跟上一次一樣（同一個畫面又截了一次）就留著原本那次：它才是「捲動前」的畫面
      if (before || !column.last || !thumbs.some((p) => column.last!.rects.has(p.anchorId))) column.last = { capture, region, cutTop, cutBottom, rects };
    }
    return previous;
  }

  /** 排程時決定 Prior Pages 的位置，並讓這頁的 ① 等同一批裡閱讀順序在前的頁（換掉 settled 之前先取）。 */
  function newJob(spec: JobSpec): Job {
    const { tab, record } = spec;
    const prior = priorOf(tab, record);
    const after = earlierSettled(tab, record, spec.batch);
    let resolve!: () => void;
    record.settled = new Promise<void>((r) => (resolve = r));
    const job: Job = { ...spec, request: spec.request ?? record.request, priority: PRIORITY_VISIBLE, prior, after, resolve };
    record.job = job;
    return job;
  }

  /** 工作結束；transcript undefined＝沒做就放掉（已停止、被丟掉，或還沒排就翻走）。 */
  function finish(job: Job, transcript: Transcript | undefined): void {
    const { tab, record } = job;
    if (transcript) {
      record.transcript = transcript;
      remember(tab.tabId, record.pageHash, transcript);
    }
    // 長 Page 可能已經有下一截的工作
    if (record.job === job) record.job = undefined;
    job.resolve();
    prune(tab);
    publish(tab);
  }

  /** 工作跑完（本機段失敗、沒有 Translator，或 LLM 段做完）：回報 done 並更新這頁。 */
  function complete(job: Job, transcript: Transcript): void {
    report(job, 'done');
    finish(job, transcript);
  }

  /**
   * 記憶體裡只留畫面上的 Page 與還在跑的工作；翻走的 Page 之後再出現時從快取拿（「快取」狀態），
   * 沒翻譯的（沒有 key）就重跑本機流水線。
   */
  function prune(tab: TabState): void {
    tab.records = tab.records.filter((r) => r.job !== undefined || isVisible(tab, r));
  }

  /** 本機流水線失敗的 Page 不留：下次擷取（例如修好模型後按重試）重跑。 */
  function forgetErrors(tab: TabState): void {
    tab.records = tab.records.filter((r) => r.job !== undefined || r.transcript.state !== 'error');
  }

  function enqueueLocal(job: Job): void {
    report(job, 'enqueue');
    queue.enqueueLocal(job);
  }

  /** 本機段；回傳 true＝接著排進 LLM 段。 */
  async function runLocal(job: Job): Promise<boolean> {
    const { record } = job;
    report(job, 'start');
    job.started = true;
    let text: PageText;
    const startedAt = Date.now();
    // 長 Page：已收 Line 的外框在這時才取，前一截剛收的也算進去
    const request = record.long ? { ...job.request, collected: collectedBoxes(record.text ?? EMPTY_TEXT) } : job.request;
    try {
      // OCR 讀成形近字的名字用 Notes 換回來（#228）；Series 還在猜（#186）時還沒有 Series，就不修
      const notesNames = record.seriesId === undefined ? [] : (await ledger.list(record.seriesId)).map((e) => e.原文);
      const { waiting, ...analyzed } = await deps.analyze(notesNames.length > 0 ? { ...request, notesNames } : request);
      text = analyzed;
      // 等待中的外圈（#283）馬上換成這一截的：翻譯可能還要排隊
      if (record.long && (waiting?.length || record.long.waiting?.length)) {
        record.long.waiting = waiting ?? [];
        publish(job.tab);
      }
      trace('analyze:done', { pageHash: record.pageHash, anchorId: record.request.candidate.anchorId, ms: Date.now() - startedAt, balloons: text.balloons.length, looseText: text.looseText.length });
    } catch (e) {
      trace('analyze:error', { pageHash: record.pageHash, ms: Date.now() - startedAt, error: e });
      complete(job, { state: 'error', message: e instanceof Error ? e.message : String(e) });
      return false;
    }
    if (record.long) return collect(job, text);
    record.text = text;
    const translator = await deps.getTranslator();
    if (!translator) {
      complete(job, (await seriesDecided(job)) ?? { state: 'done', text, translated: false });
      return false;
    }
    job.translator = translator;
    return true;
  }

  /**
   * Series 還在猜時先跑了 OCR（#186）：等 Series 決定、記到這頁上，再查一次那部 Series 的快取（例如在新分頁重看同一話）。
   * 命中就回傳快取的結果。在 LLM 段等，不卡住下一頁的 OCR。
   */
  async function seriesDecided(job: Job): Promise<Transcript | undefined> {
    const pending = job.seriesPending;
    if (!pending) return undefined;
    job.seriesPending = undefined;
    const seriesId = await pending;
    job.record.seriesId = seriesId;
    return lookup(job.record, seriesId);
  }

  /** 一般 Page 查快取；重新翻譯（ignoreCache）的不查。 */
  function lookup(record: PageRecord, seriesId: string | undefined): Promise<Transcript | undefined> | undefined {
    return record.ignoreCache ? undefined : pageTranslation.lookup(seriesId, record.pageHash);
  }

  /** 長 Page 的一截辨識完：新收的 Line 併進整個 Page；有新的才翻譯。 */
  async function collect(job: Job, text: PageText): Promise<boolean> {
    const { record } = job;
    const before = record.text ?? EMPTY_TEXT;
    if (text.balloons.length + text.looseText.length === 0) {
      complete(job, record.transcript.state === 'done' ? record.transcript : { state: 'done', text: before, translated: false });
      return false;
    }
    const known = new Set([...before.balloons, ...before.looseText].map((t) => t.id));
    record.text = addLines(before, text);
    job.added = pickLines(record.text, new Set([...record.text.balloons, ...record.text.looseText].map((t) => t.id).filter((id) => !known.has(id))));
    const translator = await deps.getTranslator();
    if (!translator) {
      complete(job, { state: 'done', text: record.text, translated: false });
      return false;
    }
    job.translator = translator;
    return true;
  }

  async function runLlm(job: Job): Promise<void> {
    const { record } = job;
    const cached = await seriesDecided(job);
    if (cached) {
      complete(job, cached);
      return;
    }
    report(job, 'llm');
    const { long } = record;
    const text = job.added ?? record.text!;
    // 翻譯中的外圈（#285）：從送出到回來
    record.sending = [...(record.sending ?? []), text];
    publish(job.tab);
    // translate 不會丟錯：翻譯失敗、額度用完都回成逐字稿
    const transcript = await pageTranslation.translate({
      text,
      translator: job.translator,
      seriesId: record.seriesId,
      pageHash: record.pageHash,
      group: job.group,
      priorPages: priorPages(job),
      ...(long ? { long: longRequest(job, long) } : {}),
    });
    record.sending = record.sending.filter((sent) => sent !== text);
    complete(job, transcript);
  }

  /**
   * 長 Page 的一次 ①：只翻新收的 Line、扣頁還不到 1 小時時是接續，帶這個 Page 的 usageRecordId（spec #142「計費」）；
   * 重新翻譯整個 Page（job.added 沒有）不帶，是扣一頁的新請求。回來的扣頁紀錄給之後的截接續。
   */
  function longRequest(job: Job, long: LongPage): LongPageRequest {
    const { record } = job;
    const { charge } = long;
    const continues = job.added && charge && Date.now() - charge.chargedAt < CONTINUATION_WINDOW_MS;
    // Strip（#282）：照句數計頁，接著這一串的累計；累計太久以前的就不帶，Worker 從頭計
    const column = long.column === undefined ? undefined : job.tab.columns.get(long.column);
    const stripCharge = column?.charge && Date.now() - column.charge.chargedAt < STRIP_WINDOW_MS ? column.charge : undefined;
    return {
      stripes: long.stripes,
      // 翻譯期間下一截可能又收了新的 Line：回來時才併回當下的整個 Page
      whole: (part) => (record.text = replaceLines(record.text!, part)),
      ...(continues ? { charge } : {}),
      charged: (next) => (long.charge = next),
      ...(column?.strip ? { strip: { ...(stripCharge ? { charge: stripCharge } : {}), charged: (next) => (column.charge = newerStripCharge(column.charge, next)) } } : {}),
    };
  }

  /**
   * 長 Page 的這一截是哪個 Page：anchor 認得就是它，認不出才比橫條（記憶體裡的；快取的在 lookupLong）。
   * 認出來時記一筆 trace：靠什麼認的、對上第幾條橫條（#154 真實網站驗收核對用）。
   */
  function identifyLongPage(tab: TabState, page: PageThumb): PageRecord | undefined {
    const longs = tab.records.filter((r) => r.long);
    const byAnchor = longs.find((r) => r.long!.anchorId === page.anchorId);
    if (byAnchor) {
      trace('longPage:identified', { tabId: tab.tabId, anchorId: page.anchorId, pageHash: byAnchor.pageHash, by: 'anchor' });
      return byAnchor;
    }
    for (const record of longs) {
      const stripe = matchingStripe(record.long!.stripes, page.stripes ?? []);
      if (stripe === undefined) continue;
      trace('longPage:identified', { tabId: tab.tabId, anchorId: page.anchorId, pageHash: record.pageHash, by: 'memoryStripes', stripe });
      return record;
    }
    return undefined;
  }

  /** 已認出的長 Page 又擷取到一截：沒處理過的那一截排進本機段；還沒開始的工作換成這一截。 */
  function requestSlice(record: PageRecord, page: PageThumb, capture: CropRequest, previous: PreviousCapture | undefined, spec: Omit<JobSpec, 'record' | 'request'>): void {
    const long = record.long!;
    const slice = sliceOf(page.rect, analyzedRect(page)!);
    if (sameSlice(long.slice, slice)) return;
    long.slice = slice;
    const request = analyzeRequestOf(page, capture, previous);
    if (record.job && !record.job.started) record.job.request = request;
    else enqueueLocal(newJob({ ...spec, record, request }));
  }

  /**
   * 長 Page 查快取：命中就換成快取裡的身分，已收的 Line 從快取接著收，看過的橫條併起來。
   * 重新翻譯（ignoreCache）只換身分、併橫條：已收的 Line 與扣頁紀錄都不要，從這一截重新收、扣一頁。
   */
  async function lookupLong(tab: TabState, seriesId: string | undefined, record: PageRecord): Promise<Transcript | undefined> {
    const long = record.long!;
    const found = await pageTranslation.lookupLong(seriesId, long.stripes);
    if (!found) return undefined;
    const { cached, transcript } = found;
    const provisional = record.pageHash;
    // 對上第幾條記在 cache:hit
    trace('longPage:identified', { tabId: tab.tabId, anchorId: long.anchorId, pageHash: cached.pageHash, by: 'cacheStripes' });
    record.pageHash = cached.pageHash;
    long.stripes = mergeStripes(cached.stripes ?? [], long.stripes);
    tab.pages = tab.pages.map((p) => (p.anchorId === long.anchorId && p.pageHash === provisional ? { ...p, pageHash: cached.pageHash } : p));
    // 這個元素當初是照 Strip 計費的（#282）：這一串就是 Strip，從快取裡的累計接著算（SW 重新啟動、重新整理之後）
    const column = long.column === undefined ? undefined : tab.columns.get(long.column);
    if (column && cached.strip) {
      column.strip = true;
      column.charge = newerStripCharge(column.charge, cached.strip);
    }
    if (record.ignoreCache) return undefined;
    if (cached.charge) long.charge = cached.charge;
    if (transcript.state !== 'done') return transcript;
    // 一串裡的元素：#282 之前存進快取、被元素交界切成兩半的 Line 不要，這一截照常辨識時會收到完整的那一句
    const text = column ? withoutEdgeHalves(transcript.text) : transcript.text;
    const dropped = transcript.text.balloons.length + transcript.text.looseText.length - text.balloons.length - text.looseText.length;
    if (dropped > 0) trace('column:edgeHalvesDropped', { tabId: tab.tabId, pageHash: cached.pageHash, dropped });
    record.text = text;
    return { ...transcript, text };
  }

  /**
   * 新的擷取：可見的 Page 換成這一批。新 Page 先查快取，沒命中就排進佇列。
   * 回傳的 promise 在這一批可見 Page 的工作都做完（或被丟掉）時 resolve。
   */
  async function update(tabId: number, pages: PageThumb[], capture: Capture | undefined): Promise<void> {
    // 沒有截圖＝畫面上沒有完整可見的 Page
    if (!capture) pages = [];
    let tab = tabs.get(tabId);
    if (!tab) {
      tab = { tabId, pages: [], records: [], columns: new Map() };
      tabs.set(tabId, tab);
    }
    // 沒藏覆蓋層的截圖裡有自己的譯文，不能拿來重新辨識：等按下後那次藏了覆蓋層的擷取（index.ts 的 panel:retranslate）
    const restarted = capture?.overlayShown ? new Set<string>() : startOver(tab, pages);
    // 長 Page 換成認出的 Page 的身分；認不出、又沒有橫條可以認的先不處理（例如這一截全是留白）
    const longOf = new Map<PageThumb, PageRecord>();
    const current = tab;
    pages = pages.flatMap((page) => {
      if (!page.visible) return [page];
      const known = identifyLongPage(current, page);
      if (known) {
        known.long!.anchorId = page.anchorId;
        known.long!.column = page.column?.id;
        known.long!.stripes = mergeStripes(known.long!.stripes, page.stripes ?? []);
        const same = { ...page, pageHash: known.pageHash };
        longOf.set(same, known);
        return [same];
      }
      if (page.stripes?.length) return [page];
      trace('longPage:unidentified', { tabId, anchorId: page.anchorId, visible: page.visible });
      return [];
    });
    tab.pages = pages;
    prune(tab);
    forgetErrors(tab);
    const previousOf = capture ? seeColumns(tab, pages, capture) : new Map<string, PreviousCapture>();
    const previous = (page: PageThumb) => (page.column ? previousOf.get(page.column.id) : undefined);
    const batch = ++batches;
    /** 這次擷取畫面上的 Page（已認得的＋新的）；等它們的工作都結束才 resolve。 */
    const visibleRecords = new Set<PageRecord>();
    /** 第一次出現的 Page，要查快取或排進佇列。 */
    const newPages: { record: PageRecord; index: number }[] = [];
    /** 已認得的長 Page 這次擷取到的一截。 */
    const slices: { record: PageRecord; page: PageThumb; index: number }[] = [];
    for (const [index, page] of pages.entries()) {
      const existing = page.visible ? longOf.get(page) : findSamePage(tab.records, page.pageHash);
      if (existing) {
        visibleRecords.add(existing);
        if (page.visible) slices.push({ record: existing, page, index });
        continue;
      }
      const record: PageRecord = {
        pageHash: page.pageHash,
        seriesId: undefined,
        request: analyzeRequestOf(page, capture!, previous(page)),
        transcript: { state: 'analyzing' },
        settled: Promise.resolve(),
        ...(restarted.has(page.anchorId) ? { ignoreCache: true as const } : {}),
        ...(page.visible
          ? { long: { anchorId: page.anchorId, stripes: page.stripes ?? [], slice: sliceOf(page.rect, analyzedRect(page)!), ...(page.column ? { column: page.column.id } : {}) } }
          : {}),
      };
      tab.records.push(record);
      visibleRecords.add(record);
      newPages.push({ record, index });
    }
    queue.dropUnwanted();
    publish(tab);

    // Series 還在猜（#186）：一般 Page 先排進本機段跑 OCR，翻譯前才等 Series、查快取（seriesDecided）。
    // 長 Page 要先用 Series 查快取認身分，照常等。
    if (deps.isSeriesPending?.(tabId) && newPages.every(({ record }) => !record.long)) {
      const seriesPending = deps.getSeriesId(tabId);
      const groupOf = snapshotGroups();
      const jobs = newPages.map(({ record, index }) => {
        const job = newJob({ tab, record, batch, index, group: groupOf(record) });
        job.seriesPending = seriesPending;
        enqueueLocal(job);
        return job;
      });
      for (const { record, page, index } of slices) requestSlice(record, page, capture!, previous(page), { tab, batch, index, group: groupOf(record) });
      // 這一批記成最近看過的（之後的頁拿來當 Prior Pages）。上面排程時 Prior Pages 的位置取自 Series 決定前的紀錄；
      // 猜到另一部時 see() 換成新的紀錄，不在裡面的（上一部的頁）就不帶（#222）。這個 then 比 seriesDecided 的 await
      // 先接上，所以 ① 送出前就篩好了。tab 已停止時紀錄是空的、全部篩掉也無妨：那些工作不會送出。
      void seriesPending.then((seriesId) => {
        if (isCurrent(tab)) see(tab, seriesId, pages);
        const history = seen.get(tab.tabId)?.pages ?? [];
        for (const job of jobs) job.prior = job.prior.filter((p) => history.includes(p));
      });
      await Promise.all([...visibleRecords].map((r) => r.settled));
      return;
    }

    const seriesId = await deps.getSeriesId(tabId);
    // 先記下這一批（Series 換了就清空），排程時才看得到同一批裡在前的頁
    if (isCurrent(tab)) see(tab, seriesId, pages);
    // 查快取期間佔住這頁，同一頁又出現時不會重複排
    const groupOf = snapshotGroups();
    const jobs = newPages.map(({ record, index }) => {
      record.seriesId = seriesId;
      return newJob({ tab, record, batch, index, group: groupOf(record) });
    });
    const lookups = await Promise.all(
      jobs.map((job) => (job.record.long ? lookupLong(tab, seriesId, job.record) : lookup(job.record, seriesId))),
    );
    // 快取都查完才依閱讀順序排：佇列一有工作就開始跑，Spread 的左頁先查完也不能比右頁先送出 LLM（spec 第 3.4 節）
    for (const [i, job] of jobs.entries()) {
      const { record } = job;
      const cached = lookups[i];
      if (!isCurrent(tab)) finish(job, undefined);
      else if (cached && record.long) {
        // 長 Page 命中快取：先顯示快取的整個 Page，這一截照樣辨識，收快取裡還沒有的 Line
        record.transcript = cached;
        enqueueLocal(job);
      } else if (cached) finish(job, cached);
      else if (!isVisible(tab, record)) {
        tab.records = tab.records.filter((r) => r !== record);
        finish(job, undefined);
      } else enqueueLocal(job);
    }
    for (const { record, page, index } of slices) requestSlice(record, page, capture!, previous(page), { tab, batch, index, group: groupOf(record) });
    if (newPages.some(({ record }) => record.long)) publish(tab);
    await Promise.all([...visibleRecords].map((r) => r.settled));
  }

  /**
   * 「翻譯此頁／重試」：可見的 Page 裡辨識完、還沒翻譯的（沒有 key、翻譯失敗）用同一份辨識結果翻譯（不重跑 OCR）；
   * 已翻好的不重翻，不會多扣頁。已有工作在跑的不重複排。沒有 key 時什麼都不做。
   * pageHash：只翻這一頁，翻好的也重翻（過時提示的「重新翻譯」#38、Page 上紅標籤的「重試」）；
   * 命中快取的頁沒有 OCR 結果，就用快取裡的原文送出。
   */
  async function translate(tabId: number, pageHash?: string): Promise<void> {
    const tab = tabs.get(tabId);
    if (!tab) return;
    const translator = await deps.getTranslator();
    const pages = pageHash === undefined ? tab.pages : tab.pages.filter((p) => p.pageHash === pageHash);
    const visible = [...new Set(pages.flatMap((p) => findSamePage(tab.records, p.pageHash) ?? []))].filter(
      (record) => pageHash !== undefined || isUntranslated(record),
    );
    if (pageHash !== undefined) for (const record of visible) if (record.transcript.state === 'done') record.text ??= record.transcript.text;
    await start(tab, visible, translator);
  }

  /**
   * 能翻譯了（同意、登入，#93）：畫面上辨識完、還沒翻譯的頁直接翻，不必再按「翻譯此頁」。
   * 已翻好（含快取）的不重翻。
   */
  async function translateUntranslated(): Promise<void> {
    const translator = await deps.getTranslator();
    if (!translator) return;
    await Promise.all(
      [...tabs.values()].map((tab) => {
        const waiting = tab.pages.flatMap((p) => {
          const record = findSamePage(tab.records, p.pageHash);
          return record && isUntranslated(record) ? [record] : [];
        });
        return start(tab, [...new Set(waiting)], translator);
      }),
    );
  }

  /** 把這些可見的 Page 排進 LLM 段：辨識完的（有 Translator 時）重新翻譯；已有工作在跑的不重複排。 */
  async function start(tab: TabState, visible: PageRecord[], translator: Translator | undefined): Promise<void> {
    const batch = ++batches;
    const groupOf = snapshotGroups();
    const started: PageRecord[] = [];
    for (const [index, record] of visible.entries()) {
      if (record.job) continue;
      if (translator && record.transcript.state === 'done' && record.text) {
        record.transcript = { ...record.transcript, translating: true };
        const job = newJob({ tab, record, batch, index, group: groupOf(record) });
        job.translator = translator;
        queue.enqueueLlm(job);
      } else continue;
      started.push(record);
    }
    if (started.length === 0) return;
    publish(tab);
    await Promise.all(started.map((r) => r.settled));
  }

  /**
   * Retranslation（側邊欄的「重新翻譯」）：記下畫面上的 Page，呼叫的人接著重新擷取。那次擷取還看得到的頁
   * 當作第一次看到（startOver）：重跑 OCR、不查快取，翻好的結果蓋掉快取。這裡不動畫面，擷取沒有結果時維持原樣。
   */
  function retranslate(tabId: number): void {
    const tab = tabs.get(tabId);
    if (tab) tab.retranslating = tab.records.filter((r) => isVisible(tab, r));
  }

  /**
   * 按了「重新翻譯」之後的第一次擷取：還看得到（一般 Page 比 hash，長 Page 比 anchor）、沒有工作在跑的頁忘掉，
   * 回傳它們這次的 anchor，新排的頁就不查快取。按下後才翻到的頁（同一個 anchor 換了別頁）不算。
   * 長 Page 別截收過的 Line 跟著丟掉，從這一截重新收、扣一頁，之後捲到的截照常接續。
   */
  function startOver(tab: TabState, pages: readonly PageThumb[]): Set<string> {
    const pending = tab.retranslating ?? [];
    tab.retranslating = undefined;
    const anchors = new Set<string>();
    for (const record of pending) {
      if (record.job || !tab.records.includes(record)) continue;
      const { long } = record;
      const page = long ? pages.find((p) => p.visible && p.anchorId === long.anchorId) : findSamePage(pages, record.pageHash);
      if (!page) continue;
      tab.records = tab.records.filter((r) => r !== record);
      anchors.add(page.anchorId);
    }
    return anchors;
  }

  function get(tabId: number): PageView[] {
    return views.get(tabId)?.pages ?? [];
  }

  /** 這個 tab 畫面上的 Strip（條漫，#282）目前的計費累計；不是 Strip 時 undefined。 */
  function getStrip(tabId: number): StripStatus | undefined {
    return views.get(tabId)?.strip;
  }

  /**
   * 同 origin 重新整理（content script 重新注入，anchor 都換了）：忘掉畫面上的 Page，下次擷取重新查快取。
   * 還沒開始的工作丟掉，已開始的做完只寫快取。
   */
  function resetPages(tabId: number): void {
    tabs.delete(tabId);
    views.delete(tabId);
    queue.dropUnwanted();
    deps.publish(tabId, []);
  }

  /**
   * 這個 tab 的 Series 換了 ID 但畫面上的 Page 不必重做（#36 合併：快取已改到目標 ID）：
   * 已記住的 Page 之後「翻譯此頁／重試」寫進新的 ID。
   */
  function reassignSeries(tabId: number, seriesId: string): void {
    for (const record of tabs.get(tabId)?.records ?? []) record.seriesId = seriesId;
    const history = seen.get(tabId);
    if (history) history.seriesId = seriesId;
  }

  /**
   * 這個 Series 的 Notes 被人改了（#38）：畫面上已翻譯的頁重新判斷過時（從快取拿它翻譯時用到的條目），
   * 有變的 tab 重新 publish。
   */
  async function notesChanged(seriesId: string): Promise<void> {
    await Promise.all(
      [...tabs.values()].map(async (tab) => {
        const shown = tab.records.filter((r) => r.seriesId === seriesId && r.transcript.state === 'done' && r.transcript.translated && isVisible(tab, r));
        let changed = false;
        await Promise.all(
          shown.map(async (record) => {
            const cached = await deps.cache.find(seriesId, record.pageHash).catch(() => undefined);
            if (!cached || record.transcript.state !== 'done') return;
            const stale = await pageTranslation.staleOf(cached);
            if (stale === record.transcript.stale) return;
            trace('stale:changed', { seriesId, pageHash: record.pageHash, stale });
            record.transcript = { ...record.transcript, stale };
            changed = true;
          }),
        );
        if (changed) publish(tab);
      }),
    );
  }

  /**
   * 人在 side panel 改 Notes（#38：編輯、接受／忽略建議、匯入）：跟翻譯時套用 notes_changes 用同一個 ledger 寫，
   * 不會互相蓋掉；寫完重新判斷畫面上的頁過時了沒。
   */
  async function updateNotes(seriesId: string, change: (notes: SeriesNotes) => SeriesNotes): Promise<SeriesNotes> {
    const next = await ledger.update(seriesId, change);
    await notesChanged(seriesId);
    return next;
  }

  /** 刪除作品（#214）：排在這部 Series 已經開始的 Notes 寫入後面才刪，之後的寫入看到它不在就不寫。 */
  function removeSeries(seriesId: string, remove: () => Promise<void>): Promise<void> {
    return ledger.remove(seriesId, remove);
  }

  /** 停止或關 tab：同 resetPages，看過的頁也忘掉。 */
  function clear(tabId: number): void {
    seen.delete(tabId);
    resetPages(tabId);
  }

  return {
    update,
    translate,
    translateUntranslated,
    retranslate,
    get,
    getStrip,
    resetPages,
    reassignSeries,
    notesChanged,
    updateNotes,
    removeSeries,
    clear,
    /** 背景整理 Notes（②）都做完時 resolve（測試用）。 */
    notesSettled: pageTranslation.notesSettled,
  };
}
