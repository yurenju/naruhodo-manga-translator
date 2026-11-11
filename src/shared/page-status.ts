/**
 * 蓋在 Page 上的狀態與圖示 badge（#185）：不開側邊欄的讀者也看得到翻譯中、模型下載中、出問題。
 * SW 依每個 tab 的 PageView 算出來，content script 畫在每個 Page 的 anchor 上、SW 設成圖示的 badge。
 * 翻好的 Page 不留狀態（只有覆蓋層）。
 */
import type { ModelStatus, PageView, QuotaExhausted } from './messages.ts';
import type { RequestedStep } from './onboarding-step.ts';

/** 紅色小標籤點了做什麼：plan＝打開帳號頁（#213）；signIn＝登入、ownKey＝設定 API key 打開 onboarding 的那一步；retry＝重試這一頁。 */
export type StatusAction = RequestedStep | 'retry';

/** 一個 anchor 上的狀態；Spread 的兩頁共用一個 anchor，有一頁在翻就顯示翻譯中。 */
export interface AnchorStatus {
  anchorId: string;
  /** 翻譯中：右上角小標籤的文字；progress 0–1（模型下載），沒有＝不定進度。 */
  working?: { text: string; progress?: number };
  /** 出問題：可以點的紅色小標籤。 */
  problem?: { text: string; action: StatusAction; pageHash: string };
}

/** 圖示 badge：翻譯中 …、有問題 !、已啟動沒事是一個綠點，額度快用完（#237）是橘點。 */
export type ActionBadge = 'busy' | 'problem' | 'lowQuota' | 'on';

export interface PageStatusInput {
  /** 這個 tab 畫面上的 Page。 */
  pages: PageView[];
  model: ModelStatus;
  /** 已經送出 LLM 的 Page（pageHash）；其他 analyzing 的還在本機流水線。 */
  translating: ReadonlySet<string>;
  /** 現在不能翻譯的原因（沒登入或沒同意 → signIn，自備金鑰沒有 key → ownKey）；能翻是 undefined。 */
  access: Exclude<RequestedStep, 'plan'> | undefined;
  /** 內建翻譯的額度快用完（shared/quota-indicator.ts）；額度是全域的，每個 tab 都一樣。 */
  lowQuota: boolean;
}

type Status = Omit<AnchorStatus, 'anchorId'>;

const RETRY = '翻譯失敗・重試';

/**
 * 沒翻譯、也沒有錯或額度用完：只有不能翻（沒登入、沒有 key）才算問題，能翻的話是沒有字的頁。
 * SW 只在有這種頁時才去問能不能翻（page-status-sync.ts）。
 */
export const untranslatedWithoutReason = ({ transcript }: PageView): boolean =>
  transcript.state === 'done' && !transcript.translated && !transcript.translating && !transcript.translateError && !transcript.quotaExhausted;

const PROBLEMS: Record<RequestedStep, string> = {
  plan: '查看方案',
  signIn: '還沒登入・登入',
  ownKey: '還沒設定 API key・設定',
};

/** 額度用完的紅標籤：今天全站的免費額度發完了（#241）不是讀者自己的額度用完，不能說成「免費額度用完了」。 */
const QUOTA_EXHAUSTED: Record<QuotaExhausted, string> = {
  free: '免費額度用完了',
  monthly: '本月額度用完了',
  pausedToday: '今天的免費額度已經發完，明天再試',
};

function working(page: PageView, { model, translating }: PageStatusInput): Status['working'] {
  const { transcript } = page;
  if (transcript.state === 'done') return transcript.translating ? { text: '翻譯中…' } : undefined;
  if (transcript.state !== 'analyzing') return undefined;
  if (translating.has(page.pageHash)) return { text: '翻譯中…' };
  if (model.state === 'downloading') {
    const progress = model.total > 0 ? model.loaded / model.total : 0;
    return { text: `下載文字辨識模型 ${Math.round(progress * 100)}%`, progress };
  }
  if (model.state === 'loading') return { text: '載入文字辨識模型…' };
  return { text: '辨識文字…' };
}

function problem(page: PageView, { access }: PageStatusInput): Status['problem'] {
  const { transcript, pageHash } = page;
  if (transcript.state === 'error') return { text: RETRY, action: 'retry', pageHash };
  if (transcript.state !== 'done' || transcript.translated || transcript.translating) return undefined;
  if (transcript.translateError) return { text: RETRY, action: 'retry', pageHash };
  if (transcript.quotaExhausted) return { text: `${QUOTA_EXHAUSTED[transcript.quotaExhausted]}・${PROBLEMS.plan}`, action: 'plan', pageHash };
  // 沒翻譯、也沒有錯：能翻的話是沒有字的頁（長 Page 還沒收到字），不算問題
  if (access) return { text: PROBLEMS[access], action: access, pageHash };
  return undefined;
}

export function pageStatus(input: PageStatusInput): { anchors: AnchorStatus[]; badge: ActionBadge } {
  const byAnchor = new Map<string, Status>();
  let busy = false;
  let problems = false;
  for (const page of input.pages) {
    const current = byAnchor.get(page.anchorId) ?? {};
    const w = working(page, input);
    const p = w ? undefined : problem(page, input);
    busy ||= w !== undefined;
    problems ||= p !== undefined;
    // 有一頁在翻就顯示翻譯中；都沒在翻才顯示問題
    if (w && !current.working) byAnchor.set(page.anchorId, { working: w });
    else if (p && !current.working && !current.problem) byAnchor.set(page.anchorId, { problem: p });
  }
  return {
    anchors: [...byAnchor].map(([anchorId, status]) => ({ anchorId, ...status })),
    // 出問題 > 翻譯中 > 快用完 > 平常：翻譯中先顯示藍色，翻完再變回橘色
    badge: problems ? 'problem' : busy ? 'busy' : input.lowQuota ? 'lowQuota' : 'on',
  };
}
