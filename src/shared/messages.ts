import type { FrameMark, FrameVerdict } from './frame-mark.ts';
import type { BillingPeriod } from './hosted-api.ts';
import type { Stripe } from './long-page.ts';
import type { PageText, RatioRect } from './page-text.ts';
import type { EditableFields, NotesSuggestion, StaleReason, SuggestionRef } from './series-notes.ts';
import type { AnchorStatus, StatusAction } from './page-status.ts';
import type { SeriesOption } from './series.ts';
import type { NotesChanges, NotesEntry, NotesInput, NotesOutput, SeriesGuessOutput, TitleSignals, TranslateInput, TranslateOutput } from './translator.ts';

/** onnxruntime-web 的執行環境。 */
export type ExecutionProvider = 'webgpu' | 'wasm';

/** 各 context 之間的 chrome.runtime / chrome.tabs 訊息。 */
export type Message =
  /** side panel → SW：這個 tab 啟動了沒？回應 StatusResponse。 */
  | { type: 'panel:getStatus'; tabId: number }
  /** SW → side panel：某個 tab 的啟動狀態改變了。 */
  | { type: 'status:changed'; tabId: number; active: boolean }
  /** SW → content script：清理並結束。 */
  | { type: 'content:stop' }
  /** side panel → SW：重新找 Page 並截圖。 */
  | { type: 'panel:scan'; tabId: number }
  /** side panel → SW：目前這個 tab 的 Page。回應 PagesResponse。 */
  | { type: 'panel:getPages'; tabId: number }
  /** SW → side panel：某個 tab 的 Page（縮圖＋逐字稿）更新了。 */
  | { type: 'pages:updated'; tabId: number; pages: PageView[]; strip?: StripStatus }
  /** SW → content script：量畫面上完整可見的 Page 候選。回應 PageCandidatesResponse。 */
  | { type: 'content:findPageCandidates' }
  /** SW → offscreen：依候選裁切截圖並做縮圖。回應 CropResponse。 */
  | ({ type: 'offscreen:crop' } & CropRequest)
  /** SW → offscreen：對一個 Page 跑本機流水線（偵測＋OCR＋閱讀順序＋kuromoji 讀音）。回應 AnalyzeResponse。 */
  | ({ type: 'offscreen:analyze' } & AnalyzeRequest)
  /** SW → offscreen：原文 → kuromoji 整句讀音（命中 #195 之前的快取時換掉 LLM 的讀音）。回應 KuromojiReadingsResponse。 */
  | { type: 'offscreen:kuromojiReadings'; texts: string[] }
  /** offscreen → 全部：模型下載／載入狀態。 */
  | { type: 'models:status'; status: ModelStatus }
  /** 登入（side panel、onboarding）、或 Worker 說 token 已失效（SW 清掉）→ 全部：Hosted Translation 的 session 變了，重新讀（shared/hosted-session.ts）；SW 收到就翻已啟動分頁裡還沒翻的頁。 */
  | { type: 'session:changed' }
  /** SW → side panel：內建翻譯的剩餘額度可能變了（翻譯扣了一頁、Worker 說用完了），重新向 Worker 讀。 */
  | { type: 'quota:changed' }
  /** onboarding、side panel、帳號頁 → SW：「訂閱」拿到 checkout 網址（from＝誰按了「訂閱」，shared/payment-return.ts 的 PaymentFrom），請 SW 開付款分頁，付款後帶讀者回到 originTabId（#176）。 */
  | { type: 'payment:open'; url: string; originTabId: number; from: 'onboarding' | 'account'; billingPeriod: BillingPeriod }
  /** side panel、onboarding → SW：目前的模型狀態。回應 ModelStatusResponse。 */
  | { type: 'panel:getModelStatus' }
  /** onboarding → SW：在背景把辨識模型下載進快取（#169），進度走 models:status。 */
  | { type: 'onboarding:prefetchModels' }
  /** SW → offscreen：只下載進 Cache Storage，不建 session、不載入記憶體。 */
  | { type: 'offscreen:prefetchModels'; pipeline?: PipelineConfig }
  /** SW → offscreen：這台電腦會用哪一組模型。SW 裡的 navigator.gpu.requestAdapter() 不會回應，要在 document 裡偵測。回應 ExecutionProvider。 */
  | { type: 'offscreen:detectExecutionProvider' }
  /**
   * side panel → SW：「翻譯此頁／重試」：用已經辨識好的原文翻譯還沒翻譯的頁。
   * pageHash：只翻這一頁（過時提示的「重新翻譯」，#38）。
   */
  | { type: 'panel:translate'; tabId: number; pageHash?: string }
  /** side panel → SW：底部的「重新翻譯」：畫面上的頁從辨識開始整個重來（Retranslation），不拿快取。 */
  | { type: 'panel:retranslate'; tabId: number }
  /**
   * SW → offscreen：翻譯一個 Page。回應 TranslateResponse。
   * API key 不在訊息裡：offscreen 自己從 IndexedDB 讀（spec 第 5 節：key 永遠不經過 messaging）。
   */
  | { type: 'offscreen:translate'; input: TranslateInput; fake?: FakeTranslatorConfig }
  /** SW → offscreen：整理一個 Page 的 Series Notes（ADR 0005 的 ②）。回應 ProposeNotesResponse。 */
  | { type: 'offscreen:proposeNotes'; input: NotesInput; fake?: FakeTranslatorConfig }
  /** SW → offscreen：從頁面標題猜作品原名（#186）。回應 GuessSeriesResponse。 */
  | { type: 'offscreen:guessSeries'; input: TitleSignals; fake?: FakeTranslatorConfig }
  /** side panel → SW → offscreen：「測試連線」。回應 TestConnectionResponse。 */
  | { type: 'panel:testConnection' }
  | { type: 'offscreen:testConnection' }
  /**
   * SW → content script：把一個 Page 的譯文原地覆蓋在 anchor 上（#32）。subRect＝Page 在 anchor 裡的範圍
   * （沒給＝整個 anchor；Spread 的一頁或去掉黑邊，#35）。pageHash＝Page 身分，hover 同步用（同一個 anchor 可能有兩個 Page）。
   */
  | { type: 'content:showOverlay'; anchorId: string; pageHash: string; subRect?: RatioRect; text: PageText }
  /** SW → content script：截圖看到 anchor 上已經換成別頁，拿掉這幾頁的覆蓋層（#276）。 */
  | { type: 'content:removeOverlay'; anchorId: string; pageHashes: string[] }
  /** SW → content script：截圖確認 anchor 上剩下的覆蓋層還是同一頁，anchor 重新出現時先藏著的層可以顯示了（#276）。 */
  | { type: 'content:confirmOverlay'; anchorId: string }
  /**
   * SW → content script：截圖前開始重繪動畫（#60）、藏起疊在 Page 上的元素（#59），hideOverlay 時也藏覆蓋層；等兩個 rAF（已重繪）才回應 CapturePreparedResponse。
   * mark：同時畫上的 frame 記號（shared/frame-mark.ts）。
   */
  | { type: 'content:prepareCapture'; hideOverlay: boolean; mark: FrameMark }
  /** SW → content script：截完還原。回應 CaptureFinishedResponse。 */
  | { type: 'content:finishCapture' }
  /** content script → SW：翻頁訊號 debounce 後（#34）。SW 截圖比對 hash，變了才算翻頁。 */
  | { type: 'content:pageTurn' }
  /** content script → SW：覆蓋層畫好了。SW 不藏覆蓋層截一次，記下這頁帶覆蓋層的樣子（#27 除錯）。 */
  | { type: 'content:overlayShown' }
  /** side panel → SW：Series 下拉選單與這個 tab 目前的 Series。回應 SeriesResponse。 */
  | { type: 'panel:getSeries'; tabId: number }
  /** side panel → SW：選了一部 Series（非 Provisional 才記住網址模式）；之後的快取查詢與翻譯改用它。 */
  | { type: 'panel:selectSeries'; tabId: number; seriesId: string }
  /** side panel → SW：作品卡的「是」（#186）：確認目前的 Series（拿掉 provisional、記住網址模式）。 */
  | { type: 'panel:confirmSeries'; tabId: number }
  /** side panel → SW：「新增 Series…」並選它。 */
  | { type: 'panel:createSeries'; tabId: number; name: string }
  /** side panel → SW：目前的 Series 改名（Provisional 改名＝歸類，ID 不變）。 */
  | { type: 'panel:renameSeries'; tabId: number; name: string }
  /** side panel → SW：目前的 Provisional Series 合併進 targetId；不自動重翻。 */
  | { type: 'panel:mergeSeries'; tabId: number; targetId: string }
  /** SW → side panel：這個 tab 的 Series 或 Series 清單變了，重新 panel:getSeries。 */
  | { type: 'series:changed'; tabId: number }
  /** side panel → SW：刪除這個 tab 目前的 Series（#214），顯示它的 tab 都停用。 */
  | { type: 'panel:deleteSeries'; tabId: number }
  /** SW → side panel：這部 Series 刪掉了，tabIds 是因此停用的 tab（它們的 side panel 顯示「這部作品已刪除」）。 */
  | { type: 'series:deleted'; seriesId: string; tabIds: number[] }
  /** side panel → SW：這個 tab 目前 Series 的 Notes 條目與要列出的建議修改（#38）。回應 NotesResponse。 */
  | { type: 'panel:getNotes'; tabId: number }
  /** side panel → SW：修正一個條目（之後 locked）。 */
  | { type: 'panel:editNote'; tabId: number; 原文: string; fields: EditableFields }
  /** side panel → SW：刪除一個條目（#214）；exclude＝原文變成不記的詞。 */
  | { type: 'panel:deleteNote'; tabId: number; 原文: string; exclude: boolean }
  /** side panel → SW：恢復一個不記的詞（#214）。 */
  | { type: 'panel:restoreExcluded'; tabId: number; 原文: string }
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
  /** onboarding → SW：點圖示時卡住、解決後按「回到漫畫」（#185）：切回那個分頁、接著翻還沒翻的頁。 */
  | { type: 'onboarding:return'; tabId: number }
  /** SW → content script：這個 tab 每個 anchor 上的狀態（#185），整份換掉；沒列到的 anchor 拿掉狀態。 */
  | { type: 'content:pageStatus'; anchors: AnchorStatus[] }
  /** SW → content script：這個 tab 每個 Page 上的外圈（#285 翻譯中、#283 等待中），整份換掉；沒列到的拿掉。 */
  | { type: 'content:pageOutlines'; pages: PageOutlines[] }
  /** content script → SW：Page 上的紅色小標籤被點了（#185）。 */
  | { type: 'content:statusAction'; action: StatusAction; pageHash: string }
  /** e2e build 才有：等同點外掛圖示（spec #27 第 12 節）。 */
  | { type: 'test:activate'; tabId: number }
  /** e2e build 才有：等同已啟動時再點一次外掛圖示（停止），但不關 side panel（測試的 panel 是獨立視窗）。 */
  | { type: 'test:stop'; tabId: number };

