/**
 * 一個 Page 的翻譯與快取（spec #27 第 3、4.3 節、ADR 0005）：
 * - ① 翻譯：帶送出時的 Notes 快照與 Prior Pages，回來就寫快取（#33）、顯示，不等 Notes。
 * - ② 整理 Notes：① 成功後在背景送出，依 ② 送出的順序套用 notes_changes（順序在 notes-ledger.ts）。
 *   失敗就跳過、不重試，只記在 trace，譯文不受影響。
 * 查快取時判斷過時（#38）。排程、每個 tab 的畫面狀態與 Prior Pages 在 transcribe.ts。
 */
import { matchingStripe, type Stripe } from '../shared/long-page.ts';
import type { PageView } from '../shared/messages.ts';
import { pageLines, type PageCharge, type PageText, type PageTranslation } from '../shared/page-text.ts';
import { staleReason, usedNotes, type StaleReason, type TranslatorVersion } from '../shared/series-notes.ts';
import type { Series } from '../shared/series.ts';
import { createTrace } from '../shared/trace.ts';
import type { NotesChanges, NotesEntry, PriorPage, TranslateInput, TranslateOutput, Translator } from '../shared/translator.ts';
import { QuotaExhaustedError } from './hosted-translator.ts';
import type { NotesLedger, SnapshotGroup } from './notes-ledger.ts';

export interface PageCache {
  /** 同一個 Series 裡 hash 在門檻內最接近的一筆（長 Page 不算）。 */
  find(seriesId: string, pageHash: string): Promise<PageTranslation | undefined>;
  /** 同一個 Series 裡任何一條橫條對得上的長 Page（spec #142）。 */
  findLong(seriesId: string, stripes: readonly Stripe[]): Promise<PageTranslation | undefined>;
  save(translation: PageTranslation): Promise<void>;
}

export type Transcript = PageView['transcript'];

export interface PageTranslationDeps {
  cache: PageCache;
  ledger: NotesLedger;
  getSeries(seriesId: string): Promise<Series | undefined>;
  /** 目前會用來翻譯的模型與 prompt 版本（過時提示比對用）；沒有 Translator 時 undefined，就不比版本。 */
  translatorVersion?(): TranslatorVersion | undefined | Promise<TranslatorVersion | undefined>;
}

/** 要翻的一頁。 */
export interface TranslateRequest {
  /** 本機流水線的結果（kuromoji 讀音）；翻譯失敗時就顯示它。 */
  text: PageText;
  /** 沒有 API key 時 undefined。 */
  translator: Translator | undefined;
  /** 沒有 Series 時不帶 Notes、不套用、不寫快取。 */
  seriesId: string | undefined;
  pageHash: string;
  /** 同一組的頁共用 ② 的 Notes 快照。 */
  group: SnapshotGroup;
  /** 這部 Series 在這一批之前最近看過、已經翻好的頁（ADR 0005）。 */
  priorPages: PriorPage[];
  /** 長 Page（spec #142）才有：text 只是新收的 Line。 */
  long?: LongPageRequest;
}

/** 長 Page 的一次翻譯：只翻新收的 Line，顯示與快取的是整個 Page。 */
export interface LongPageRequest {
  /** 看過的橫條，跟整個 Page 的 Line 一起存進快取。 */
  stripes: Stripe[];
  /** 這次的 Line（翻好或沒翻好）併回整個 Page。 */
  whole(part: PageText): PageText;
  /** 接續同一個 Page（不是重新翻譯整個 Page）時：這個 Page 扣頁的那次（Hosted Translation 才有），帶上它的 usageRecordId。 */
  charge?: PageCharge;
  /** 翻好時這個 Page 扣頁的那次（Hosted Translation 才有），也跟著存進快取；下一截接續時帶。 */
  charged?(charge: PageCharge): void;
}

const trace = createTrace('sw');

/** 只送讀者取的名稱：Provisional Series 的名稱是自動產生的（網站＋日期），不是作品名。 */
function seriesName(series: Series | undefined): Pick<TranslateInput, 'seriesName'> {
  return series && !series.provisional ? { seriesName: series.name } : {};
}

function toTranslateInput(text: PageText, seriesNotes: NotesEntry[], priorPages: PriorPage[]): Omit<TranslateInput, 'seriesName'> {
  const items = [
    ...text.balloons.map((b) => ({ order: b.order, item: { id: b.id, kind: 'balloon' as const, 原文: b.原文, orientation: b.orientation } })),
    ...text.looseText.map((l) => ({ order: l.order, item: { id: l.id, kind: 'loose' as const, 原文: l.原文, orientation: l.orientation } })),
  ];
  return { seriesNotes, priorPages, items: items.sort((a, b) => a.order - b.order).map((i) => i.item) };
}

