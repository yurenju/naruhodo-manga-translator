import { describe, expect, it } from 'vitest';
import type { Quota } from './hosted-api.ts';
import { quotaIndicator } from './quota-indicator.ts';

const free = (remaining: number): Quota => ({ plan: 'free', remaining });
const subscribed = (remaining: number): Quota => ({
  plan: 'subscribed',
  remaining,
  limit: 800,
  // 讀者時區的 12 月 3 日
  resetsAt: new Date(2026, 11, 3, 9).getTime(),
  status: 'active',
  cancelScheduled: false,
  periodEndsAt: new Date(2027, 10, 3).getTime(),
});

describe('圖示 hover 提示、右鍵選單與「快用完」（#237）', () => {
  it('沒用內建翻譯或沒登入：只有名字，選單與圓點維持原樣', () => {
    expect(quotaIndicator(undefined)).toEqual({ title: 'Naruhodo 漫畫翻譯', menuTitle: '帳號與訂閱', lowQuota: false });
  });

  it('訂閱中：第二行是本月剩餘與重置日', () => {
    expect(quotaIndicator(subscribed(612))).toEqual({
      title: 'Naruhodo 漫畫翻譯\n本月剩 612 頁・12/3 重置',
      menuTitle: '帳號與訂閱',
      lowQuota: false,
    });
  });

  it('免費：第二行是免費額度', () => {
    expect(quotaIndicator(free(42)).title).toBe('Naruhodo 漫畫翻譯\n免費額度剩 42 頁');
  });

  it('剩 25 頁以下是快用完：圓點變橘、選單帶上剩餘頁數', () => {
    expect(quotaIndicator(free(26))).toMatchObject({ menuTitle: '帳號與訂閱', lowQuota: false });
    expect(quotaIndicator(free(25))).toMatchObject({ menuTitle: '帳號與訂閱・剩 25 頁', lowQuota: true });
    expect(quotaIndicator(subscribed(18))).toMatchObject({ menuTitle: '帳號與訂閱・剩 18 頁', lowQuota: true });
  });

  it('用完了', () => {
    expect(quotaIndicator(subscribed(0))).toEqual({
      title: 'Naruhodo 漫畫翻譯\n本月額度用完了・12/3 重置',
      menuTitle: '帳號與訂閱・額度用完了',
      lowQuota: true,
    });
    expect(quotaIndicator(free(0))).toMatchObject({ title: 'Naruhodo 漫畫翻譯\n免費額度用完了', menuTitle: '帳號與訂閱・額度用完了' });
  });
});
