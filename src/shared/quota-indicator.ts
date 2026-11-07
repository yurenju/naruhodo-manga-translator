/**
 * 不開側邊欄也看得到剩餘頁數（#237）：圖示的 hover 提示、「快用完」的橘色圓點、右鍵選單「帳號與訂閱」的文字。
 * 平常安靜，快用完才出聲：hover 提示一直都有，圓點與選單只在快用完時才變。
 */
import type { Quota } from './hosted-api.ts';

/** 剩這麼多頁以下算快用完（大約一話）：圓點變橘，side panel 與帳號頁也用警告色。免費額度與本月額度同一個門檻。 */
export const LOW_QUOTA = 25;

export const ACTION_NAME = 'Naruhodo 漫畫翻譯';
const ACCOUNT_MENU = '帳號與訂閱';

export interface QuotaIndicator {
  /** 圖示的 hover 提示（chrome.action.setTitle）。 */
  title: string;
  /** 右鍵選單「帳號與訂閱」那一項的文字。 */
  menuTitle: string;
  /** 快用完：已啟動分頁的綠點換成橘點。 */
  low: boolean;
}

/** 「12/3」：重置日期，依讀者的時區。 */
const shortDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

/** quota：內建翻譯、已登入時 Worker 給的額度；自備金鑰或沒登入是 undefined（只顯示名字）。 */
export function quotaIndicator(quota: Quota | undefined): QuotaIndicator {
  if (!quota) return { title: ACTION_NAME, menuTitle: ACCOUNT_MENU, low: false };
  const usedUp = quota.remaining === 0;
  const line =
    quota.plan === 'subscribed'
      ? `${usedUp ? '本月額度用完了' : `本月剩 ${quota.remaining} 頁`}・${shortDate(quota.resetsAt)} 重置`
      : usedUp
        ? '免費額度用完了'
        : `免費額度剩 ${quota.remaining} 頁`;
  const low = quota.remaining <= LOW_QUOTA;
  return {
    title: `${ACTION_NAME}\n${line}`,
    menuTitle: !low ? ACCOUNT_MENU : usedUp ? `${ACCOUNT_MENU}・額度用完了` : `${ACCOUNT_MENU}・剩 ${quota.remaining} 頁`,
    low,
  };
}
