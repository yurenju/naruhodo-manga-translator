/**
 * 在 onboarding 頁（#93）的第 2 步用 email 驗證碼登入內建翻譯：寄送 → 從本機 Worker 假的寄信實作取出驗證碼 → 登入。
 * browser test 與 smoke 共用；每個測試傳不同的 email，Worker 的狀態不會互相影響。
 */
import type { BrowserContext, Page } from '@playwright/test';
import { DEV_OUTBOX_PATH } from '../src/shared/hosted-api.ts';
import { expect } from './fixtures.ts';
import { WORKER_URL } from './worker.ts';

/** 假的寄信實作最後寄給這個 email 的驗證碼。 */
export async function lastCode(email: string): Promise<string> {
  const response = await fetch(`${WORKER_URL}${DEV_OUTBOX_PATH}?email=${encodeURIComponent(email)}`);
  return ((await response.json()) as { code: string }).code;
}

/** onboarding＝停在「同意並登入」的 onboarding 頁；登入後到第 3 步，未訂閱是「選擇方案」，已訂閱（subscribed）是「已訂閱」（#167）。 */
export async function signInWithEmail(onboarding: Page, email: string, { subscribed = false } = {}): Promise<void> {
  await onboarding.getByRole('region', { name: '同意並登入' }).getByLabel('Email').fill(email);
  await onboarding.getByRole('button', { name: '同意並寄送驗證碼' }).click();
  const verify = onboarding.getByRole('region', { name: '輸入驗證碼' });
  await expect(verify.getByText(email)).toBeVisible();
  await verify.getByLabel('驗證碼').fill(await lastCode(email));
  await verify.getByRole('button', { name: '登入' }).click();
  if (subscribed) await expect(onboarding.getByRole('heading', { name: '已訂閱' })).toBeVisible();
  else await expect(onboarding.getByText(`已登入 ${email}`)).toBeVisible();
}

/** onboarding 分頁（SW 安裝時打開，或 side panel 的「登入」「完成設定」打開）；open＝打開它的動作，還沒打開時等它出現。 */
export async function onboardingPage(context: BrowserContext, open?: () => Promise<void>): Promise<Page> {
  const isOnboarding = (page: Page) => page.url().includes('/onboarding.html');
  const opened = context.waitForEvent('page', { predicate: isOnboarding });
  // 分頁早就開著的話沒人 await 它：測試結束、context 關掉時它 reject，不處理會被當成測試失敗（#167 的測試先打 Worker 才遇到）
  opened.catch(() => {});
  await open?.();
  const page = context.pages().find(isOnboarding) ?? (await opened);
  await page.waitForLoadState();
  return page;
}

/**
 * 按 onboarding 第 4 步的「完成」，等分頁關掉。按鈕在 click handler 裡直接 window.close()，Playwright 的 click 收尾前
 * 分頁可能已經關了（CI 上遇過），這個錯誤不算失敗；分頁到底有沒有關，由等 close 事件來判斷。
 */
export async function finishOnboarding(onboarding: Page): Promise<void> {
  const closed = onboarding.waitForEvent('close');
  await onboarding
    .getByRole('button', { name: '完成' })
    .click()
    .catch((error: Error) => {
      if (!error.message.includes('has been closed')) throw error;
    });
  await closed;
}

/** side panel 按「登入」（open）→ onboarding 第 2 步登入 → 先用免費額度 → 第 4 步按「完成」關掉分頁。 */
export async function signInFromPanel(context: BrowserContext, open: () => Promise<void>, email: string): Promise<void> {
  const onboarding = await onboardingPage(context, open);
  await signInWithEmail(onboarding, email);
  await onboarding.getByRole('button', { name: '免費開始（100 頁）' }).click();
  await finishOnboarding(onboarding);
}
