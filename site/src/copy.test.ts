import { describe, expect, it } from 'vitest';
import { copy } from './copy.ts';

// 期望值抄自設計稿「購買流程」的網站定價區塊（spec #254），不從常數算，價格或文案一變就會在這裡發現
describe('網站定價區塊', () => {
  it('繁中：免費、年繳（推薦）、季繳三張卡片', () => {
    const t = copy['zh-tw'].pricing;
    expect(t.free).toMatchObject({ title: '免費額度', tag: '不需信用卡', price: 'US$0', grant: { lead: '註冊就送', pages: '100 頁', note: '，大約四話' } });
    expect(t.free.items).toEqual(['不會過期', '免費翻譯量全站共用，每天有上限', '用 email 註冊就能翻譯']);
    expect(t.plans).toEqual([
      {
        title: '訂閱',
        tag: '推薦',
        featured: true,
        name: '年繳 US$48',
        detail: '平均每月 US$4・省 20%',
        items: ['每月 3,000 頁・14 天內可全額退款', '不受免費名額影響，隨時都能翻', '一年扣款一次，自動續訂', '隨時可以取消'],
      },
      {
        title: '訂閱',
        featured: false,
        name: '季繳 US$15',
        detail: '每 3 個月扣款',
        items: ['每月 3,000 頁・14 天內可全額退款', '不受免費名額影響，隨時都能翻', '先付少一點試試，自動續訂', '隨時可以取消'],
      },
    ]);
    expect(t.note).toBe('年繳和季繳的內容完全一樣，只差扣款週期。每月在你訂閱的那天重置；以美元計價，標價就是刷卡金額。');
  });

  it('繁中：三步驟與唯一的按鈕', () => {
    const t = copy['zh-tw'].pricing.start;
    expect(t.steps.map((s) => s.body)).toEqual(['從 Chrome 線上應用程式商店安裝', '馬上拿到 100 頁免費額度', '在外掛裡選季繳或年繳，然後付款']);
    expect(t.cta).toBe('加到 Chrome，免費開始');
    expect(t.installed).toBe('已經安裝了？點工具列上的 Naruhodo 圖示，右鍵選「帳號與訂閱」。');
  });

  it('英文：同樣的三張卡片與價格', () => {
    const t = copy.en.pricing;
    expect(t.free.grant).toEqual({ lead: 'Sign up and get', pages: '100 pages', note: ', about four episodes' });
    expect(t.plans.map(({ tag, featured, name, detail }) => ({ tag, featured, name, detail }))).toEqual([
      { tag: 'Recommended', featured: true, name: 'Yearly $48', detail: 'About $4 a month · save 20%' },
      { tag: undefined, featured: false, name: 'Quarterly $15', detail: 'Billed every 3 months' },
    ]);
    expect(t.plans[0]!.items[0]).toBe('3,000 pages a month · full refund within 14 days');
    expect(t.start.steps[2]!.body).toBe('Choose quarterly or yearly in the extension, then pay');
  });
});

describe('付款頁的方案摘要', () => {
  // 付款頁不知道讀者選了哪一種 Billing Period（金額在 Paddle 的付款畫面上），摘要只寫兩種共通的內容
  it('不寫死扣款週期', () => {
    expect(copy['zh-tw'].checkout).toMatchObject({ plan: 'Naruhodo 訂閱', pagesValue: '3,000 頁', refund: '扣款後 14 天內可全額退款' });
    expect(copy.en.checkout).toMatchObject({ plan: 'Naruhodo subscription', pagesValue: '3,000 pages', refund: 'Full refund within 14 days of each payment' });
  });
});
