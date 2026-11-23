import { describe, expect, it } from 'vitest';
import { readConsent } from './data-consent.ts';

describe('資料使用同意', () => {
  it('舊版（#93 以前）存的同意是版本 1、不分模式、只有自備金鑰：自備金鑰算同意過舊版，內建翻譯沒同意過', () => {
    expect(readConsent(1)).toEqual({ hosted: 'none', ownKey: 'outdated' });
  });

  it('依翻譯模式各自記：只同意了自備金鑰的說明，內建翻譯還沒同意', () => {
    expect(readConsent({ ownKey: 5 })).toEqual({ hosted: 'none', ownKey: 'agreed' });
    expect(readConsent({ hosted: 6, ownKey: 5 })).toEqual({ hosted: 'agreed', ownKey: 'agreed' });
  });

  it('版本 2 的說明還寫著不送作品名（#144 起會送）：兩種模式都要重新同意', () => {
    expect(readConsent({ hosted: 2, ownKey: 2 })).toEqual({ hosted: 'outdated', ownKey: 'outdated' });
  });

  it('版本 3 的說明沒寫網頁標題（#186 起會送去猜作品）：兩種模式都要重新同意', () => {
    expect(readConsent({ hosted: 3, ownKey: 3 })).toEqual({ hosted: 'outdated', ownKey: 'outdated' });
  });

  it('版本 4 的說明沒寫刪除帳號後用量紀錄匿名保留、猜作品也記用量（#238）：要重新同意', () => {
    expect(readConsent({ hosted: 4, ownKey: 4 })).toEqual({ hosted: 'outdated', ownKey: 'outdated' });
  });

  it('版本 5 的內建翻譯說明沒寫用量紀錄會記外掛產生的隨機作品 ID、也用來改善服務（#341，Material Change）：內建翻譯要重新同意，自備金鑰不用', () => {
    expect(readConsent({ hosted: 5, ownKey: 5 })).toEqual({ hosted: 'outdated', ownKey: 'agreed' });
  });

  it('沒有同意過', () => {
    expect(readConsent(undefined)).toEqual({ hosted: 'none', ownKey: 'none' });
    expect(readConsent({ hosted: 'x' })).toEqual({ hosted: 'none', ownKey: 'none' });
  });
});
