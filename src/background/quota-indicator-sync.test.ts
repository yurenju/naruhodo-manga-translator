import { describe, expect, it } from 'vitest';
import type { Quota } from '../shared/hosted-api.ts';
import type { QuotaIndicator } from '../shared/quota-indicator.ts';
import { createQuotaIndicatorSync, type QuotaLookup } from './quota-indicator-sync.ts';

const free = (remaining: number): QuotaLookup => ({ kind: 'quota', quota: { plan: 'free', remaining } satisfies Quota });

function setup(lookups: (() => Promise<QuotaLookup>)[]) {
  const shown: QuotaIndicator[] = [];
  let calls = 0;
  const sync = createQuotaIndicatorSync({
    lookup: () => lookups[Math.min(calls++, lookups.length - 1)]!(),
    show: async (indicator) => void shown.push(indicator),
  });
  return { sync, shown, calls: () => calls };
}

describe('圖示的剩餘頁數跟著額度更新（#237）', () => {
  it('讀到額度就更新；自備金鑰或沒登入回到只有名字', async () => {
    const { sync, shown } = setup([async () => free(18), async () => ({ kind: 'none' })]);

    await sync.refresh();
    await sync.refresh();

    expect(shown.map((s) => s.lowQuota)).toEqual([true, false]);
    expect(shown[1]!.title).toBe('Naruhodo 漫畫翻譯');
  });

  it('讀不到額度（離線、Worker 出錯）：維持上次的樣子', async () => {
    const { sync, shown } = setup([async () => free(18), async () => ({ kind: 'unknown' })]);

    await sync.refresh();
    await sync.refresh();

    expect(shown).toHaveLength(1);
  });

  it('連續翻好幾頁：正在讀的時候又變了，讀完只再讀一次', async () => {
    let release!: () => void;
    const first = new Promise<QuotaLookup>((resolve) => (release = () => resolve(free(30))));
    const { sync, shown, calls } = setup([() => first, async () => free(27)]);

    const running = sync.refresh();
    void sync.refresh();
    void sync.refresh();
    release();
    await running;

    expect(calls()).toBe(2);
    expect(shown.at(-1)!.title).toBe('Naruhodo 漫畫翻譯\n免費額度剩 27 頁');
  });
});