function applyTranslation(text: PageText, output: TranslateOutput): PageText {
  const byId = new Map(output.items.map((item) => [item.id, item]));
  const merge = <T extends { id: string; 讀音: string; 讀音來源: 'llm' | 'kuromoji'; 譯文: string; unreadable: boolean; sfx?: boolean }>(entry: T): T => {
    const item = byId.get(entry.id);
    if (!item) return entry;
    // 本機流水線已判 unreadable（OCR 信心低於門檻，ADR 0009）的段，LLM 讀得懂也維持 unreadable
    const merged = { ...entry, 讀音: item.讀音, 讀音來源: 'llm' as const, 譯文: item.譯文, unreadable: entry.unreadable || item.unreadable };
    return item.sfx === undefined ? merged : { ...merged, sfx: item.sfx };
  };
  return { balloons: text.balloons.map(merge), looseText: text.looseText.map(merge) };
}

/** Worker 回的 usageRecordId 是哪一次扣頁：接續成功時回原本那筆，時間照舊；不一樣就是這次新扣的。 */
function chargeOf(previous: PageCharge | undefined, usageRecordId: number | undefined): PageCharge | undefined {
  if (usageRecordId === undefined) return undefined;
  return previous?.usageRecordId === usageRecordId ? previous : { usageRecordId, chargedAt: Date.now() };
}

