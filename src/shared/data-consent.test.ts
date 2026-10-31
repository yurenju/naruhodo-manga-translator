import { describe, expect, it } from 'vitest';
import { DATA_CONSENT_VERSION, readConsent } from './data-consent.ts';

describe('資料使用同意', () => {
  it('舊版（#93 以前）存的同意是版本 1、不分模式：失效，兩種模式都要重新同意', () => {
    expect(readConsent(1)).toEqual({ hosted: false, ownKey: false });
  });

  it('依翻譯模式各自記：只同意了自備金鑰的說明，內建翻譯還沒同意', () => {
    expect(readConsent({ ownKey: DATA_CONSENT_VERSION })).toEqual({ hosted: false, ownKey: true });
    expect(readConsent({ hosted: DATA_CONSENT_VERSION, ownKey: DATA_CONSENT_VERSION })).toEqual({ hosted: true, ownKey: true });
  });

  it('同意的是舊版本的說明：失效', () => {
    expect(readConsent({ hosted: DATA_CONSENT_VERSION - 1 })).toEqual({ hosted: false, ownKey: false });
  });

  it('版本 2 的說明還寫著不送作品名（#144 起會送）：兩種模式都要重新同意', () => {
    expect(readConsent({ hosted: 2, ownKey: 2 })).toEqual({ hosted: false, ownKey: false });
    expect(readConsent({ hosted: 3, ownKey: 3 })).toEqual({ hosted: true, ownKey: true });
  });

  it('沒有同意過', () => {
    expect(readConsent(undefined)).toEqual({ hosted: false, ownKey: false });
  });
});
