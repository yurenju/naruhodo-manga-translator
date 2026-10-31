import type { Stripe } from './long-page.ts';
import type { PageText, RatioRect } from './page-text.ts';
import type { EditableFields, NotesSuggestion, StaleReason, SuggestionRef } from './series-notes.ts';
import type { SeriesOption } from './series.ts';
import type { NotesChanges, NotesEntry, NotesInput, NotesOutput, TranslateInput, TranslateOutput } from './translator.ts';

/** onnxruntime-web 的執行環境。 */
export type ExecutionProvider = 'webgpu' | 'wasm';

/** 各 context 之間的 chrome.runtime / chrome.tabs 訊息。 */
export type Message =
  /** side panel → SW：這個 tab 啟動了沒？回應 StatusResponse。 */
  | { type: 'panel:getStatus'; tabId: number }
  /** side panel → SW：停止這個 tab。 */
  | { type: 'panel:stop'; tabId: number }
  /** SW → side panel：某個 tab 的啟動狀態改變了。 */
  | { type: 'status:changed'; tabId: number; active: boolean }
  /** SW → content script：清理並結束。 */
  | { type: 'content:stop' }
  /** side panel → SW：重新找 Page 並截圖。 */
  | { type: 'panel:scan'; tabId: number }
  /** side panel → SW：目前這個 tab 的 Page。回應 PagesResponse。 */
  | { type: 'panel:getPages'; tabId: number }
  /** SW → side panel：某個 tab 的 Page（縮圖＋逐字稿）更新了。 */
  | { type: 'pages:updated'; tabId: number; pages: PageView[] }
  /** SW → content script：量畫面上完整可見的 Page 候選。回應 PageCandidatesResponse。 */
  | { type: 'content:findPageCandidates' }
  /** SW → offscreen：依候選裁切截圖並做縮圖。回應 CropResponse。 */
  | ({ type: 'offscreen:crop' } & CropRequest)
  /** SW → offscreen：對一個 Page 跑本機流水線（偵測＋OCR＋閱讀順序＋kuromoji 讀音）。回應 AnalyzeResponse。 */
  | ({ type: 'offscreen:analyze' } & AnalyzeRequest)
  /** offscreen → 全部：模型下載／載入狀態。 */
  | { type: 'models:status'; status: ModelStatus }
  /** 登入（side panel、onboarding）、或 Worker 說 token 已失效（SW 清掉）→ 全部：Hosted Translation 的 session 變了，重新讀（shared/hosted-session.ts）；SW 收到就翻已啟動分頁裡還沒翻的頁。 */
  | { type: 'session:changed' }
  /** SW → side panel：內建翻譯的剩餘額度可能變了（翻譯扣了一頁、Worker 說用完了），重新向 Worker 讀。 */
  | { type: 'quota:changed' }
  /** side panel → SW：目前的模型狀態。回應 ModelStatusResponse。 */
  | { type: 'panel:getModelStatus' }
  /**
   * side panel → SW：「翻譯此頁／重新翻譯」：用已經辨識好的原文重新呼叫 Translator。
   * pageHash：只翻這一頁（過時提示的「重新翻譯」，#38）。
   */
  | { type: 'panel:translate'; tabId: number; pageHash?: string }
  /**
   * SW → offscreen：翻譯一個 Page。回應 TranslateResponse。
   * API key 不在訊息裡：offscreen 自己從 IndexedDB 讀（spec 第 5 節：key 永遠不經過 messaging）。
   */
  | { type: 'offscreen:translate'; input: TranslateInput; fake?: FakeTranslatorConfig }
  /** SW → offscreen：整理一個 Page 的 Series Notes（ADR 0005 的 ②）。回應 ProposeNotesResponse。 */
  | { type: 'offscreen:proposeNotes'; input: NotesInput; fake?: FakeTranslatorConfig }
  /** side panel → SW → offscreen：「測試連線」。回應 TestConnectionResponse。 */
  | { type: 'panel:testConnection' }
  | { type: 'offscreen:testConnection' }
  /**
   * SW → content script：把一個 Page 的譯文原地覆蓋在 anchor 上（#32）。subRect＝Page 在 anchor 裡的範圍
   * （沒給＝整個 anchor；Spread 的一頁或去掉黑邊，#35）。pageHash＝Page 身分，hover 同步用（同一個 anchor 可能有兩個 Page）。
   */
  | { type: 'content:showOverlay'; anchorId: string; pageHash: string; subRect?: RatioRect; text: PageText }
  /**
   * SW → content script：截圖前開始重繪動畫（#60）、藏起疊在 Page 上的元素（#59），hideOverlay 時也藏覆蓋層；等兩個 rAF（已重繪）才回應。
   */
  | { type: 'content:prepareCapture'; hideOverlay: boolean }
  /** SW → content script：截完還原。回應 CaptureFinishedResponse。 */
  | { type: 'content:finishCapture' }
  /** content script → SW：翻頁訊號 debounce 後（#34）。SW 截圖比對 hash，變了才算翻頁。 */
  | { type: 'content:pageTurn' }
  /** content script → SW：覆蓋層畫好了。SW 不藏覆蓋層截一次，記下這頁帶覆蓋層的樣子（#27 除錯）。 */
  | { type: 'content:overlayShown' }
  /** side panel → SW：「自動翻譯」開關（#34）。 */
  | { type: 'panel:setAutoTranslate'; tabId: number; enabled: boolean }
  /** side panel → SW：自動翻譯開關目前的狀態。回應 AutoTranslateResponse。 */
  | { type: 'panel:getAutoTranslate'; tabId: number }
  /** side panel → SW：Series 下拉選單與這個 tab 目前的 Series。回應 SeriesResponse。 */
  | { type: 'panel:getSeries'; tabId: number }
  /** side panel → SW：選了一部 Series（非 Provisional 才記住網址模式）；之後的快取查詢與翻譯改用它。 */
  | { type: 'panel:selectSeries'; tabId: number; seriesId: string }
  /** side panel → SW：「新增 Series…」並選它。 */
  | { type: 'panel:createSeries'; tabId: number; name: string }
  /** side panel → SW：目前的 Series 改名（Provisional 改名＝歸類，ID 不變）。 */
  | { type: 'panel:renameSeries'; tabId: number; name: string }
  /** side panel → SW：目前的 Provisional Series 合併進 targetId；不自動重翻。 */
  | { type: 'panel:mergeSeries'; tabId: number; targetId: string }
  /** SW → side panel：這個 tab 的 Series 或 Series 清單變了，重新 panel:getSeries。 */
  | { type: 'series:changed'; tabId: number }
  /** side panel → SW：這個 tab 目前 Series 的 Notes 條目與要列出的建議修改（#38）。回應 NotesResponse。 */
  | { type: 'panel:getNotes'; tabId: number }
  /** side panel → SW：修正一個條目（之後 locked）。 */
  | { type: 'panel:editNote'; tabId: number; 原文: string; fields: EditableFields }
  /** side panel → SW：接受／忽略一個建議修改。 */
  | { type: 'panel:acceptSuggestion' | 'panel:ignoreSuggestion'; tabId: number; suggestion: SuggestionRef }
  /** side panel → SW：清除這個 tab 目前 Series 的翻譯快取。 */
  | { type: 'panel:clearCache'; tabId: number }
  /** SW → side panel：某部 Series 的 Notes 變了（人改的或翻譯時套用的），重新 panel:getNotes。 */
  | { type: 'notes:changed'; seriesId: string }
  /** side panel → SW：匯出全部 Series、網址模式、Notes、快取（不含 API key）。回應 BackupFile。 */
  | { type: 'panel:export' }
  /** side panel → SW：匯入匯出檔（合併，本機優先）。回應 ImportResponse。 */
  | { type: 'panel:import'; data: unknown }
  /**
   * content script → side panel（runtime 廣播，panel 用 sender.tab 分辨）：滑鼠在頁面上的哪一句上；
   * null＝離開（#39）。
   */
  | { type: 'content:hover'; line: LineRef | null }
  /** side panel → content script（tabs.sendMessage）：滑過 panel 那行時高亮頁面上的那句；null＝取消。 */
  | { type: 'content:highlight'; line: LineRef | null }
  /** e2e build 才有：等同點外掛圖示（spec #27 第 12 節）。 */
  | { type: 'test:activate'; tabId: number };

