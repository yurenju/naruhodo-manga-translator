/**
 * SW 問 offscreen 這台電腦用哪一組模型（SW 裡 requestAdapter() 不會回應，見 detectExecutionProvider）。
 * 結果在這台電腦上不會變，問到一次就記住。offscreen 還沒掛上 listener 時 sendMessage 會 resolve 成 undefined
 * 而不是 reject（#221）：不是合法值就當成失敗，不記住，下次再問。
 */
import type { ExecutionProvider } from '../shared/messages.ts';

const isExecutionProvider = (value: unknown): value is ExecutionProvider => value === 'webgpu' || value === 'wasm';

export function createExecutionProviderDetector(ask: () => Promise<unknown>): () => Promise<ExecutionProvider> {
  let detected: Promise<ExecutionProvider> | undefined;
  return () => {
    detected ??= ask()
      .then((value) => {
        if (!isExecutionProvider(value)) throw new Error(`offscreen 回了不認得的 execution provider：${String(value)}`);
        return value;
      })
      .catch((e: unknown) => {
        detected = undefined;
        throw e;
      });
    return detected;
  };
}