export function createPageTranslation({ cache, ledger, getSeries, translatorVersion }: PageTranslationDeps) {
  /** 還在背景跑的 ②。 */
  const pendingNotes = new Set<Promise<void>>();

  /**
   * ②：這頁的原文＋① 的譯文送去整理 Notes。送出的這一刻拿號碼牌，notes_changes 依 ② 送出順序套用；
   * Spread 的兩頁（同一組）共用一份快照。失敗就跳過，只讓出順序。
   * pageUsageRecordId 是 ① 的 usageRecordId（Hosted Translation 才有），Worker 用它把 Notes 的用量歸到這一頁。
   */
  async function proposeNotes(
    translator: Translator,
    seriesId: string,
    pageHash: string,
    group: SnapshotGroup,
    text: PageText,
    pageUsageRecordId: number | undefined,
  ): Promise<void> {
    const turn = ledger.checkout(seriesId, group);
    const startedAt = Date.now();
    let changes: NotesChanges;
    try {
      const output = await translator.proposeNotes({
        seriesNotes: await turn.notes,
        items: pageLines(text),
        ...(pageUsageRecordId === undefined ? {} : { pageUsageRecordId }),
      });
      trace('notes:done', { pageHash, ms: Date.now() - startedAt, model: output.model, usage: output.usage });
      changes = output.notes_changes;
    } catch (e) {
      console.warn('notes update failed', e);
      trace('notes:error', { pageHash, ms: Date.now() - startedAt, error: e });
      turn.release();
      return;
    }
    await turn.commit(changes, { pageHash, balloonTexts: text.balloons.map((b) => b.原文) });
  }

  function inBackground(work: Promise<void>): void {
    pendingNotes.add(work);
    void work.finally(() => pendingNotes.delete(work));
  }

  /** 翻譯一頁（①）；只有翻譯成功才寫快取，接著在背景整理 Notes（②）。 */
  async function translate({ text, translator, seriesId, pageHash, group, priorPages, long }: TranslateRequest): Promise<Transcript> {
    const whole = long?.whole ?? ((part: PageText) => part);
    if (!translator) return { state: 'done', text: whole(text), translated: false };
    // 送出時的 Notes 快照：送進 prompt，也是快取的 usedNotes
    const [seriesNotes, series] = seriesId === undefined ? [[], undefined] : await Promise.all([ledger.list(seriesId), getSeries(seriesId)]);
    let output: TranslateOutput;
    const startedAt = Date.now();
    try {
      const continues = long?.charge?.usageRecordId;
      output = await translator.translatePage({
        ...seriesName(series),
        ...toTranslateInput(text, seriesNotes, priorPages),
        ...(continues === undefined ? {} : { pageUsageRecordId: continues }),
      });
      trace('translate:done', { pageHash, ms: Date.now() - startedAt, model: output.model, usage: output.usage, priorPages: priorPages.length, continues, usageRecordId: output.usageRecordId });
    } catch (e) {
      trace('translate:error', { pageHash, ms: Date.now() - startedAt, error: e });
      // 額度用完不是失敗：跟沒有 Translator 一樣只顯示原文與讀音，用完的提示在 side panel 頂端
      if (e instanceof QuotaExhaustedError) return { state: 'done', text: whole(text), translated: false };
      // 429／5xx 的重試在 Translator 裡（claude-translator.ts）；這裡是重試後仍失敗
      console.warn('translate failed', e);
      return { state: 'done', text: whole(text), translated: false, translateError: e instanceof Error ? e.message : String(e) };
    }
    const charge = long && chargeOf(long.charge, output.usageRecordId);
    if (charge) long.charged?.(charge);
    const translated = applyTranslation(text, output);
    const page = whole(translated);
    const { model, latencyMs, usage } = output;
    if (seriesId !== undefined) {
      // 過時提示（#38）拿它跟目前的版本比，所以兩個欄位都記送出時的版本（同一個來源）。API 回報的模型 ID 可能跟送出的
      // 不同（例如帶日期），用它比對會讓每頁都過時；沒有版本資訊時才退回 API 回報的。
      const version = await translatorVersion?.();
      const entry: PageTranslation = {
        ...page,
        seriesId,
        pageHash,
        ...(long ? { stripes: long.stripes } : {}),
        ...(charge ? { charge } : {}),
        usedNotes: usedNotes(seriesNotes, [...page.balloons, ...page.looseText].map((t) => t.原文)),
        model: version?.model ?? model,
        promptVersion: version?.promptVersion ?? '',
        usage,
        latencyMs,
        translatedAt: Date.now(),
      };
      // 寫不進去只是下次要重翻，這次的結果照樣顯示。
      await cache.save(entry).catch((e: unknown) => console.warn('cache save failed', e));
      inBackground(proposeNotes(translator, seriesId, pageHash, group, translated, output.usageRecordId));
    }
    return { state: 'done', text: page, translated: true, translation: { source: 'translated', model, latencyMs, usage } };
  }

  /** 背景的 ② 都套用完（或跳過）時 resolve，包含等待期間才送出的。 */
  async function notesSettled(): Promise<void> {
    while (pendingNotes.size > 0) await Promise.all(pendingNotes);
  }

  /** 快取的這頁過時了沒（#38）。讀不到 Notes 就當沒過時：只是少一個提示。 */
  async function staleOf(cached: PageTranslation): Promise<StaleReason | undefined> {
    const [entries, version] = await Promise.all([ledger.list(cached.seriesId), translatorVersion?.()]);
    return staleReason(cached, entries, version);
  }

  /** 查快取；命中就回傳要顯示的逐字稿（含過時提示）。 */
  async function lookup(seriesId: string | undefined, pageHash: string): Promise<Transcript | undefined> {
    if (seriesId === undefined) {
      trace('cache:noSeries', { pageHash });
      return undefined;
    }
    const cached = await cache.find(seriesId, pageHash).catch((e: unknown) => {
      console.warn('cache lookup failed', e);
      return undefined;
    });
    if (!cached) {
      trace('cache:miss', { seriesId, pageHash });
      return undefined;
    }
    return hit(cached, { seriesId, pageHash });
  }

  /** 命中快取時要顯示的逐字稿（含過時提示）。 */
  async function hit(cached: PageTranslation, query: Record<string, unknown>): Promise<Transcript> {
    const { balloons, looseText, model, latencyMs, usage } = cached;
    const stale = await staleOf(cached);
    trace('cache:hit', { ...query, cachedHash: cached.pageHash, stale });
    // 命中快取時沒有本機流水線的結果（text），「翻譯此頁／重新翻譯」不會重翻這頁。
    return { state: 'done', text: { balloons, looseText }, translated: true, translation: { source: 'cache', model, latencyMs, usage }, stale };
  }

  /**
   * 長 Page 查快取（spec #142）：任何一條橫條對得上就命中，連同快取裡的身分與看過的橫條一起回傳。
   * trace 記對上的是第幾條（真實網站驗收時核對「靠哪一條認出來」）。
   */
  async function lookupLong(seriesId: string | undefined, stripes: readonly Stripe[]): Promise<{ transcript: Transcript; cached: PageTranslation } | undefined> {
    if (seriesId === undefined) return undefined;
    const cached = await cache.findLong(seriesId, stripes).catch((e: unknown) => {
      console.warn('cache lookup failed', e);
      return undefined;
    });
    if (!cached) {
      trace('cache:miss', { seriesId, stripes });
      return undefined;
    }
    return { transcript: await hit(cached, { seriesId, stripes, stripe: matchingStripe(cached.stripes ?? [], stripes) }), cached };
  }

  return { translate, lookup, lookupLong, staleOf, notesSettled };
}

export type PageTranslator = ReturnType<typeof createPageTranslation>;
