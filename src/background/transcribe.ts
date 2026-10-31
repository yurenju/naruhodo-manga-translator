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
 * - 自動翻譯關著時新 Page 停在 pending，按「翻譯此頁」才排。快取命中照樣直接顯示（不算翻譯）。
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
 */
import { addLines, collectedBoxes, matchingStripe, pickLines, replaceLines, sliceOf, type Slice, type Stripe } from '../shared/long-page.ts';
import type { AnalyzeRequest, CropRequest, PageThumb, PageView } from '../shared/messages.ts';
import { findSamePage } from '../shared/page-hash.ts';
import { pageLines, type PageCharge, type PageText } from '../shared/page-text.ts';
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
  analyze(request: AnalyzeRequest): Promise<PageText>;
  /** 沒有 API key 時回傳 undefined。 */
  getTranslator(): Translator | undefined | Promise<Translator | undefined>;
  /** 目前會用來翻譯的模型與 prompt 版本（過時提示比對用）；沒有 Translator 時 undefined，就不比版本。 */
  translatorVersion?(): TranslatorVersion | undefined | Promise<TranslatorVersion | undefined>;
  /** 這個 tab 啟動時選定的 Series（或 Provisional Series）；沒有就不查也不寫快取。 */
  getSeriesId(tabId: number): Promise<string | undefined>;
  /** 送出翻譯時讀 Series 的名稱（讀者在這之間可能改名）。 */
  getSeries(seriesId: string): Promise<Series | undefined>;
  cache: PageCache;
  notes: NotesStore;
  publish(tabId: number, pages: PageView[]): void;
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
}

/** 扣頁之後多久內接續（跟 Worker 的條件一樣，worker/src/quota.ts）；超過就不帶，Worker 當成新的一頁扣。 */
const CONTINUATION_WINDOW_MS = 60 * 60_000;

const EMPTY_TEXT: PageText = { balloons: [], looseText: [] };

