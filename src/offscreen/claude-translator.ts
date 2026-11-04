/**
 * Translator 的 Claude 實作（spec #27 第 5 節、#15）：offscreen document 直接 fetch Messages API，
 * 帶 anthropic-dangerous-direct-browser-access，不宣告 api.anthropic.com 的 host_permissions。
 * request body 的組法與回應的解析在共用模組 claude-request.ts（Worker 也 import 它，ADR 0006）；
 * 這裡只負責 HTTP：header、429／5xx 重試、量延遲。
 *
 * API key 只在 offscreen document 裡用（ADR 0001）；錯誤訊息只帶 API 回的訊息，不帶 key。
 */
import {
  CLAUDE_MODEL,
  notesRequest,
  parseNotesResponse,
  parseSeriesGuessResponse,
  parseTranslateResponse,
  seriesGuessRequest,
  translateRequest,
  type ApiResponse,
} from '../shared/claude-request.ts';
import type { NotesInput, NotesOutput, SeriesGuessOutput, TitleSignals, TranslateInput, TranslateOutput, Translator } from '../shared/translator.ts';

export { CLAUDE_MODEL, PROMPT_VERSION, costUsd, type ApiUsage } from '../shared/claude-request.ts';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
/** spec 第 3.4 節：429 最多重試 3 次。529／5xx 同樣處理。 */
const MAX_RETRIES = 3;

export interface ClaudeDeps {
  apiKey: string;
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** 重試前等待；signal 中止時應該 reject。 */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
}

const HEADERS = (apiKey: string) => ({
  'content-type': 'application/json',
  'x-api-key': apiKey,
  'anthropic-version': API_VERSION,
  'anthropic-dangerous-direct-browser-access': 'true',
});

export function createClaudeTranslator(deps: ClaudeDeps): Translator & { testConnection(): Promise<{ model: string }> } {
  async function post(body: unknown, signal?: AbortSignal): Promise<ApiResponse> {
    for (let attempt = 0; ; attempt++) {
      const response = await deps.fetch(API_URL, {
        method: 'POST',
        headers: HEADERS(deps.apiKey),
        body: JSON.stringify(body),
        signal,
      });
      if (response.ok) return (await response.json()) as ApiResponse;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) throw new Error(`Claude API ${response.status}：${await errorMessage(response)}`);
      const retryAfter = Number(response.headers.get('retry-after'));
      await deps.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 2000, signal);
    }
  }

  /** 送出並量延遲；回應的檢查與轉換交給 parse。 */
  async function call<T>(body: unknown, parse: (json: ApiResponse) => T, signal?: AbortSignal): Promise<T & { latencyMs: number }> {
    const started = deps.now();
    const json = await post(body, signal);
    const latencyMs = deps.now() - started;
    return { ...parse(json), latencyMs };
  }

  return {
    async translatePage(input: TranslateInput, signal?: AbortSignal): Promise<TranslateOutput> {
      return call(translateRequest(input), parseTranslateResponse, signal);
    },

    async proposeNotes(input: NotesInput, signal?: AbortSignal): Promise<NotesOutput> {
      return call(notesRequest(input), parseNotesResponse, signal);
    },

    async guessSeries(input: TitleSignals, signal?: AbortSignal): Promise<SeriesGuessOutput> {
      return call(seriesGuessRequest(input), parseSeriesGuessResponse, signal);
    },

    /** side panel 的「測試連線」：同一個 endpoint 與 header，送最小的 request（費用約 $0.000002）。 */
    async testConnection() {
      const json = await post({
        model: CLAUDE_MODEL,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
        output_config: { effort: 'low' },
      });
      return { model: json.model };
    },
  };
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? response.statusText;
  } catch {
    return response.statusText;
  }
}
