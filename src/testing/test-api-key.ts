/**
 * 真實 API smoke test 用的 key（spec #27 第 12 節第 4 層）：只看環境變數 NARUHODO_ANTHROPIC_KEY，
 * 由 `npm run smoke` 經過 `op run`（scripts/with-op.ts）從 1Password 放進來，硬碟上沒有（#175）。
 * 不用 ANTHROPIC_API_KEY（Claude Code 自己用它登入）。
 * key 只在測試程序裡用，不印出、不寫進 log 與報告。
 */
export const TEST_API_KEY_ENV = 'NARUHODO_ANTHROPIC_KEY';

export function readTestApiKey(): string | undefined {
  return process.env[TEST_API_KEY_ENV]?.trim() || undefined;
}