/**
 * 一個 Page 上的一句（line：一個 Balloon 或 Loose Text 項目）。lineId（b1、l1…）每個 Page 各自編號，
 * 所以要連同 Page 身分（PageView.pageHash）一起才認得出是哪一句。
 */
export interface LineRef {
  pageHash: string;
  lineId: string;
}

/** e2e build 才有（SW 的 globalThis.__configureForTest）：模型下載來源、強制 wasm、改用 FakeTranslator。 */
export interface TestConfig {
  pipeline: PipelineConfig;
  fakeTranslator: boolean;
  /**
   * true：跟正式 build 一樣，要先在設定區存 API key 才會翻譯（FakeTranslator 取代的只是 Claude）。
   * 預設 false：FakeTranslator 不需要 key（#30 起的 e2e 都這樣用）。
   */
  requireApiKey?: boolean;
  /** FakeTranslator 把這些 ground truth 原文當成無法辨識（模擬 Claude 回 unreadable）。 */
  unreadableTexts?: string[];
  /** FakeTranslator 在 Balloon 原文裡看到這些條目、而 Notes 還沒有時，回傳成新增的條目（#37）。 */
  fakeNotes?: NotesChanges['added'];
  /**
   * true：當作全新安裝處理 runtime.onInstalled（預設內建翻譯、打開 onboarding，#93）。
   * 預設 false：e2e build 不處理安裝事件，翻譯模式與 onboarding 都是 #93 以前的狀態（自備金鑰、設定已完成）。
   */
  freshInstall?: boolean;
}

