/**
 * 匯出／匯入 JSON（spec #27 第 4.2、8 節、#38）：兩台電腦之間不同步，靠這個搬 Series、網址模式、Series Notes 與翻譯快取。
 * **不含 API key**：只讀這五個 store，apiKeys store 碰都不碰（spec 第 5 節）。翻譯快取裡的擦除小圖也不帶（#149）。
 *
 * 匯入＝合併，本機優先（跟 #36 合併 Series 同一套規則）：本機沒有的 Series／網址模式才加；Notes 照只能新增規則併入，
 * 譯文衝突變成建議修改；同一個 Page 的快取保留本機那份。Notes 經過 notes-ledger 寫，不會跟翻譯中的套用互相蓋掉。
 */
import { forBackup, type PageTranslation } from '../shared/page-text.ts';
import { mergeImportedNotes, type NotesSuggestion, type SeriesNotes } from '../shared/series-notes.ts';
import type { Series, UrlPattern } from '../shared/series.ts';
import type { NotesEntry } from '../shared/translator.ts';
import { mergeTranslations } from './series.ts';

const FORMAT = 'naruhodo-backup';

/** 匯出檔的內容（一個 IndexedDB store 一個陣列）。 */
export interface BackupData {
  series: Series[];
  urlPatterns: UrlPattern[];
  seriesNotes: NotesEntry[];
  notesSuggestions: NotesSuggestion[];
  pageTranslations: PageTranslation[];
}

export interface BackupFile extends BackupData {
  format: typeof FORMAT;
  version: 1;
  exportedAt: number;
}

export interface BackupRepo {
  /** 五個 store 的全部內容。 */
  dump(): Promise<BackupData>;
  getSeries(id: string): Promise<Series | undefined>;
  putSeries(series: Series): Promise<void>;
  getPattern(pattern: string): Promise<UrlPattern | undefined>;
  putPattern(pattern: UrlPattern): Promise<void>;
  listTranslations(seriesId: string): Promise<PageTranslation[]>;
  putTranslations(translations: PageTranslation[]): Promise<void>;
}

/** 匯出檔裡的五個陣列（BackupData 的欄位）。 */
export const BACKUP_KEYS = ['series', 'urlPatterns', 'seriesNotes', 'notesSuggestions', 'pageTranslations'] as const;

/** 不是這個外掛的匯出檔就丟錯（訊息直接顯示在 side panel）。 */
function parse(data: unknown): BackupFile {
  const file = data as Partial<BackupFile> | null;
  if (file?.format !== FORMAT || file.version !== 1 || !BACKUP_KEYS.every((key) => Array.isArray(file[key])))
    throw new Error('不是漫畫翻譯的匯出檔');
  return file as BackupFile;
}

/** Map.groupBy 要 Chrome 117，minimum_chrome_version 是 116。 */
function groupBySeries<T extends { seriesId: string }>(rows: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(row.seriesId, [...(groups.get(row.seriesId) ?? []), row]);
  return groups;
}

export interface BackupDeps {
  repo: BackupRepo;
  /** 經過 notes-ledger 寫 Notes（transcriber.updateNotes）。 */
  updateNotes(seriesId: string, change: (notes: SeriesNotes) => SeriesNotes): Promise<unknown>;
  now(): number;
}

export function createBackup(deps: BackupDeps) {
  const { repo } = deps;
  return {
    async exportAll(): Promise<BackupFile> {
      // 只挑這五個陣列：repo 多讀了別的 store（例如 apiKeys）也不會跟著寫進檔案
      const { series, urlPatterns, seriesNotes, notesSuggestions, pageTranslations } = await repo.dump();
      return {
        format: FORMAT,
        version: 1,
        exportedAt: deps.now(),
        series,
        urlPatterns,
        seriesNotes,
        notesSuggestions,
        // 擦除小圖（#149）與長 Page 的扣頁紀錄只留在本機
        pageTranslations: pageTranslations.map(forBackup),
      };
    },

    /** 回傳 Notes 有寫入的 Series ID（要通知 side panel）。 */
    async importAll(data: unknown): Promise<string[]> {
      const file = parse(data);
      for (const series of file.series) if (!(await repo.getSeries(series.id))) await repo.putSeries(series);
      for (const pattern of file.urlPatterns) if (!(await repo.getPattern(pattern.pattern))) await repo.putPattern(pattern);

      const notes = groupBySeries(file.seriesNotes);
      const suggestions = groupBySeries(file.notesSuggestions);
      const touched = [...new Set([...notes.keys(), ...suggestions.keys()])];
      for (const seriesId of touched) {
        const incoming = { entries: notes.get(seriesId) ?? [], suggestions: suggestions.get(seriesId) ?? [] };
        await deps.updateNotes(seriesId, (local) => mergeImportedNotes(local, incoming, seriesId));
      }

      for (const [seriesId, translations] of groupBySeries(file.pageTranslations))
        await repo.putTranslations(mergeTranslations(await repo.listTranslations(seriesId), translations, seriesId));
      return touched;
    },
  };
}