/**
 * 一個 Page 上的一句（line：一個 Balloon 或 Loose Text 項目）。lineId（b1、l1…）每個 Page 各自編號，
 * 所以要連同 Page 身分（PageView.pageHash）一起才認得出是哪一句。
 */
export interface LineRef {
  pageHash: string;
  lineId: string;
}

/**
 * Page 上一句的外框（Page 座標）：外圈畫在這裡。Balloon 是泡泡外框（balloonBbox），Loose Text 是文字框（bbox）。
 * order：閱讀順序，外圈的明暗照它錯開。
 */
export interface LineBox {
  id: string;
  kind: 'balloon' | 'loose';
  box: RatioRect;
  order: number;
}

/** 一個 Page 上要畫的外圈：translating＝實線、原地淡入淡出（#285）；waiting＝虛線流動（#283）。 */
export interface PageOutlines extends PageOnAnchor {
  subRect?: RatioRect;
  translating: LineBox[];
  waiting: LineBox[];
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

export type GuessSeriesResponse = { output: SeriesGuessOutput } | { error: string };

export type TestConnectionResponse = { ok: true; model: string } | { ok: false; error: string };

export interface StatusResponse {
  active: boolean;
}

export interface CapturePreparedResponse {
  /** false：等不到重繪，頁面沒在產生新畫面，截到的會是舊 frame（#197）。 */
  painted: boolean;
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
  /** 目前 Series 的 Series Notes 條目數（作品卡的「N 個條目」）。 */
  notesCount?: number;
  /** 為什麼歸到目前這部（#186，作品卡的「為什麼歸到這部」）；manual＝讀者在 side panel 選的。 */
  assignment?: { by: 'urlPattern' | 'title' | 'created' | 'unnamed' | 'manual'; originalTitle?: string };
}

/** 沒啟動（沒有 Series）時 seriesId 是 undefined、列表是空的。 */
export interface NotesResponse {
  seriesId: string | undefined;
  entries: NotesEntry[];
  /** 已去重、沒忽略、跟目前譯文不同的建議修改。 */
  suggestions: NotesSuggestion[];
  /** 不記的詞的原文（#214）。 */
  excluded: string[];
}

export type ImportResponse = { ok: true } | { ok: false; error: string };

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
  /**
   * 直式排版的一串（#282：上下緊貼、同寬、同 x、在同一個捲動範圍裡的 img／canvas）裡的一個才有。
   * 這種候選一律有 visible（自己看得到的那一截），辨識時以整串看得到的範圍為單位，跨元素交界的框照常收。
   */
  column?: ColumnView;
}

