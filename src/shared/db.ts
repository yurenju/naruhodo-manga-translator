/**
 * 外掛 origin 的 IndexedDB（ADR 0002）。SW、offscreen、side panel 共用，content script 讀不到。
 * 之後的 ticket 加 store（Series Notes 等）時，調高 DB_VERSION 並在 upgrade 裡依舊版本建立。
 */
const DB_NAME = 'naruhodo';
export const DB_VERSION = 5;

/**
 * 開 DB 最多等這麼久。升級要等別的連線全部關掉，握著舊版連線不放的 context（例如 Chrome 重開後沿用舊程式的 SW，#220）
 * 會讓它永遠等下去；逾時就報錯，讀寫的地方才會失敗而不是整個外掛停擺。
 */
const OPEN_TIMEOUT_MS = 10_000;

export const STORES = {
  /** 已啟動的 tab：key 是 tabId。 */
  activeTabs: 'activeTabs',
  /**
   * Claude 的 API key（spec #27 第 5 節）：key 是 API_KEY_ID。只有 offscreen 與 side panel 設定區讀值。
   * Hosted Translation 的 session（#91）也放這裡，key 是 hostedSession（shared/hosted-session.ts）。
   */
  apiKeys: 'apiKeys',
  /** Series（含 Provisional Series）：keyPath id。 */
  series: 'series',
  /** 翻譯快取 PageTranslation：keyPath [seriesId, pageHash]，index seriesId。 */
  pageTranslations: 'pageTranslations',
  /** 網址模式 UrlPattern：keyPath pattern，index seriesId（#36）。 */
  urlPatterns: 'urlPatterns',
  /** Series Notes 條目 NotesEntry：keyPath [seriesId, 原文]，index seriesId（#36 合併、#37）。 */
  seriesNotes: 'seriesNotes',
  /** 建議修改 NotesSuggestion：自動遞增 key，index seriesId（#36 合併、#37）。 */
  notesSuggestions: 'notesSuggestions',
  /** 不記的詞 ExcludedTerm：keyPath [seriesId, 原文]，index seriesId（#214）。 */
  excludedTerms: 'excludedTerms',
} as const;

/** pageTranslations、urlPatterns、seriesNotes、notesSuggestions、excludedTerms 依 Series 查詢的 index。 */
export const BY_SERIES = 'seriesId';

/** 開 DB 被別的連線擋住、等到逾時（#220）。重新載入外掛（或重開 Chrome）通常就好了。 */
export class DbBlockedError extends Error {
  readonly oldVersion: number | undefined;
  constructor(oldVersion: number | undefined) {
    super(`IndexedDB 升級到 v${DB_VERSION} 被擋住：有其他連線握著 v${oldVersion ?? '?'} 不放`);
    this.name = 'DbBlockedError';
    this.oldVersion = oldVersion;
  }
}

let shared: Promise<IDBDatabase> | undefined;

/**
 * 這個 context 共用的一條連線：各個 store 都用它，別人要升級（versionchange）時關掉讓位，下次用到再重開。
 * 開失敗（例如被擋住逾時）不留著，下次再試。
 */
export function connection(timeoutMs = OPEN_TIMEOUT_MS): Promise<IDBDatabase> {
  if (!shared) {
    const opening = openDb(timeoutMs);
    shared = opening;
    const forget = () => {
      if (shared === opening) shared = undefined;
    };
    opening.then((db) => {
      // 讓位（versionchange，openDb 會關掉）或被瀏覽器關掉（close 只在異常關閉時觸發）之後，下次重開
      db.addEventListener('versionchange', forget);
      db.addEventListener('close', forget);
    }, forget);
  }
  return shared;
}

/** 在一個 store 上開一個 transaction 跑一個 request，transaction 完成時 resolve 它的結果。 */
export function storeRequest<T>(store: string, mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return connection().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = op(tx.objectStore(store));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
      }),
  );
}

/** 在幾個 store 上開一個讀寫 transaction，write 排好所有 request；transaction 完成時 resolve，中途失敗就整個不算。 */
export async function writeTransaction(stores: string | string[], write: (tx: IDBTransaction) => void): Promise<void> {
  const conn = await connection();
  await new Promise<void>((resolve, reject) => {
    const tx = conn.transaction(stores, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    write(tx);
  });
}

/**
 * 開一條新連線。平常用 connection()；這個只給它與測試用。
 * 開好的連線收到 versionchange（別的 context 的新版程式要升級）就關掉，不擋別人。
 */
export function openDb(timeoutMs = OPEN_TIMEOUT_MS): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let blockedBy: number | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.warn(`[naruhodo] IndexedDB 開啟逾時（${timeoutMs}ms），升級被擋住`, { oldVersion: blockedBy, newVersion: DB_VERSION });
      reject(new DbBlockedError(blockedBy));
    }, timeoutMs);
    request.onblocked = (event) => {
      blockedBy = event.oldVersion;
      console.warn('[naruhodo] IndexedDB 升級被擋住，等其他連線關閉', { oldVersion: event.oldVersion, newVersion: DB_VERSION });
    };
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1) db.createObjectStore(STORES.activeTabs);
      if (event.oldVersion < 2) db.createObjectStore(STORES.apiKeys);
      if (event.oldVersion < 3) {
        db.createObjectStore(STORES.series, { keyPath: 'id' });
        db.createObjectStore(STORES.pageTranslations, { keyPath: ['seriesId', 'pageHash'] }).createIndex(BY_SERIES, 'seriesId');
      }
      if (event.oldVersion < 4) {
        db.createObjectStore(STORES.urlPatterns, { keyPath: 'pattern' }).createIndex(BY_SERIES, 'seriesId');
        db.createObjectStore(STORES.seriesNotes, { keyPath: ['seriesId', '原文'] }).createIndex(BY_SERIES, 'seriesId');
        db.createObjectStore(STORES.notesSuggestions, { autoIncrement: true }).createIndex(BY_SERIES, 'seriesId');
      }
      if (event.oldVersion < 5) db.createObjectStore(STORES.excludedTerms, { keyPath: ['seriesId', '原文'] }).createIndex(BY_SERIES, 'seriesId');
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
      // 逾時之後才開好：已經報錯了，這條不用，關掉才不會反過來擋住下一次升級
      if (timedOut) {
        db.close();
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error);
    };
  });
}
