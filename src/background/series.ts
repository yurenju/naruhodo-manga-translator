import { findSamePage } from '../shared/page-hash.ts';
import type { PageTranslation } from '../shared/page-text.ts';
import type { Series, SeriesOption, TitleGuess, UrlPattern } from '../shared/series.ts';

/**
 * 啟動時網址模式對不上、原名也沒命中既有 Series，就建一個 Provisional Series（spec #27 第 4.1 節、#186）。
 * 猜到原名時名稱用原名、記下原名與中文譯名；猜不出來時名稱例：「未命名・manga.example・10/25」（網址只留在本機）。
 */
export function provisionalSeries(url: string, now: Date, id: string, guess?: TitleGuess): Series {
  const base = { id, provisional: true, createdAt: now.getTime() };
  if (guess) return { ...base, name: guess.原名, originalTitles: [guess.原名], ...(guess.中文譯名 ? { zhTitle: guess.中文譯名 } : {}) };
  const date = `${now.getMonth() + 1}/${now.getDate()}`;
  return { ...base, name: `未命名・${new URL(url).hostname}・${date}` };
}

/**
 * 網址模式＝完整網址比對（spec #27 第 4.1 節，選項 A）：只留 origin＋path。
 * 不做路徑前綴比對，也不做「這個網站上次用的 Series」。
 */
export function urlPattern(url: string): string {
  const { origin, pathname } = new URL(url);
  return origin + pathname;
}

/**
 * 合併時要寫進目標 Series 的快取：來源的每一筆改用目標 ID；同一個 Page（hash 在門檻內）
 * 目標已經有的就保留目標原本的那份，不寫。
 */
export function mergeTranslations(target: readonly PageTranslation[], source: readonly PageTranslation[], targetId: string): PageTranslation[] {
  return source.filter((t) => !findSamePage(target, t.pageHash)).map((t) => ({ ...t, seriesId: targetId }));
}

/** 作品卡的兩行字（#186）：大字是猜的中文譯名（讀者改過名就是名稱），小字是原名。 */
export function seriesTitles(series: Series): Pick<SeriesOption, 'title' | 'subtitle'> {
  const title = series.zhTitle ?? series.name;
  const original = series.originalTitles?.[0];
  return original && original !== title ? { title, subtitle: original } : { title };
}

/** Series 下拉選單：最近用過的（網址模式的 lastUsedAt）在最上面，沒用過的依建立時間新到舊。 */
export function seriesMenu(series: readonly Series[], patterns: readonly UrlPattern[]): SeriesOption[] {
  const lastUsed = new Map<string, number>();
  for (const p of patterns) lastUsed.set(p.seriesId, Math.max(lastUsed.get(p.seriesId) ?? 0, p.lastUsedAt));
  return [...series]
    .sort((a, b) => (lastUsed.get(b.id) ?? 0) - (lastUsed.get(a.id) ?? 0) || b.createdAt - a.createdAt)
    .map((s) => ({ ...s, label: s.name, ...seriesTitles(s) }));
}
