import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 每個測試一個全新的 IndexedDB 與全新的 db.ts（模組裡的共用連線不會跨測試）。 */
async function freshDb() {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.resetModules();
  return import('./db.ts');
}

/** 不經過 db.ts 直接開：模擬舊版程式開的連線（不會讓位）。 */
function rawOpen(version: number, upgrade: (db: IDBDatabase) => void = () => {}): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('naruhodo', version);
    request.onupgradeneeded = () => upgrade(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('DB 升級被擋住（#220）', () => {
  it('舊版程式握著舊版連線不放時，openDb 逾時報錯，不會永遠等', async () => {
    const db = await freshDb();
    await rawOpen(db.DB_VERSION - 1); // 不設 onversionchange，永遠不關
    await expect(db.openDb(200)).rejects.toThrow(db.DbBlockedError);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('被擋住'), expect.anything());
  });

  it('逾時之後舊連線才關掉：晚到的連線也會關掉，不會留著擋下一次升級', async () => {
    const db = await freshDb();
    const old = await rawOpen(db.DB_VERSION - 1);
    await expect(db.openDb(100)).rejects.toThrow(db.DbBlockedError);
    old.close();
    // 晚到的那條要是沒關，這裡升到下一版就會被擋住
    const next = await rawOpen(db.DB_VERSION + 1);
    expect(next.version).toBe(db.DB_VERSION + 1);
  });

  it('自己的連線遇到別人要升級（versionchange）會讓位', async () => {
    const db = await freshDb();
    await db.storeRequest(db.STORES.apiKeys, 'readwrite', (s) => s.put('k', 'anthropic'));
    const newer = await rawOpen(db.DB_VERSION + 1);
    expect(newer.version).toBe(db.DB_VERSION + 1);
  });

  it('讓位之後下一次讀寫自己重開連線', async () => {
    const db = await freshDb();
    await db.storeRequest(db.STORES.apiKeys, 'readwrite', (s) => s.put('k', 'anthropic'));
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('naruhodo');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    await db.storeRequest(db.STORES.apiKeys, 'readwrite', (s) => s.put('k2', 'anthropic'));
    expect(await db.storeRequest(db.STORES.apiKeys, 'readonly', (s) => s.get('anthropic'))).toBe('k2');
  });

  it('同一個 context 裡各處共用一條連線', async () => {
    const db = await freshDb();
    expect(await db.connection()).toBe(await db.connection());
  });

  it('開失敗之後下一次會重試，不會一直拿到同一個失敗', async () => {
    const db = await freshDb();
    const old = await rawOpen(db.DB_VERSION - 1);
    await expect(db.connection(100)).rejects.toThrow(db.DbBlockedError);
    old.close();
    expect((await db.connection()).version).toBe(db.DB_VERSION);
  });
});

describe('從舊版升級', () => {
  it('v4 升到目前版本：舊資料還在，新 store 建好', async () => {
    const db = await freshDb();
    const v4 = await rawOpen(4, (d) => {
      d.createObjectStore('activeTabs');
      d.createObjectStore('apiKeys');
      d.createObjectStore('series', { keyPath: 'id' });
      d.createObjectStore('pageTranslations', { keyPath: ['seriesId', 'pageHash'] }).createIndex('seriesId', 'seriesId');
      d.createObjectStore('urlPatterns', { keyPath: 'pattern' }).createIndex('seriesId', 'seriesId');
      d.createObjectStore('seriesNotes', { keyPath: ['seriesId', '原文'] }).createIndex('seriesId', 'seriesId');
      d.createObjectStore('notesSuggestions', { autoIncrement: true }).createIndex('seriesId', 'seriesId');
    });
    await new Promise<void>((resolve) => {
      const tx = v4.transaction('apiKeys', 'readwrite');
      tx.objectStore('apiKeys').put('old-key', 'anthropic');
      tx.oncomplete = () => resolve();
    });
    v4.close();
    expect(await db.storeRequest(db.STORES.apiKeys, 'readonly', (s) => s.get('anthropic'))).toBe('old-key');
    expect([...(await db.connection()).objectStoreNames]).toContain(db.STORES.excludedTerms);
  });
});