/** 直式排版的一串在這次量測時的樣子（content/page-candidates.ts 的 columnRegion）。 */
export interface ColumnView {
  /** 這一串的 id：同一個捲動範圍、同一欄就是同一個；重新整理後重編。 */
  id: string;
  /** 這一串看得到的元素合起來的範圍（畫面 CSS px）。 */
  region: Rect;
  /** region 的上緣／下緣是被可見範圍切掉的（外面還有這一串的內容）。 */
  cutTop: boolean;
  cutBottom: boolean;
}

/**
 * 一串裡上下兩個元素的交界在截圖上的樣子（shared/strip.ts 的 junctionVerdict）：continuous＝兩邊的像素接得起來、
 * 而且不是空白，是同一張圖被切開（Strip）；break＝接不起來（真的頁）；blank＝兩邊都是空白，看不出來。
 */
export type JunctionVerdict = 'continuous' | 'break' | 'blank';

export interface PageCandidatesResponse {
  /** 量 rect 當下的 viewport（CSS px），裁切時用來換算截圖倍率。 */
  viewport: Size;
  candidates: PageCandidate[];
}

export interface CropRequest extends PageCandidatesResponse {
  /** captureVisibleTab 的 data URL。 */
  screenshot: string;
  /** 截圖前畫的 frame 記號：offscreen 用它判斷截到的是不是準備好之後的 frame，並在裁切前蓋掉它。 */
  frameMark: FrameMark;
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
  /** 直式排版的一串裡、跟上面那個元素的交界出現在截圖上時才有：這個交界看起來是哪一種（#282）。 */
  junctionAbove?: JunctionVerdict;
}

