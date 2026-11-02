import { describe, expect, it, vi } from 'vitest';
import type { ModelStatus } from '../shared/messages.ts';
import { currentModelStatus } from './model-status.ts';

describe('SW 回答目前的模型狀態（#169）', () => {
  it('不知道（SW 剛啟動、或模型已釋放）而那一組模型都在快取裡：downloaded', async () => {
    expect(await currentModelStatus({ state: 'idle' }, async () => true)).toEqual({ state: 'downloaded' });
  });

  it('不知道而快取裡不齊全：idle', async () => {
    expect(await currentModelStatus({ state: 'idle' }, async () => false)).toEqual({ state: 'idle' });
  });

  it('知道的狀態照實回答，不查快取', async () => {
    const isCached = vi.fn(async () => true);
    const known: ModelStatus[] = [
      { state: 'downloading', loaded: 1, total: 2 },
      { state: 'downloaded' },
      { state: 'loading' },
      { state: 'ready', executionProvider: 'wasm', threads: 2 },
      { state: 'error', message: '下載失敗' },
    ];
    for (const status of known) expect(await currentModelStatus(status, isCached)).toEqual(status);
    expect(isCached).not.toHaveBeenCalled();
  });
});
