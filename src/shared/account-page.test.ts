import { describe, expect, it } from 'vitest';
import { accountRequest, blockedPagePath } from './account-page.ts';

describe('卡住時打開哪一頁（#213）', () => {
  it('額度用完（plan）打開帳號頁，帶上漫畫分頁；其他還是 onboarding 的那一步', () => {
    expect(blockedPagePath('plan', 12)).toBe('account.html?from=12');
    expect(blockedPagePath('signIn', 12)).toBe('onboarding.html?step=signIn&from=12');
    expect(blockedPagePath('ownKey', 12)).toBe('onboarding.html?step=ownKey&from=12');
  });

  it('帳號頁讀回漫畫分頁；右鍵直接打開的沒有', () => {
    expect(accountRequest('?from=12')).toEqual({ from: 12 });
    expect(accountRequest('')).toEqual({});
    expect(accountRequest('?from=x')).toEqual({});
  });
});