/** frame：截圖是不是準備好之後的（shared/frame-mark.ts）；不是 fresh 時 pages 照樣算，由 SW 決定要不要重截。 */
export type CropResponse = { pages: PageThumb[]; frame: FrameVerdict } | { error: string };

/**
 * 狀態列顯示的翻譯資訊（spec #27 第 8 節）：「已翻譯」或「快取」・模型・秒數・費用。
 * 快取（#33）時是當初翻譯的模型與數字。
 */
export type TranslationInfo = Pick<TranslateOutput, 'model' | 'latencyMs' | 'usage'> & { source: 'translated' | 'cache' };

/**
 * 哪一種額度用完：free＝自己的 Free Pages、monthly＝本月額度；
 * pausedToday＝自己還有免費額度，但今天全站的 Free Pages 已經發完（Daily Free Pages Cap，#241），明天再試。
 */
export type QuotaExhausted = 'free' | 'monthly' | 'pausedToday';

/** side panel 顯示的一個 Page：縮圖＋逐字稿的狀態。 */
export interface PageView extends PageThumb {
  transcript:
    /** 排在佇列裡或正在本機流水線／LLM。 */
    | { state: 'analyzing' }
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
        /** 內建翻譯的額度用完了（不算失敗，#185 的 Page 紅標籤分免費額度與本月額度）。 */
        quotaExhausted?: QuotaExhausted;
        /** 快取的這頁過時了（#38）：只提示，按「重新翻譯」才重翻。 */
        stale?: StaleReason;
      }
    | { state: 'error'; message: string };
  /** 已經送出翻譯、譯文還沒回來的句子（#285）；沒有時省略。 */
  translatingLines?: LineBox[];
  /** 長 Page、直式排版的一串：被可見範圍的上緣或下緣切到、先不收的框（#283）；沒有時省略。 */
  waitingLines?: LineBox[];
}

