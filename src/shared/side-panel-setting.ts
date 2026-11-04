/**
 * Side Panel on Activation（#185）：全域設定，啟動外掛時要不要一起打開 side panel。跟 Page Mode 一樣存在 chrome.storage.local。
 * onboarding 的「看漫畫／學日文」一次設好它與 Page Mode（不另外存「使用目的」）；之後在圖示的右鍵選單改。
 * 沒有值＝沒經過新 onboarding 的既有讀者：開著，行為跟以前一樣。
 */
import { watchLocal } from './watch-local.ts';

const KEY = 'sidePanelOnActivation';

export const DEFAULT_SIDE_PANEL_ON_ACTIVATION = true;

const parse = (value: unknown): boolean => (typeof value === 'boolean' ? value : DEFAULT_SIDE_PANEL_ON_ACTIVATION);

export function saveSidePanelOnActivation(open: boolean): Promise<void> {
  return chrome.storage.local.set({ [KEY]: open });
}

/** 先讀一次目前的值，之後每次變更都呼叫 onChange；回傳取消監聽。 */
export const watchSidePanelOnActivation = (onChange: (open: boolean) => void) => watchLocal(KEY, parse, onChange);
