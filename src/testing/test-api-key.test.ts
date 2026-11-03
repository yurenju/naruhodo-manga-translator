import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTestApiKey } from './test-api-key.ts';

describe('readTestApiKey', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reads NARUHODO_ANTHROPIC_KEY (op run puts it there), trimmed', () => {
    vi.stubEnv('NARUHODO_ANTHROPIC_KEY', ' sk-ant-from-op \n');
    expect(readTestApiKey()).toBe('sk-ant-from-op');
  });

  it('has no fallback: without the variable there is no key', () => {
    vi.stubEnv('NARUHODO_ANTHROPIC_KEY', '');
    // 比較布林值：失敗時 vitest 才不會把讀到的 key 印出來
    expect(readTestApiKey() === undefined).toBe(true);
  });
});
