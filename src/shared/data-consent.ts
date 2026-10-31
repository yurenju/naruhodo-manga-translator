/**
 * 資料使用同意（Web Store 2026-08 起的 prominent disclosure 規定，見 docs/research/chrome-web-store-listing.md 第 3 節）：
 * 把文字送出去之前，要先說明並取得同意。沒同意時 SW 當作不能翻，不排 LLM 工作。
 *
 * 兩種翻譯模式的資料流向不同（內建翻譯經過 Naruhodo 的服務、自備金鑰直接到 Anthropic），說明文字各自寫
 * （src/ui/data-flow.tsx），同意也各自記：內建翻譯在「同意並寄送驗證碼」時、自備金鑰在說明卡或 onboarding 的「同意並儲存」時。
 *
 * 存在 chrome.storage.local，值是 `{ hosted?: 版本, ownKey?: 版本 }`。資料處理方式改變時把 DATA_CONSENT_VERSION 加一，
 * 舊的同意就失效，會再問一次（政策要求資料處理改變時主動告知）。版本 1（#93 以前）只有自備金鑰、存的是數字。
 */
import type { TranslationMode } from './translation-mode.ts';

export const DATA_CONSENT_VERSION = 3;

const KEY = 'dataConsent';

/** 每種翻譯模式有沒有同意目前版本的說明。 */
export type DataConsent = Record<TranslationMode, boolean>;

/** 從 storage 的值讀出目前有效的同意；舊格式、舊版本都算沒同意。 */
export function readConsent(value: unknown): DataConsent {
  const stored = typeof value === 'object' && value !== null ? (value as Partial<Record<TranslationMode, unknown>>) : {};
  return { hosted: stored.hosted === DATA_CONSENT_VERSION, ownKey: stored.ownKey === DATA_CONSENT_VERSION };
}

async function loadRaw(): Promise<unknown> {
  return (await chrome.storage.local.get(KEY))[KEY];
}

export async function hasDataConsent(mode: TranslationMode): Promise<boolean> {
  return readConsent(await loadRaw())[mode];
}

/** 記下這個模式的同意；另一個模式的同意不動（舊格式的值直接蓋掉）。 */
export async function grantDataConsent(mode: TranslationMode): Promise<void> {
  const raw = await loadRaw();
  const stored = typeof raw === 'object' && raw !== null ? raw : {};
  await chrome.storage.local.set({ [KEY]: { ...stored, [mode]: DATA_CONSENT_VERSION } });
}

/** 先讀一次目前的值，之後每次變更都呼叫 onChange；回傳取消監聽。 */
export function watchDataConsent(onChange: (consent: DataConsent) => void): () => void {
  let stopped = false;
  const loaded = loadRaw().then((value) => {
    if (!stopped) onChange(readConsent(value));
  });
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !(KEY in changes)) return;
    const consent = readConsent(changes[KEY]!.newValue);
    // 排在初始讀取後面，讀取比變更晚回來也不會被舊值蓋掉
    void loaded.then(() => {
      if (!stopped) onChange(consent);
    });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => {
    stopped = true;
    chrome.storage.onChanged.removeListener(listener);
  };
}
