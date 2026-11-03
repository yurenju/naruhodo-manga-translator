/** chrome.storage 裡一個值的監聽：side panel 與 SW 跟著設定變更（翻譯模式、onboarding 進度、付款狀態）。 */

/** 先讀一次目前的值，之後每次變更都呼叫 onChange；回傳取消監聽。 */
export function watchStorage<T>(area: 'local' | 'session', key: string, parse: (value: unknown) => T, onChange: (value: T) => void): () => void {
  let stopped = false;
  const loaded = chrome.storage[area].get(key).then((stored) => {
    if (!stopped) onChange(parse(stored[key]));
  });
  const listener = (changes: Record<string, chrome.storage.StorageChange>, changedArea: string) => {
    if (changedArea !== area || !(key in changes)) return;
    const value = parse(changes[key]!.newValue);
    // 排在初始讀取後面，讀取比變更晚回來也不會被舊值蓋掉
    void loaded.then(() => {
      if (!stopped) onChange(value);
    });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => {
    stopped = true;
    chrome.storage.onChanged.removeListener(listener);
  };
}

export const watchLocal = <T,>(key: string, parse: (value: unknown) => T, onChange: (value: T) => void) => watchStorage('local', key, parse, onChange);
