import { BY_SERIES, openDb, STORES, storeRequest } from '../shared/db.ts';
import { sameLongPage } from '../shared/long-page.ts';
import { findSamePage } from '../shared/page-hash.ts';
import type { PageTranslation } from '../shared/page-text.ts';
import type { PageCache } from './transcribe.ts';

/**
 * 翻譯快取（spec #27 第 4.3 節）。hash 是近似比對，不能直接用 key 查：取出這個 Series 的全部再找門檻內最接近的。
 * 一部 Series 頂多幾千頁、每筆只有文字與座標，v1 這樣夠快。不自動清除。
 */
export function indexedDbPageCache(): PageCache {
  let db: Promise<IDBDatabase> | undefined;
  const run = <T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>) =>
    storeRequest((db ??= openDb()), STORES.pageTranslations, mode, op);
  return {
    async find(seriesId, pageHash) {
      const entries = await run('readonly', (s) => s.index(BY_SERIES).getAll(seriesId) as IDBRequest<PageTranslation[]>);
      return findSamePage(
        entries.filter((e) => !e.stripes),
        pageHash,
      );
    },
    async findLong(seriesId, stripes) {
      const entries = await run('readonly', (s) => s.index(BY_SERIES).getAll(seriesId) as IDBRequest<PageTranslation[]>);
      return entries.find((e) => e.stripes && sameLongPage(e.stripes, stripes));
    },
    save: (translation) => run('readwrite', (s) => s.put(translation)).then(() => {}),
  };
}
