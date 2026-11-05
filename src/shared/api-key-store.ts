/**
 * API key 存在外掛 origin 的 IndexedDB（spec #27 第 5 節），不放 chrome.storage.local（content script 讀得到）。
 * 只有 offscreen document（呼叫 API）與 side panel 設定區（輸入、顯示末四碼）會用 get()；
 * SW 只用 has() 判斷要不要排翻譯，不讀出值。不加密：見 spec 第 5 節的安全性取捨。
 */
import { STORES, storeRequest } from './db.ts';

/** v1 只有 Claude 一把 key。 */
const API_KEY_ID = 'anthropic';

export interface ApiKeyStore {
  get(): Promise<string | undefined>;
  has(): Promise<boolean>;
  set(key: string): Promise<void>;
  delete(): Promise<void>;
}

/** 畫面上只顯示末四碼。 */
export const lastFour = (key: string) => key.slice(-4);

export function indexedDbApiKeyStore(): ApiKeyStore {
  const run = <T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>) => storeRequest(STORES.apiKeys, mode, op);

  return {
    get: () => run('readonly', (s) => s.get(API_KEY_ID) as IDBRequest<string | undefined>),
    // count 只看 key 存不存在，不把值讀進 SW
    has: () => run('readonly', (s) => s.count(API_KEY_ID)).then((n) => n > 0),
    set: (key) => run('readwrite', (s) => s.put(key.trim(), API_KEY_ID)).then(() => {}),
    delete: () => run('readwrite', (s) => s.delete(API_KEY_ID)),
  };
}