export interface PagesResponse {
  pages: PageView[];
  strip?: StripStatus;
}

/**
 * 這個 tab 正在讀的是 Strip（條漫，#282）、而且用的是 Hosted Translation 時才有：side panel 說明計費方式改了，
 * 並顯示這一話（同一串元素）到目前計了幾頁、幾句。
 */
export interface StripStatus {
  lines: number;
  pages: number;
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
  /** 截圖裡的 frame 記號，裁切前蓋掉（CropRequest.frameMark）。 */
  frameMark: FrameMark;
  viewport: Size;
  candidate: PageCandidate;
  /** Page 在候選裡的範圍（PageThumb.subRect）；省略＝整個候選。 */
  subRect?: RatioRect;
  /** 長 Page（candidate.visible）才有：已收 Line 的外框（Page 座標），這一截裡跟它們重疊的框不做 OCR。 */
  collected?: RatioRect[];
  /**
   * 直式排版的一串裡的一個 Page（#282）才有：candidate.visible 是整串看得到的範圍，只收中心落在這個 Page 裡的框。
   * previous：同一串上一次的截圖，被可見範圍邊緣切到的框用兩次截圖拼接後辨識；沒有上一次、或兩次接不起來時省略。
   */
  column?: { cutTop: boolean; cutBottom: boolean; previous?: PreviousCapture };
  /** 這頁 Series 的 Notes 條目原文：OCR 讀成形近字的名字換回來（#228）。Series 還在猜時沒有。 */
  notesNames?: string[];
  /** e2e build 才會帶。 */
  pipeline?: PipelineConfig;
}

/** 同一串上一次的截圖（AnalyzeRequest.column.previous）。 */
export interface PreviousCapture {
  screenshot: string;
  frameMark: FrameMark;
  viewport: Size;
  /** 那次整串看得到的範圍（那張截圖的 CSS px）與上下緣是不是被切的。 */
  region: Rect;
  cutTop: boolean;
  cutBottom: boolean;
  /** 同樣的內容在那張截圖裡的 y 比這次多多少 CSS px（讀者往下捲了多少；往上捲是負的）。 */
  dy: number;
}

/** waiting：長 Page 的這一截裡被可見範圍邊緣切到、先不收的框（Page 座標，#283）；沒有時省略。 */
export type AnalyzeResponse = { text: PageText; waiting?: LineBox[] } | { error: string };
/** 跟 texts 同順序。 */
export type KuromojiReadingsResponse = { readings: string[] } | { error: string };

/**
 * idle＝沒載入、也不確定在不在快取（SW 回答時會查快取，齊全就回 downloaded）；downloaded＝已在快取、還沒載入（#169 預先下載）；
 * ready＝已載入記憶體。
 */
export type ModelStatus =
  | { state: 'idle' }
  | { state: 'downloaded' }
  | { state: 'loading' }
  | { state: 'downloading'; loaded: number; total: number }
  | { state: 'ready'; executionProvider: ExecutionProvider; threads: number }
  | { state: 'error'; message: string };

export interface ModelStatusResponse {
  status: ModelStatus;
  /** 會下載的那一組模型的總 bytes（WebGPU 約 472 MB、wasm 約 128 MB），onboarding 第 1 步顯示。還問不到這台電腦用哪一組時沒有（#221）。 */
  downloadBytes?: number;
}