/** e2e build 才有：offscreen 用 FakeTranslator 取代 Claude。 */
export interface FakeTranslatorConfig {
  unreadableTexts: string[];
  notes: NotesChanges['added'];
}

export type TranslateResponse = { output: TranslateOutput } | { error: string; noApiKey?: true };

export type ProposeNotesResponse = { output: NotesOutput } | { error: string };

export type TestConnectionResponse = { ok: true; model: string } | { ok: false; error: string };

export interface StatusResponse {
  active: boolean;
}

export interface CaptureFinishedResponse {
  /** false：藏起來的元素在截圖期間被換掉，這張截圖不能用（#59）。 */
  stable: boolean;
}

export interface SeriesResponse {
  /** 這個 tab 目前的 Series；沒啟動是 undefined。 */
  current: string | undefined;
  /** 已排好：最近用過的在最上面。 */
  options: SeriesOption[];
}

/** 沒啟動（沒有 Series）時 seriesId 是 undefined、列表是空的。 */
export interface NotesResponse {
  seriesId: string | undefined;
  entries: NotesEntry[];
  /** 已去重、沒忽略、跟目前譯文不同的建議修改。 */
  suggestions: NotesSuggestion[];
}

export type ImportResponse = { ok: true } | { ok: false; error: string };

export interface AutoTranslateResponse {
  enabled: boolean;
}

/** 畫面座標（CSS px，相對 viewport 左上角）。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** 哪個 anchor 上的哪一個 Page（Spread 的兩頁在同一個 anchor 上，要靠 pageHash 分）。 */
export interface PageOnAnchor {
  anchorId: string;
  pageHash: string;
}

/** 一個 Page 候選。anchorId 對應 content script 記在記憶體裡的元素（anchor）。 */
export interface PageCandidate {
  anchorId: string;
  rect: Rect;
  /**
   * 直式捲動的長 Page（比可見範圍高、寬度放得下，spec #142）才有：看得到的那一截（anchor rect ∩ viewport ∩ 裁切祖先，CSS px）。
   * 截圖只裁這一截、本機流水線只跑這一截，截圖時也不藏它的覆蓋層。
   */
  visible?: Rect;
  /** 長 Page 才有：截圖裡會出現的自己的擦除與譯文（畫面 CSS px）；跟它們有交集的橫條不算指紋。沒有覆蓋層時省略。 */
  covered?: Rect[];
  /** 這個 anchor 上正顯示著覆蓋層的 Page（pageHash）；沒有覆蓋層時省略。 */
  overlaid?: string[];
}

