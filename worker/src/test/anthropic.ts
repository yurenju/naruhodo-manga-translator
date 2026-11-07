/** Worker 測試共用的假 Anthropic：vi.spyOn(fetch) 依序回傳準備好的回應。 */
import { vi } from 'vitest';
import { CLAUDE_MODEL } from '../../../src/shared/claude-request.ts';

/** 四種 token 都有：input 總和是 200 + 100 + 700 = 1000，費用依 CLAUDE_MODEL 的價目表是 USAGE_COST_USD。 */
export const usage = { input_tokens: 200, output_tokens: 200, cache_creation_input_tokens: 100, cache_read_input_tokens: 700 };

/** usage 的費用，用 claude-haiku-5-5 的 list price 手算：200×0.1 + 100×0.125 + 700×0.01 + 200×0.5 = 139.5（$/MTok × tokens）。 */
export const USAGE_COST_USD = 0.0001395;

/** Anthropic 的成功回應，內容是 answer 的 JSON。 */
export const reply = (answer: unknown) => () =>
  Response.json({ model: CLAUDE_MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }], usage });

/** 依序回傳 responses，記下每次送出的網址、init 與 body。 */
export function fakeAnthropic(responses: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; init: RequestInit; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init = {}) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body as string) });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    return next();
  });
  return { calls };
}
