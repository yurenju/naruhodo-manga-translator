/**
 * Series 的選擇與歸類（spec #27 第 4.1 節、#36）：網址模式預選、Provisional Series、改名、合併。
 * 儲存從 SeriesRepo 注入（SW 接 IndexedDB，測試用記憶體）。
 */
import type { PageTranslation } from '../shared/page-text.ts';
import { mergeNotes, type NotesSuggestion } from '../shared/series-notes.ts';
import type { Series, SeriesOption, UrlPattern } from '../shared/series.ts';
import { createTrace } from '../shared/trace.ts';
import type { NotesEntry } from '../shared/translator.ts';
import { mergeTranslations, provisionalSeries, seriesMenu, urlPattern } from './series.ts';

/** 合併要一次寫完的內容（IndexedDB 實作放在同一個 transaction）。 */
export interface SeriesMerge {
  sourceId: string;
  targetId: string;
  /** 要寫進目標的快取（已改用目標 ID）。 */
  translations: PageTranslation[];
  /** 目標合併後的全部 Notes 條目。 */
  notes: NotesEntry[];
  /** 要新增到目標的建議修改。 */
  suggestions: NotesSuggestion[];
}

export interface SeriesRepo {
  getSeries(id: string): Promise<Series | undefined>;
  listSeries(): Promise<Series[]>;
  putSeries(series: Series): Promise<void>;
  getPattern(pattern: string): Promise<UrlPattern | undefined>;
  listPatterns(): Promise<UrlPattern[]>;
  putPattern(pattern: UrlPattern): Promise<void>;
  listTranslations(seriesId: string): Promise<PageTranslation[]>;
  listNotes(seriesId: string): Promise<NotesEntry[]>;
  listSuggestions(seriesId: string): Promise<NotesSuggestion[]>;
  /** 寫入 translations／notes／suggestions，再刪掉來源 Series 與它的快取、Notes、建議修改。 */
  commitMerge(merge: SeriesMerge): Promise<void>;
}

export interface SeriesCatalogDeps {
  repo: SeriesRepo;
  now(): Date;
  newId(): string;
}

const trace = createTrace('sw');

export function createSeriesCatalog(deps: SeriesCatalogDeps) {
  const { repo } = deps;
  /** 歸類後才記住網址模式；Provisional Series 不記。 */
  async function remember(seriesId: string, url: string): Promise<void> {
    const series = await repo.getSeries(seriesId);
    if (!series || series.provisional) return;
    const pattern = urlPattern(url);
    await repo.putPattern({ pattern, seriesId, lastUsedAt: deps.now().getTime() });
    trace('series:remember', { pattern, seriesId });
  }

  /** 網址模式記住的 Series（更新最近使用時間）；沒記住或那部 Series 已經不在是 undefined。 */
  async function rememberedSeries(url: string): Promise<string | undefined> {
    const pattern = await repo.getPattern(urlPattern(url));
    if (!pattern || !(await repo.getSeries(pattern.seriesId))) return undefined;
    await repo.putPattern({ ...pattern, lastUsedAt: deps.now().getTime() });
    return pattern.seriesId;
  }

  return {
    /** 新的啟動：網址模式預選到的 Series（更新最近使用時間），沒有就建一個 Provisional Series。 */
    async seriesForUrl(url: string): Promise<string> {
      const remembered = await rememberedSeries(url);
      if (remembered !== undefined) {
        trace('series:forUrl', { pattern: urlPattern(url), seriesId: remembered, preselected: true });
        return remembered;
      }
      const series = provisionalSeries(url, deps.now(), deps.newId());
      await repo.putSeries(series);
      trace('series:forUrl', { pattern: urlPattern(url), seriesId: series.id, preselected: false });
      return series.id;
    },

    /**
     * 同分頁導航到另一個網址（#145）：只用網址模式找，對不上不建 Provisional Series。
     * 網址模式是完整網址比對，同作品的下一話對不上，由呼叫端沿用目前的 Series。
     */
    rememberedSeries,

    async menu(): Promise<SeriesOption[]> {
      const [series, patterns] = await Promise.all([repo.listSeries(), repo.listPatterns()]);
      return seriesMenu(series, patterns);
    },

    /** 在下拉選單選了一部 Series。 */
    select: remember,

    /** 「新增 Series…」：建一部（非 Provisional）Series 並記住這個網址。 */
    async create(name: string, url: string): Promise<Series> {
      const series: Series = { id: deps.newId(), name, provisional: false, createdAt: deps.now().getTime() };
      await repo.putSeries(series);
      await remember(series.id, url);
      return series;
    },

    /** 改名＝拿掉 provisional、ID 不變；等於歸類，所以記住網址。 */
    async rename(seriesId: string, name: string, url: string): Promise<void> {
      const series = await repo.getSeries(seriesId);
      if (!series) return;
      await repo.putSeries({ ...series, name, provisional: false });
      await remember(seriesId, url);
    },

    /**
     * 把 Provisional Series 合併進既有 Series：快取改用目標 ID（同一個 Page 保留目標的）、Notes 依只能新增規則
     * 併入（衝突變成建議修改）、刪掉臨時 Series、記住網址。合併後不自動重翻。
     * 來源必須是 Provisional Series、目標必須存在；不符合就什麼都不動，回傳 false。
     */
    async merge(sourceId: string, targetId: string, url: string): Promise<boolean> {
      if (sourceId === targetId) return false;
      const [source, target] = await Promise.all([repo.getSeries(sourceId), repo.getSeries(targetId)]);
      if (!source?.provisional || !target) return false;
      const [targetCache, sourceCache, targetNotes, sourceNotes, sourceSuggestions] = await Promise.all([
        repo.listTranslations(targetId),
        repo.listTranslations(sourceId),
        repo.listNotes(targetId),
        repo.listNotes(sourceId),
        repo.listSuggestions(sourceId),
      ]);
      const notes = mergeNotes(targetNotes, sourceNotes, { seriesId: targetId, 來源: { mergedFrom: sourceId } });
      await repo.commitMerge({
        sourceId,
        targetId,
        translations: mergeTranslations(targetCache, sourceCache, targetId),
        notes: notes.entries,
        suggestions: [...sourceSuggestions.map((s) => ({ ...s, seriesId: targetId })), ...notes.suggestions],
      });
      trace('series:merge', { sourceId, targetId, translations: sourceCache.length, notes: sourceNotes.length, suggestions: notes.suggestions.length });
      await remember(targetId, url);
      return true;
    },
  };
}

export type SeriesCatalog = ReturnType<typeof createSeriesCatalog>;
