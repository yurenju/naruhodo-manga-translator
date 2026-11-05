/**
 * 外掛這邊的 Hosted Translation 連線資訊：Worker 的網址與登入後的 session（#91）。
 * session 存在外掛 origin 的 IndexedDB，跟 API key 同一個 store（content script 讀不到，也不會出現在匯出檔）。
 * 只有呼叫 Worker 的 SW（hostedSessionToken）與 side panel 的設定區（登入、顯示 email）會讀。
 * 改了 session 的一方要廣播 `session:changed`，讓其他 side panel 重新讀。
 */
import { STORES, storeRequest } from './db.ts';

/** scripts/build.ts 依 build 決定（''＝Hosted Translation 不翻譯）。 */
export const HOSTED_API_URL = __HOSTED_API_URL__;

const SESSION_ID = 'hostedSession';

export interface HostedSession {
  /** Worker 發的長期 session token（Worker 只存它的 hash）。 */
  token: string;
  /** 登入用的 email，設定區顯示用。 */
  email: string;
}

function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return storeRequest(STORES.apiKeys, mode, op);
}

export const loadHostedSession = () => run('readonly', (s) => s.get(SESSION_ID) as IDBRequest<HostedSession | undefined>);

export const saveHostedSession = (session: HostedSession) => run('readwrite', (s) => s.put(session, SESSION_ID)).then(() => {});

export const clearHostedSession = () => run('readwrite', (s) => s.delete(SESSION_ID));

/** 已登入時的 session token；沒有就是 undefined（跟沒有 key 一樣，只顯示原文與讀音）。 */
export async function hostedSessionToken(): Promise<string | undefined> {
  if (!HOSTED_API_URL) return undefined;
  return (await loadHostedSession())?.token;
}
