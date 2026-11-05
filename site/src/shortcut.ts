/**
 * 外掛快捷鍵（src/manifest.ts 的 `commands`：`Alt+Shift+M`，沒有另設 `mac`）在網站上的寫法。
 * Chrome 在 macOS 把 `Alt` 當成 Option 鍵，所以 Mac 是同一組鍵，只是用 Mac 慣用的符號 ⌥⇧M 顯示。
 */

/** 只取偵測要用到的欄位，測試可以直接傳物件，不必假造整個 navigator。 */
export interface PlatformHints {
  userAgentData?: { platform?: string };
  platform?: string;
  userAgent?: string;
}

/** 依序看 `userAgentData.platform`（Chromium）、`platform`、`userAgent`；都沒有就當作不是 Mac。 */
export function isMac(hints: PlatformHints): boolean {
  const source = hints.userAgentData?.platform || hints.platform || hints.userAgent || '';
  return /mac/i.test(source);
}

export interface ShortcutKey {
  /** 畫在 `<kbd>` 裡的字 */
  label: string;
  /** 符號的念法（⌥ 是 Option），給螢幕閱讀器與滑鼠提示；跟 `label` 一樣時省略 */
  name?: string;
}

export interface Shortcut {
  keys: readonly ShortcutKey[];
  /** 鍵之間的分隔：Windows／Linux 寫 `+`，Mac 慣例是符號直接連在一起 */
  separator: string;
}

export function shortcutFor(mac: boolean): Shortcut {
  return mac
    ? { keys: [{ label: '⌥', name: 'Option' }, { label: '⇧', name: 'Shift' }, { label: 'M' }], separator: '' }
    : { keys: [{ label: 'Alt' }, { label: 'Shift' }, { label: 'M' }], separator: '+' };
}
