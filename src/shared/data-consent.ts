/**
 * 資料使用同意（Web Store 2026-08 起的 prominent disclosure 規定，見 docs/research/chrome-web-store-listing.md 第 3 節）：
 * 把文字送出去之前，要先說明並取得同意。沒同意時 SW 當作不能翻，不排 LLM 工作。
 *
 * 兩種翻譯模式的資料流向不同（內建翻譯經過 Naruhodo 的服務、自備金鑰直接到 Anthropic），說明文字各自寫
 * （src/ui/data-flow.tsx），同意也各自記：內建翻譯在「同意並寄送驗證碼」或補同意（side panel 的說明卡、onboarding 的補同意畫面）時，
 * 自備金鑰在說明卡或 onboarding 的「同意並儲存」時。
 *
 * 存在 chrome.storage.local，值是 `{ hosted?: 版本, ownKey?: 版本 }`。某個模式的資料處理方式有 Material Change（ADR 0015）時，把那個模式的
 * DATA_CONSENT_VERSION 加一、並改寫它的 CONSENT_CHANGES（都在 data-consent-version.ts）：那個模式舊的同意就失效，會再問一次，另一個模式不受影響。
 * 同意過期不會登出（GLOSSARY 的 Data Use Consent）：內建翻譯還登入著的讀者只要再按一次同意，不用重收驗證碼。
 * 版本 1（#93 以前）只有自備金鑰、存的是數字。
 */
import { DATA_CONSENT_VERSION } from './data-consent-version.ts';
import type { TranslationMode } from './translation-mode.ts';

const KEY = 'dataConsent';

/** agreed＝同意了目前版本的說明；outdated＝同意過舊版本（說明改版了，要再問一次）；none＝沒同意過。 */
export type ConsentState = 'agreed' | 'outdated' | 'none';

/** 每種翻譯模式的同意狀態。 */
export type DataConsent = Record<TranslationMode, ConsentState>;

function state(stored: unknown, mode: TranslationMode): ConsentState {
  if (typeof stored !== 'number') return 'none';
  return stored === DATA_CONSENT_VERSION[mode] ? 'agreed' : 'outdated';
}

/** 從 storage 的值讀出每種模式的同意；版本 1 的數字是自備金鑰同意過舊版。 */
export function readConsent(value: unknown): DataConsent {
  if (typeof value === 'number') return { hosted: 'none', ownKey: state(value, 'ownKey') };
  const stored = typeof value === 'object' && value !== null ? (value as Partial<Record<TranslationMode, unknown>>) : {};
  return { hosted: state(stored.hosted, 'hosted'), ownKey: state(stored.ownKey, 'ownKey') };
}

async function loadRaw(): Promise<unknown> {
  return (await chrome.storage.local.get(KEY))[KEY];
}

/** 這個模式的同意狀態（onboarding 的補同意畫面要分「沒同意過」與「說明更新了」）。 */
export async function loadConsentState(mode: TranslationMode): Promise<ConsentState> {
  return readConsent(await loadRaw())[mode];
}

export async function hasDataConsent(mode: TranslationMode): Promise<boolean> {
  return (await loadConsentState(mode)) === 'agreed';
}

/** 記下這個模式的同意；另一個模式的同意不動（舊格式的值直接蓋掉）。 */
export async function grantDataConsent(mode: TranslationMode): Promise<void> {
  const raw = await loadRaw();
  const stored = typeof raw === 'object' && raw !== null ? raw : {};
  await chrome.storage.local.set({ [KEY]: { ...stored, [mode]: DATA_CONSENT_VERSION[mode] } });
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