export interface PageCandidatesResponse {
  /** 量 rect 當下的 viewport（CSS px），裁切時用來換算截圖倍率。 */
  viewport: Size;
  candidates: PageCandidate[];
}

export interface CropRequest extends PageCandidatesResponse {
  /** captureVisibleTab 的 data URL。 */
  screenshot: string;
}

export interface PageThumb extends PageCandidate {
  /** Page 在 anchor 裡的範圍（Spread 切開的一頁，或去掉黑邊）；整個 anchor 就是一個 Page 時省略。 */
  subRect?: RatioRect;
  /** 裁切後縮小的 data URL。 */
  thumbnail: string;
  /**
   * Page 的身分（shared/page-hash.ts），從全解析度的裁切算出來；翻譯快取的 key。
   * 長 Page 的身分是 stripes：這裡先放第一條橫條的 hash（沒有就是空字串），transcriber 認出是哪個 Page 後換掉。
   */
  pageHash: string;
  /** 長 Page 才有：這一截裡完整看得到、有內容的橫條（shared/long-page.ts）。 */
  stripes?: Stripe[];
}

export type CropResponse = { pages: PageThumb[] } | { error: string };

/**
 * 狀態列顯示的翻譯資訊（spec #27 第 8 節）：「已翻譯」或「快取」・模型・秒數・費用。
 * 快取（#33）時是當初翻譯的模型與數字。
 */
export type TranslationInfo = Pick<TranslateOutput, 'model' | 'latencyMs' | 'usage'> & { source: 'translated' | 'cache' };

/** side panel 顯示的一個 Page：縮圖＋逐字稿的狀態。 */
export interface PageView extends PageThumb {
  transcript:
    /** 排在佇列裡或正在本機流水線／LLM。 */
    | { state: 'analyzing' }
    /** 自動翻譯關著（#34）：等使用者按「翻譯此頁」。 */
    | { state: 'pending' }
    /**
     * translated=false：沒有 Translator（沒有 API key）或翻譯失敗（translateError），讀音是 kuromoji、沒有譯文。
     * translating：按了「翻譯此頁」，正在等 Translator；text 仍是上一份。
     */
    | {
        state: 'done';
        text: PageText;
        translated: boolean;
        translating?: boolean;
        translation?: TranslationInfo;
        translateError?: string;
        /** 快取的這頁過時了（#38）：只提示，按「重新翻譯」才重翻。 */
        stale?: StaleReason;
      }
    | { state: 'error'; message: string };
}

export interface PagesResponse {
  pages: PageView[];
}

/** 只有 e2e 會設定；正式 build 一律從 Hugging Face 下載、自動選 WebGPU／wasm。 */
export interface PipelineConfig {
  /** 取代 https://huggingface.co 的下載來源（mock site）。 */
  modelBaseUrl?: string;
  executionProvider?: ExecutionProvider;
  /** wasm 執行緒上限；e2e 平行跑好幾個瀏覽器時避免互搶 CPU。 */
  maxThreads?: number;
  /** browser test：用 FakeEngine（合成頁的 ground truth）取代模型，不下載也不跑 ONNX（ADR 0007）。 */
  fakeOcr?: boolean;
  /** FakeEngine 每頁故意花的時間（測佇列排程時模擬 OCR 很慢）。 */
  fakeOcrDelayMs?: number;
}

export interface AnalyzeRequest {
  screenshot: string;
  viewport: Size;
  candidate: PageCandidate;
  /** Page 在候選裡的範圍（PageThumb.subRect）；省略＝整個候選。 */
  subRect?: RatioRect;
  /** 長 Page（candidate.visible）才有：已收 Line 的外框（Page 座標），這一截裡跟它們重疊的框不做 OCR。 */
  collected?: RatioRect[];
  /** e2e build 才會帶。 */
  pipeline?: PipelineConfig;
}

export type AnalyzeResponse = { text: PageText } | { error: string };

export type ModelStatus =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'downloading'; loaded: number; total: number }
  | { state: 'ready'; executionProvider: ExecutionProvider; threads: number }
  | { state: 'error'; message: string };

export interface ModelStatusResponse {
  status: ModelStatus;
}
