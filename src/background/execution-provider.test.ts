import { describe, expect, it, vi } from 'vitest';
import { createExecutionProviderDetector } from './execution-provider.ts';

describe('SW 問 offscreen 這台電腦用哪一組模型（#221）', () => {
  it('offscreen 還沒掛上 listener 回 undefined：這次算失敗，下一次重新問', async () => {
    const ask = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce(undefined).mockResolvedValueOnce('webgpu');
    const executionProvider = createExecutionProviderDetector(ask);

    await expect(executionProvider()).rejects.toThrow();
    expect(await executionProvider()).toBe('webgpu');
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('問到合法值就記住，之後不再問', async () => {
    const ask = vi.fn(async (): Promise<unknown> => 'wasm');
    const executionProvider = createExecutionProviderDetector(ask);

    expect(await executionProvider()).toBe('wasm');
    expect(await executionProvider()).toBe('wasm');
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
