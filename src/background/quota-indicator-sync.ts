/**
 * 不開側邊欄也看得到剩餘頁數（#237）：額度可能變了（扣了一頁、登入登出、付款完成）就重新讀一次，
 * 把 shared/quota-indicator.ts 算出的 hover 提示、選單文字與橘點交給 SW 設定。
 */
import type { Quota } from '../shared/hosted-api.ts';
import { quotaIndicator, type QuotaIndicator } from '../shared/quota-indicator.ts';

/** quota＝內建翻譯、已登入時讀到的額度；none＝自備金鑰或沒登入；unknown＝讀不到（離線、Worker 出錯）。 */
export type QuotaLookup = { kind: 'quota'; quota: Quota } | { kind: 'none' } | { kind: 'unknown' };

export interface QuotaIndicatorSyncDeps {
  lookup(): Promise<QuotaLookup>;
  show(indicator: QuotaIndicator): Promise<void>;
}

export function createQuotaIndicatorSync(deps: QuotaIndicatorSyncDeps) {
  let running: Promise<void> | undefined;
  let stale = false;

  async function run(): Promise<void> {
    while (stale) {
      stale = false;
      try {
        const result = await deps.lookup();
        // 讀不到就維持上次的樣子
        if (result.kind === 'unknown') continue;
        await deps.show(quotaIndicator(result.kind === 'quota' ? result.quota : undefined));
      } catch (e) {
        console.warn('quota indicator failed', e);
      }
    }
    running = undefined;
  }

  return {
    /** 連續翻好幾頁時不排隊：正在讀的時候又變了，讀完再讀一次就好。回傳的 promise 在全部讀完時 resolve。 */
    refresh(): Promise<void> {
      stale = true;
      running ??= run();
      return running;
    },
  };
}
