/**
 * Translator 的 Hosted Translation 實作（spec #86、ADR 0006）：把結構化輸入（Lines、Prior Pages、Series Notes）
 * 送到 Worker，帶上 session token。prompt、model、max_tokens 由 Worker 決定，這裡不碰。
 * 在 SW 裡跑：不需要 offscreen document，token 也不經過任何訊息。
 *
 * 重試：429／503 是 Worker 本身忙，等一下再送；502 是 Anthropic 失敗，Worker 已經重試過，這裡不再重試。
 * 401 是 token 已失效（撤銷或閒置太久）：呼叫 onSignedOut 讓外掛回到未登入。
 * 402 是額度用完：丟出 QuotaExhaustedError，pipeline 把這頁當成沒翻譯（顯示原文與讀音），不當成失敗。
 * 翻譯成功（扣了一頁）與額度用完都呼叫 onQuotaChanged，side panel 重新讀剩餘頁數。
 */
import { bearerHeader, NOTES_PATH, readHostedError, SERIES_GUESS_PATH, TRANSLATE_PATH, type HostedErrorReason } from '../shared/hosted-api.ts';
import type { NotesInput, NotesOutput, SeriesGuessOutput, TitleSignals, TranslateInput, TranslateOutput, Translator } from '../shared/translator.ts';

const MAX_RETRIES = 3;

/** Worker 說額度用完（402）；reason 是 freePagesExhausted（免費額度用完）或 monthlyLimitReached（本月額度用完）。 */
export class QuotaExhaustedError extends Error {
  readonly reason: HostedErrorReason;

  constructor(message: string, reason: HostedErrorReason) {
    super(message);
    this.name = 'QuotaExhaustedError';
    this.reason = reason;
  }
}

export interface HostedDeps {
  /** Worker 的網址（scripts/build.ts 依 build 決定）。 */
  apiUrl: string;
  token: string;
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** 重試前等待；signal 中止時應該 reject。 */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
  /** Worker 說這個 token 已經不能用（401）。 */
  onSignedOut(): void;
  /** 剩餘額度可能變了：翻譯成功扣了一頁，或 Worker 說額度用完。 */
  onQuotaChanged(): void;
}

export function createHostedTranslator(deps: HostedDeps): Translator {
  /** 送出並量延遲（含 Worker 那一段，讀者感受到的就是這個）；Worker 回的 latencyMs 只到 Anthropic，不用。 */
  async function call<T extends { latencyMs: number }>(path: string, input: unknown, signal?: AbortSignal): Promise<T> {
    const started = deps.now();
    for (let attempt = 0; ; attempt++) {
      const response = await deps.fetch(deps.apiUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...bearerHeader(deps.token) },
        body: JSON.stringify(input),
        signal,
      });
      if (response.ok) return { ...((await response.json()) as T), latencyMs: deps.now() - started };
      if (response.status === 401) deps.onSignedOut();
      const retryable = response.status === 429 || response.status === 503;
      if (retryable && attempt < MAX_RETRIES) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await deps.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 2000, signal);
        continue;
      }
      const error = await readHostedError(response);
      const message = `Hosted Translation ${response.status}：${error.error}`;
      if (response.status === 402 && error.reason) {
        deps.onQuotaChanged();
        throw new QuotaExhaustedError(message, error.reason);
      }
      throw new Error(message);
    }
  }

  async function translatePage(input: TranslateInput, signal?: AbortSignal): Promise<TranslateOutput> {
    const output = await call<TranslateOutput>(TRANSLATE_PATH, input, signal);
    deps.onQuotaChanged();
    return output;
  }

  return {
    translatePage,
    proposeNotes: (input: NotesInput, signal?: AbortSignal) => call<NotesOutput>(NOTES_PATH, input, signal),
    // 不扣頁，所以不通知額度變了
    guessSeries: (input: TitleSignals, signal?: AbortSignal) => call<SeriesGuessOutput>(SERIES_GUESS_PATH, input, signal),
  };
}
