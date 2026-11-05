import { describe, expect, it } from 'vitest';
import { isMac, shortcutFor } from './shortcut.ts';

describe('isMac', () => {
  it('Chromium 的 userAgentData 說是 macOS', () => {
    expect(isMac({ userAgentData: { platform: 'macOS' }, platform: 'MacIntel' })).toBe(true);
  });

  it('沒有 userAgentData 時看 navigator.platform', () => {
    expect(isMac({ platform: 'MacIntel' })).toBe(true);
    expect(isMac({ platform: 'Win32' })).toBe(false);
    expect(isMac({ platform: 'Linux x86_64' })).toBe(false);
  });

  it('userAgentData 優先於 platform', () => {
    expect(isMac({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' })).toBe(false);
  });

  it('前兩個都沒有時退回 userAgent', () => {
    expect(isMac({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' })).toBe(true);
    expect(isMac({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' })).toBe(false);
    expect(isMac({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' })).toBe(false);
  });

  it('看不出平台（空字串或什麼都沒有）時不是 Mac', () => {
    expect(isMac({})).toBe(false);
    expect(isMac({ userAgentData: { platform: '' }, platform: '', userAgent: '' })).toBe(false);
  });
});

describe('shortcutFor', () => {
  const text = (mac: boolean) => {
    const { keys, separator } = shortcutFor(mac);
    return keys.map((key) => key.label).join(separator);
  };

  it('Mac 用 ⌥⇧M，並註明符號的念法', () => {
    expect(text(true)).toBe('⌥⇧M');
    expect(shortcutFor(true).keys.map((key) => key.name ?? key.label)).toEqual(['Option', 'Shift', 'M']);
  });

  it('其他平台用 Alt+Shift+M', () => {
    expect(text(false)).toBe('Alt+Shift+M');
  });
});
