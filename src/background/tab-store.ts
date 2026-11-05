import { connection, STORES, storeRequest } from '../shared/db.ts';
import type { TabState, TabStateStore } from './activation.ts';

/**
 * 存在 IndexedDB，SW 閒置被收掉再叫醒時狀態還在。
 * 不用 chrome.storage.session：那需要 `storage` 權限，spec #27 第 6 節沒有列。
 * IndexedDB 跨瀏覽器重開還在，但 tab id 不會，所以瀏覽器啟動時要 clear()。
 */
export function indexedDbTabStore(): TabStateStore & { clear(): Promise<void> } {
  const run = <T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>) => storeRequest(STORES.activeTabs, mode, op);

  return {
    get: (tabId) => run('readonly', (s) => s.get(tabId) as IDBRequest<TabState | undefined>),
    set: (tabId, state) => run('readwrite', (s) => s.put(state, tabId)).then(() => {}),
    delete: (tabId) => run('readwrite', (s) => s.delete(tabId)),
    entries: () =>
      connection().then(
        (db) =>
          new Promise<[number, TabState][]>((resolve, reject) => {
            const tx = db.transaction(STORES.activeTabs, 'readonly');
            const rows: [number, TabState][] = [];
            const cursor = tx.objectStore(STORES.activeTabs).openCursor();
            cursor.onsuccess = () => {
              if (!cursor.result) return;
              rows.push([cursor.result.key as number, cursor.result.value as TabState]);
              cursor.result.continue();
            };
            tx.oncomplete = () => resolve(rows);
            tx.onerror = () => reject(tx.error);
          }),
      ),
    clear: () => run('readwrite', (s) => s.clear()),
  };
}
