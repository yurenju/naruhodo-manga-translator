/**
 * Series 的選擇與歸類（spec #27 第 4.1 節、#36、#186）：網址模式預選、依 Original Title 自動歸類、Provisional Series、
 * 確認、改名、合併。
 * 儲存從 SeriesRepo 注入（SW 接 IndexedDB，測試用記憶體）。
 */
import type { PageTranslation } from '../shared/page-text.ts';
import { mergeNotes, type NotesSuggestion } from '../shared/series-notes.ts';
import { normalizeTitle, type Series, type SeriesOption, type TitleGuess, type UrlPattern } from '../shared/series.ts';
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

/**
 * 這次啟動（或同分頁換網址後）歸到哪部 Series、為什麼（side panel 顯示「為什麼歸到這部」）：
 * urlPattern＝網址模式命中；title＝猜到的原名命中既有 Series；created＝猜到原名、新建 Provisional Series；
 * unnamed＝猜不出來、新建未命名的 Provisional Series。originalTitle 是這次猜到的原名（讀者選別部時記到那部上）。
 */
export interface SeriesAssignment {
  seriesId: string;
  by: 'urlPattern' | 'title' | 'created' | 'unnamed';
  originalTitle?: string;
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

/** 這部 Series 有沒有這個原名（正規化後比對）。 */
const hasTitle = (series: Series, title: string) => series.originalTitles?.some((t) => normalizeTitle(t) === normalizeTitle(title)) ?? false;

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

  /** 原名命中的 Series：確認過的優先，其次最新建的。 */
  async function seriesWithTitle(title: string): Promise<Series | undefined> {
    const matches = (await repo.listSeries()).filter((s) => hasTitle(s, title));
    return matches.sort((a, b) => Number(a.provisional) - Number(b.provisional) || b.createdAt - a.createdAt)[0];
  }

  /** 原名命中既有 Series（Provisional 也算）就是它；沒有就新建一部 Provisional Series，名稱用原名。 */
  async function seriesForGuess(guess: TitleGuess, url = ''): Promise<SeriesAssignment> {
    const existing = await seriesWithTitle(guess.原名);
    if (existing) return { seriesId: existing.id, by: 'title', originalTitle: guess.原名 };
    const series = provisionalSeries(url, deps.now(), deps.newId(), guess);
    await repo.putSeries(series);
    return { seriesId: series.id, by: 'created', originalTitle: guess.原名 };
  }

  /**
   * 把這次猜到的原名記到讀者選的 Series 上（一部可以有多個），下次猜到同一個原名就直接歸到那裡。
   * 其他 Provisional Series 不再用這個原名歸類（讀者已經說了不是那部）；確認過的不動。
   */
  async function rememberTitle(seriesId: string, title: string | undefined): Promise<void> {
    if (!title) return;
    for (const series of await repo.listSeries()) {
      if (series.id === seriesId) {
        if (!hasTitle(series, title)) await repo.putSeries({ ...series, originalTitles: [...(series.originalTitles ?? []), title] });
      } else if (series.provisional && hasTitle(series, title)) {
        await repo.putSeries({ ...series, originalTitles: series.originalTitles!.filter((t) => normalizeTitle(t) !== normalizeTitle(title)) });
      }
    }
    trace('series:rememberTitle', { seriesId, originalTitle: title });
  }

  return {
    /**
     * 新的啟動（#186 的優先順序）：網址模式命中 → 猜到的原名命中既有 Series（Provisional 也算）→ 猜到原名就新建
     * Provisional Series → 猜不出來就建未命名的 Provisional Series。網址模式命中時不猜（guess 不呼叫）。
     */
    async seriesForUrl(url: string, guess: () => Promise<TitleGuess | undefined>): Promise<SeriesAssignment> {
      const remembered = await rememberedSeries(url);
      let assigned: SeriesAssignment;
      if (remembered !== undefined) assigned = { seriesId: remembered, by: 'urlPattern' };
      else {
        const guessed = await guess();
        if (guessed) assigned = await seriesForGuess(guessed, url);
        else {
          const series = provisionalSeries(url, deps.now(), deps.newId());
          await repo.putSeries(series);
          assigned = { seriesId: series.id, by: 'unnamed' };
        }
      }
      trace('series:forUrl', { pattern: urlPattern(url), ...assigned });
      return assigned;
    },

    /** 同分頁換網址後重猜到了原名（#186）：命中既有 Series 就是它，沒有就新建 Provisional Series。 */
    seriesForGuess: (guess: TitleGuess) => seriesForGuess(guess),

    /**
     * 同分頁導航到另一個網址（#145）：只用網址模式找，對不上不建 Provisional Series。
     * 網址模式是完整網址比對，同作品的下一話對不上，由呼叫端沿用目前的 Series。
     */
    rememberedSeries,

    async menu(): Promise<SeriesOption[]> {
      const [series, patterns] = await Promise.all([repo.listSeries(), repo.listPatterns()]);
      return seriesMenu(series, patterns);
    },

    /**
     * 讀者選了一部 Series：這次猜到的原名（originalTitle）記到它上面；確認過的 Series 才記住網址模式。
     * 選 Provisional Series 不算確認。
     */
    async select(seriesId: string, url: string, originalTitle?: string): Promise<void> {
      await rememberTitle(seriesId, originalTitle);
      await remember(seriesId, url);
    },

    /** 作品卡的「是」（#186）：拿掉 provisional、記住網址模式（等於選了一部確認過的作品）。 */
    async confirm(seriesId: string, url: string): Promise<void> {
      const series = await repo.getSeries(seriesId);
      if (!series) return;
      if (series.provisional) await repo.putSeries({ ...series, provisional: false });
      await remember(seriesId, url);
    },

    /** 「新增作品…」：建一部（非 Provisional）Series、記下這次猜到的原名，並記住這個網址。 */
    async create(name: string, url: string, originalTitle?: string): Promise<Series> {
      const series: Series = { id: deps.newId(), name, provisional: false, createdAt: deps.now().getTime() };
      await repo.putSeries(series);
      await rememberTitle(series.id, originalTitle);
      await remember(series.id, url);
      return (await repo.getSeries(series.id)) ?? series;
    },

    /** 改名（取名字）＝拿掉 provisional、ID 不變；讀者的名稱為準，猜的中文譯名拿掉。等於確認，所以記住網址。 */
    async rename(seriesId: string, name: string, url: string): Promise<void> {
      const series = await repo.getSeries(seriesId);
      if (!series) return;
      const { zhTitle: _zhTitle, ...rest } = series;
      await repo.putSeries({ ...rest, name, provisional: false });
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
      for (const title of source.originalTitles ?? []) await rememberTitle(targetId, title);
      await remember(targetId, url);
      return true;
    },
  };
}

export type SeriesCatalog = ReturnType<typeof createSeriesCatalog>;
