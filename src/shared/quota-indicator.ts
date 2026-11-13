/**
 * 不開側邊欄也看得到剩餘頁數（#237）：圖示的 hover 提示、「快用完」的橘色圓點、右鍵選單「帳號與訂閱」的文字。
 * 平常安靜，快用完才出聲：hover 提示一直都有，圓點與選單只在快用完時才變。
 */
import { lowQuota as isLowQuota, pageCount, STRIP_LINES_PER_PAGE, type Quota } from './hosted-api.ts';

export const ACTION_NAME = 'Naruhodo 漫畫翻譯';
const ACCOUNT_MENU = '帳號與訂閱';

export interface QuotaIndicator {
  /** 圖示的 hover 提示（chrome.action.setTitle）。 */
  title: string;
  /** 右鍵選單「帳號與訂閱」那一項的文字。 */
  menuTitle: string;
  /** 快用完：已啟動分頁的綠點換成橘點。 */
  lowQuota: boolean;
}

/**
 * 正在讀 Strip（條漫，#282）的分頁，圖示的 hover 提示多一行：這類作品照句數計頁。
 * 只有那個分頁的提示多這一行；title 是全域的那份（quotaIndicator 的 title）。
 */
export function stripTitle(title: string): string {
  return `${title}\n條漫：每 ${STRIP_LINES_PER_PAGE} 句計 1 頁`;
}

/** 「12/3」：重置日期，依讀者的時區。 */
const shortDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

/** quota：內建翻譯、已登入時 Worker 給的額度；自備金鑰或沒登入是 undefined（只顯示名字）。 */
export function quotaIndicator(quota: Quota | undefined): QuotaIndicator {
  if (!quota) return { title: ACTION_NAME, menuTitle: ACCOUNT_MENU, lowQuota: false };
  const usedUp = quota.remaining === 0;
  const line =
    quota.plan === 'subscribed'
      ? `${usedUp ? '本月額度用完了' : `本月剩 ${pageCount(quota.remaining)} 頁`}・${shortDate(quota.resetsAt)} 重置`
      : usedUp
        ? '免費額度用完了'
        : `免費額度剩 ${quota.remaining} 頁`;
  const lowQuota = isLowQuota(quota);
  return {
    title: `${ACTION_NAME}\n${line}`,
    menuTitle: !lowQuota ? ACCOUNT_MENU : usedUp ? `${ACCOUNT_MENU}・額度用完了` : `${ACCOUNT_MENU}・剩 ${quota.remaining} 頁`,
    lowQuota,
  };
}
