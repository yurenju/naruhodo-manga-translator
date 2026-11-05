/**
 * 帳號與訂閱頁（#213）的網址：右鍵選單「帳號與訂閱」直接打開；額度用完時 Page 上的紅色小標籤與點圖示帶著漫畫分頁打開
 * （from，「回到漫畫」切回去）。沒登入、自備金鑰沒有 key 還是打開 onboarding 的那一步。
 */
import { onboardingQuery, type RequestedStep } from './onboarding.ts';

export function accountQuery(from?: number): string {
  return from === undefined ? '' : `?from=${from}`;
}

export function accountRequest(search: string): { from?: number } {
  const from = Number(new URLSearchParams(search).get('from') ?? NaN);
  return Number.isInteger(from) ? { from } : {};
}

/** 卡住時打開的外掛頁面（相對外掛根目錄）：額度用完是帳號頁，其他是 onboarding 的那一步。 */
export function blockedPagePath(step: RequestedStep, from?: number): string {
  return step === 'plan' ? `account.html${accountQuery(from)}` : `onboarding.html${onboardingQuery(step, from)}`;
}

/** 外掛自己的帳號與訂閱頁（右鍵選單、設定頁的「管理帳號 →」：沒有來源漫畫分頁）。 */
export function accountUrl(): string {
  return chrome.runtime.getURL('account.html');
}

export function blockedPageUrl(step: RequestedStep, from?: number): string {
  return chrome.runtime.getURL(blockedPagePath(step, from));
}