interface TabState {
  tabId: number;
  /** 最近一次擷取到的可見 Page（依閱讀順序）。 */
  pages: PageThumb[];
  records: PageRecord[];
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

/** 擷取到的 Page 要送去辨識的內容（一般 Page 是整個 Page，長 Page 是看得到的那一截）。 */
function analyzeRequestOf(page: PageThumb, capture: CropRequest): AnalyzeRequest {
  return {
    screenshot: capture.screenshot,
    viewport: capture.viewport,
    candidate: { anchorId: page.anchorId, rect: page.rect, ...(page.visible ? { visible: page.visible } : {}) },
    subRect: page.subRect,
  };
}

/** 長 Page 裡已經翻好的 Line（LLM 給過譯文的），這次要翻的（added）除外。 */
function translatedLines(page: PageText, added: PageText): TranslatedLine[] {
  const sending = new Set([...added.balloons, ...added.looseText].map((t) => t.id));
  const done = new Set([...page.balloons, ...page.looseText].filter((t) => t.讀音來源 === 'llm' && !sending.has(t.id)).map((t) => t.id));
  return pageLines(pickLines(page, done));
}

/** 兩份橫條併成一份，同一條留先看到的。 */
const mergeStripes = (a: readonly Stripe[], b: readonly Stripe[]) => [...a, ...b.filter((t) => !a.some((u) => u.index === t.index))];

export function createTranscriber(deps: TranscriberDeps) {
  const ledger = createNotesLedger({ store: deps.notes });
  const pageTranslation = createPageTranslation({ cache: deps.cache, ledger, getSeries: deps.getSeries, translatorVersion: deps.translatorVersion });
  const tabs = new Map<number, TabState>();
  const views = new Map<number, PageView[]>();
  const autoTranslate = new Map<number, boolean>();
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
   * （還沒翻好的也算位置，送出時才略過）。
   */
  function priorOf(tab: TabState, record: PageRecord): SeenPage[] {
    const pages = seen.get(tab.tabId)?.pages ?? [];
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
    const pages = job.prior.flatMap((p) => (p.lines ? [p.lines] : []));
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
    const current = tab.pages.map((page): PageView => ({
      ...page,
      transcript: findSamePage(tab.records, page.pageHash)?.transcript ?? { state: 'analyzing' },
    }));
    views.set(tab.tabId, current);
    deps.publish(tab.tabId, current);
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
      text = await deps.analyze(request);
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
      complete(job, { state: 'done', text, translated: false });
      return false;
    }
    job.translator = translator;
    return true;
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
    report(job, 'llm');
    const { long } = record;
    const transcript = await pageTranslation.translate({
      text: job.added ?? record.text!,
      translator: job.translator,
      seriesId: record.seriesId,
      pageHash: record.pageHash,
      group: job.group,
      priorPages: priorPages(job),
      ...(long ? { long: longRequest(job, long) } : {}),
    });
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
    return {
      stripes: long.stripes,
      // 翻譯期間下一截可能又收了新的 Line：回來時才併回當下的整個 Page
      whole: (part) => (record.text = replaceLines(record.text!, part)),
      ...(continues ? { charge } : {}),
      charged: (next) => (long.charge = next),
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
  function requestSlice(record: PageRecord, page: PageThumb, capture: CropRequest, spec: Omit<JobSpec, 'record' | 'request'>): void {
    const long = record.long!;
    const slice = sliceOf(page.rect, page.visible!);
    if (sameSlice(long.slice, slice) || record.transcript.state === 'pending') return;
    long.slice = slice;
    const request = analyzeRequestOf(page, capture);
    if (record.job && !record.job.started) record.job.request = request;
    else enqueueLocal(newJob({ ...spec, record, request }));
  }

  /** 長 Page 查快取：命中就換成快取裡的身分，已收的 Line 從快取接著收，看過的橫條併起來。 */
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
    if (cached.charge) long.charge = cached.charge;
    if (transcript.state === 'done') record.text = transcript.text;
    tab.pages = tab.pages.map((p) => (p.anchorId === long.anchorId && p.pageHash === provisional ? { ...p, pageHash: cached.pageHash } : p));
    return transcript;
  }

  /**
   * 新的擷取：可見的 Page 換成這一批。新 Page 先查快取，沒命中就排進佇列（自動翻譯關著時停在 pending）。
   * 回傳的 promise 在這一批可見 Page 的工作都做完（或被丟掉）時 resolve。
   */
  async function update(tabId: number, pages: PageThumb[], capture: CropRequest | undefined): Promise<void> {
    // 沒有截圖＝畫面上沒有完整可見的 Page
    if (!capture) pages = [];
    let tab = tabs.get(tabId);
    if (!tab) {
      tab = { tabId, pages: [], records: [] };
      tabs.set(tabId, tab);
    }
    // 長 Page 換成認出的 Page 的身分；認不出、又沒有橫條可以認的先不處理（例如這一截全是留白）
    const longOf = new Map<PageThumb, PageRecord>();
    const current = tab;
    pages = pages.flatMap((page) => {
      if (!page.visible) return [page];
      const known = identifyLongPage(current, page);
      if (known) {
        known.long!.anchorId = page.anchorId;
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
        request: analyzeRequestOf(page, capture!),
        transcript: { state: 'analyzing' },
        settled: Promise.resolve(),
        ...(page.visible ? { long: { anchorId: page.anchorId, stripes: page.stripes ?? [], slice: sliceOf(page.rect, page.visible) } } : {}),
      };
      tab.records.push(record);
      visibleRecords.add(record);
      newPages.push({ record, index });
    }
    queue.dropUnwanted();
    publish(tab);

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
      jobs.map((job) => (job.record.long ? lookupLong(tab, seriesId, job.record) : pageTranslation.lookup(seriesId, job.record.pageHash))),
    );
    // 快取都查完才依閱讀順序排：佇列一有工作就開始跑，Spread 的左頁先查完也不能比右頁先送出 LLM（spec 第 3.4 節）
    for (const [i, job] of jobs.entries()) {
      const { record } = job;
      const cached = lookups[i];
      if (!isCurrent(tab)) finish(job, undefined);
      else if (cached && record.long && autoTranslate.get(tabId) !== false) {
        // 長 Page 命中快取：先顯示快取的整個 Page，這一截照樣辨識，收快取裡還沒有的 Line
        record.transcript = cached;
        enqueueLocal(job);
      } else if (cached) finish(job, cached);
      else if (!isVisible(tab, record)) {
        tab.records = tab.records.filter((r) => r !== record);
        finish(job, undefined);
      } else if (autoTranslate.get(tabId) === false) finish(job, { state: 'pending' });
      else enqueueLocal(job);
    }
    for (const { record, page, index } of slices) requestSlice(record, page, capture!, { tab, batch, index, group: groupOf(record) });
    if (newPages.some(({ record }) => record.long)) publish(tab);
    await Promise.all([...visibleRecords].map((r) => r.settled));
  }

  /**
   * 「翻譯此頁／重新翻譯／重試」：可見的 Page 裡，pending 的排進佇列；已辨識完的重新翻譯（不重跑 OCR）。
   * 已有工作在跑的不重複排。沒有 key 時只會跑 pending 的本機流水線。
   * pageHash：只翻這一頁（過時提示的「重新翻譯」，#38）；命中快取的頁沒有 OCR 結果，就用快取裡的原文送出。
   */
  async function translate(tabId: number, pageHash?: string): Promise<void> {
    const tab = tabs.get(tabId);
    if (!tab) return;
    const translator = await deps.getTranslator();
    const pages = pageHash === undefined ? tab.pages : tab.pages.filter((p) => p.pageHash === pageHash);
    const visible = [...new Set(pages.flatMap((p) => findSamePage(tab.records, p.pageHash) ?? []))];
    if (pageHash !== undefined) for (const record of visible) if (record.transcript.state === 'done') record.text ??= record.transcript.text;
    await start(tab, visible, translator);
  }

  /**
   * 能翻譯了（同意、登入，#93）：自動翻譯開著的 tab，畫面上辨識完、還沒翻譯的頁直接翻，不必再按「翻譯此頁」。
   * 已翻好（含快取）的不重翻；自動翻譯關著的 tab 照舊等讀者按。
   */
  async function translateUntranslated(): Promise<void> {
    const translator = await deps.getTranslator();
    if (!translator) return;
    await Promise.all(
      [...tabs.values()]
        .filter((tab) => isAutoTranslate(tab.tabId))
        .map((tab) => {
          const waiting = tab.pages.flatMap((p) => {
            const record = findSamePage(tab.records, p.pageHash);
            return record?.transcript.state === 'done' && !record.transcript.translated ? [record] : [];
          });
          return start(tab, [...new Set(waiting)], translator);
        }),
    );
  }

  /** 把這些可見的 Page 排進佇列：pending 的跑本機流水線，辨識完的（有 Translator 時）重新翻譯；已有工作在跑的不重複排。 */
  async function start(tab: TabState, visible: PageRecord[], translator: Translator | undefined): Promise<void> {
    const batch = ++batches;
    const groupOf = snapshotGroups();
    const started: PageRecord[] = [];
    for (const [index, record] of visible.entries()) {
      if (record.job) continue;
      if (record.transcript.state === 'pending') {
        record.transcript = { state: 'analyzing' };
        enqueueLocal(newJob({ tab, record, batch, index, group: groupOf(record) }));
      } else if (translator && record.transcript.state === 'done' && record.text) {
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

  /** side panel 的「自動翻譯」開關（每個 tab；預設開，停止後回到預設）。打開時把 pending 的 Page 排進佇列。 */
  function setAutoTranslate(tabId: number, enabled: boolean): Promise<void> {
    autoTranslate.set(tabId, enabled);
    return enabled ? translatePending(tabId) : Promise.resolve();
  }

  async function translatePending(tabId: number): Promise<void> {
    const tab = tabs.get(tabId);
    if (!tab || !tab.records.some((r) => r.transcript.state === 'pending')) return;
    await translate(tabId);
  }

  function isAutoTranslate(tabId: number): boolean {
    return autoTranslate.get(tabId) ?? true;
  }

  function get(tabId: number): PageView[] {
    return views.get(tabId) ?? [];
  }

  /**
   * 同 origin 重新整理（content script 重新注入，anchor 都換了）：忘掉畫面上的 Page，下次擷取重新查快取。
   * 還沒開始的工作丟掉，已開始的做完只寫快取。設定（自動翻譯）保留。
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

  /** 停止或關 tab：同 resetPages，設定與看過的頁也忘掉。 */
  function clear(tabId: number): void {
    autoTranslate.delete(tabId);
    seen.delete(tabId);
    resetPages(tabId);
  }

  return {
    update,
    translate,
    translateUntranslated,
    setAutoTranslate,
    isAutoTranslate,
    get,
    resetPages,
    reassignSeries,
    notesChanged,
    updateNotes,
    clear,
    /** 背景整理 Notes（②）都做完時 resolve（測試用）。 */
    notesSettled: pageTranslation.notesSettled,
  };
}
