/**
 * Side Panel on Activation（#185）：全域設定，點圖示啟動時要不要一起打開 side panel。跟 Page Mode 一樣存在 chrome.storage.local。
 * 在側邊欄的 ⚙ 設定「點圖示時也打開側邊欄」改（#269）。沒存過值一律是開的；已存的值照舊。
 */
import { watchLocal } from './watch-local.ts';

const KEY = 'sidePanelOnActivation';

export const DEFAULT_SIDE_PANEL_ON_ACTIVATION = true;

const parse = (value: unknown): boolean => (typeof value === 'boolean' ? value : DEFAULT_SIDE_PANEL_ON_ACTIVATION);

export function saveSidePanelOnActivation(open: boolean): Promise<void> {
  return chrome.storage.local.set({ [KEY]: open });
}

export async function loadSidePanelOnActivation(): Promise<boolean> {
  return parse((await chrome.storage.local.get(KEY))[KEY]);
}

/** 先讀一次目前的值，之後每次變更都呼叫 onChange；回傳取消監聽。 */
export const watchSidePanelOnActivation = (onChange: (open: boolean) => void) => watchLocal(KEY, parse, onChange);
