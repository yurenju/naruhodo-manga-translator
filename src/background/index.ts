import { CLAUDE_MODEL, PROMPT_VERSION } from '../shared/claude-request.ts';
import { indexedDbApiKeyStore } from '../shared/api-key-store.ts';
import { hasDataConsent, watchDataConsent } from '../shared/data-consent.ts';
import { FAKE_VERSION } from '../shared/fake-translator.ts';
import { clearHostedSession, HOSTED_API_URL, hostedSessionToken } from '../shared/hosted-session.ts';
import type {
  AnalyzeResponse,
  AutoTranslateResponse,
  CaptureFinishedResponse,
  CropResponse,
  FakeTranslatorConfig,
  ImportResponse,
  Message,
  ModelStatus,
  ModelStatusResponse,
  NotesResponse,
  PageCandidatesResponse,
  PagesResponse,
  PipelineConfig,
  SeriesResponse,
  StatusResponse,
  TestConfig,
  TestConnectionResponse,
  TranslateResponse,
  ProposeNotesResponse,
} from '../shared/messages.ts';
import { acceptSuggestion, editEntry, ignoreSuggestion, pendingSuggestions, type SeriesNotes, type TranslatorVersion } from '../shared/series-notes.ts';
import { onboardingUrl, saveInstallState } from '../shared/onboarding.ts';
import { createTrace } from '../shared/trace.ts';
import { isTranslationModeSet, loadTranslationMode, saveTranslationMode, watchTranslationMode } from '../shared/translation-mode.ts';
import type { NotesInput, TranslateInput, Translator } from '../shared/translator.ts';
import { createActivation } from './activation.ts';
import { BACKUP_KEYS, createBackup } from './backup.ts';
import { indexedDbPageCache } from './cache-store.ts';
import { createHostedTranslator } from './hosted-translator.ts';
import { installPlan } from './install.ts';
import { ensureOffscreenDocument } from './offscreen.ts';
import { createOverlaySync } from './overlay-sync.ts';
import { createScanner } from './scan.ts';
import { createSeriesCatalog } from './series-catalog.ts';
import { indexedDbBackupRepo, indexedDbNotesStore, indexedDbSeriesRepo } from './series-store.ts';
import { indexedDbTabStore } from './tab-store.ts';
import { createTranscriber } from './transcribe.ts';

declare global {
  /** e2e build 才有：每次 captureVisibleTab 開始的時間，給測試數截了幾次、等截圖停下來。 */
  var __captureLog: number[] | undefined;
  /** e2e build 才有：最近 3 張截好的圖（data URL）與開始截的時間，給測試確認截圖裡沒有覆蓋層。 */
  var __captures: { startedAt: number; screenshot: string }[] | undefined;
  /** e2e build 才有：在建立任何 Page 之前呼叫（browser/fixtures.ts）。 */
  var __configureForTest: ((config: TestConfig) => void) | undefined;
  /** e2e build 才有：FakeTranslator 被呼叫的次數（確認命中快取時沒有翻譯）。 */
  var __translateCalls: number | undefined;
  /** e2e build 才有：每次送給 FakeTranslator 的內容（#37：確認前一頁新增的條目有送出）。 */
  var __translateInputs: TranslateInput[] | undefined;
  /** e2e build 才有：每次送給 FakeTranslator 整理 Notes（②）的內容。 */
  var __notesInputs: NotesInput[] | undefined;
  /** e2e build 才有：記下過幾個 Page「帶覆蓋層的樣子」（scan.ts），給測試等它做完。 */
  var __overlaidRecords: number | undefined;
}

const trace = createTrace('sw');
const store = indexedDbTabStore();

// 瀏覽器重開後 tab id 會重新編號，上一次的啟動狀態都不算數。
chrome.runtime.onStartup.addListener(() => {
  void store.clear();
});

/** side panel 沒開時沒有接收者，sendMessage 會 reject，忽略即可。 */
function notifyPanel(message: Message): void {
  chrome.runtime.sendMessage(message).catch(() => {});
}

const scanner = createScanner({
  findPageCandidates: (tabId) =>
    chrome.tabs.sendMessage<Message, PageCandidatesResponse>(tabId, { type: 'content:findPageCandidates' }),
  async getVisibleWindowId(tabId) {
    const tab = await chrome.tabs.get(tabId);
    return tab.active ? tab.windowId : undefined;
  },
  async prepareCapture(tabId, hideOverlay) {
    await chrome.tabs.sendMessage(tabId, { type: 'content:prepareCapture', hideOverlay } satisfies Message);
  },
  finishCapture: (tabId) => chrome.tabs.sendMessage<Message, CaptureFinishedResponse>(tabId, { type: 'content:finishCapture' }),
  async captureWindow(windowId) {
    if (__E2E__) (globalThis.__captureLog ??= []).push(Date.now());
    const startedAt = Date.now();
    const screenshot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    if (__E2E__) globalThis.__captures = [...(globalThis.__captures ?? []), { startedAt, screenshot }].slice(-3);
    trace('capture', { windowId, ms: Date.now() - startedAt, screenshot });
    return screenshot;
  },
  async crop(request) {
    await ensureOffscreenDocument();
    const startedAt = Date.now();
    const response = await chrome.runtime.sendMessage<Message, CropResponse>({ type: 'offscreen:crop', ...request });
    if ('error' in response) throw new Error(`crop failed: ${response.error}`);
    trace('crop', { ms: Date.now() - startedAt, pages: response.pages });
    return response.pages;
  },
  publish(tabId, pages, capture) {
    // 沒有 capture＝畫面上沒有完整可見的 Page（或停止）；停止時的清理在 onStatusChanged
    // 先讓 overlaySync 知道哪些覆蓋已經不在了（換 src），transcriber 接著 publish 時才會重送
    overlaySync.captured(tabId, pages);
    void transcriber.update(tabId, pages, capture);
  },
});

/** e2e build 才會改（test:configure）。 */
let pipelineConfig: PipelineConfig = {};
/** e2e build 才會設：offscreen 用 FakeTranslator 取代 Claude。 */
let fakeTranslator: FakeTranslatorConfig | undefined;
/** e2e build：false＝FakeTranslator 不需要 API key（#30 起的 e2e 預設）。 */
let requireApiKey = true;

const apiKeys = indexedDbApiKeyStore();

/** SW 不讀 key：翻譯在 offscreen document 裡做，offscreen 自己從 IndexedDB 讀 key（spec #27 第 5 節）。 */
const offscreenTranslator: Translator = {
  async translatePage(input) {
    // e2e：FakeTranslator 在 offscreen，這裡記呼叫次數（確認命中快取時沒有翻譯，#33）
    if (__E2E__ && fakeTranslator) {
      globalThis.__translateCalls = (globalThis.__translateCalls ?? 0) + 1;
      (globalThis.__translateInputs ??= []).push(input);
    }
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage<Message, TranslateResponse>({
      type: 'offscreen:translate',
      input,
      ...(__E2E__ && fakeTranslator ? { fake: fakeTranslator } : {}),
    });
    if ('error' in response) throw new Error(response.error);
    return response.output;
  },
  async proposeNotes(input) {
    if (__E2E__ && fakeTranslator) (globalThis.__notesInputs ??= []).push(input);
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage<Message, ProposeNotesResponse>({
      type: 'offscreen:proposeNotes',
      input,
      ...(__E2E__ && fakeTranslator ? { fake: fakeTranslator } : {}),
    });
    if ('error' in response) throw new Error(response.error);
    return response.output;
  },
};

/**
 * Hosted Translation：SW 直接 fetch Worker；沒有 session token（還沒登入）就不能翻。
 * Worker 說 token 已失效（撤銷或閒置太久）：清掉它，side panel 回到「尚未登入」。
 * 翻譯扣了一頁、或 Worker 說額度用完：通知 side panel 重新讀剩餘頁數。
 */
async function hostedTranslator(): Promise<Translator | undefined> {
  const token = await hostedSessionToken();
  if (!token) return undefined;
  const onSignedOut = () => void clearHostedSession().then(() => notifyPanel({ type: 'session:changed' }));
  const onQuotaChanged = () => notifyPanel({ type: 'quota:changed' });
  return createHostedTranslator({
    apiUrl: HOSTED_API_URL,
    token,
    fetch: (url, init) => fetch(url, init),
    sleep,
    now: () => performance.now(),
    onSignedOut,
    onQuotaChanged,
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

/**
 * 依翻譯模式（shared/translation-mode.ts）決定能不能翻：Hosted Translation 要已登入，Own API Key 要有 key（spec 第 5 節）；
 * 兩者都要同意資料使用（shared/data-consent.ts）。不符合就不排 LLM 工作，只顯示原文與讀音。
 * 翻譯與 Series Notes 都從這裡拿 Translator，所以送出文字的呼叫都會先過這道檢查。
 */
async function getTranslator(): Promise<Translator | undefined> {
  if (__E2E__ && fakeTranslator && !requireApiKey) return offscreenTranslator;
  const mode = await loadTranslationMode();
  // 同意依模式各自記：自備金鑰的同意不代表同意把文字送到 Naruhodo 的服務，反之亦然
  if (!(await hasDataConsent(mode))) return undefined;
  if (mode === 'hosted') return hostedTranslator();
  return (await apiKeys.has()) ? offscreenTranslator : undefined;
}

/** 目前會用來翻譯的模型與 prompt 版本（過時提示比對用）；沒有 key 時不比。 */
async function translatorVersion(): Promise<TranslatorVersion | undefined> {
  if (!(await getTranslator())) return undefined;
  return __E2E__ && fakeTranslator ? FAKE_VERSION : { model: CLAUDE_MODEL, promptVersion: PROMPT_VERSION };
}

const notesStore = indexedDbNotesStore();
const seriesRepo = indexedDbSeriesRepo();

const transcriber = createTranscriber({
  async analyze(request) {
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage<Message, AnalyzeResponse>({
      type: 'offscreen:analyze',
      ...request,
      ...(__E2E__ ? { pipeline: pipelineConfig } : {}),
    });
    if ('error' in response) throw new Error(response.error);
    return response.text;
  },
  getTranslator,
  translatorVersion,
  getSeriesId: (tabId) => activation.getSeriesId(tabId),
  getSeries: (seriesId) => seriesRepo.getSeries(seriesId),
  cache: indexedDbPageCache(),
  notes: {
    ...notesStore,
    // 背景整理 Notes（②）套用了 notes_changes 或人改了：side panel 的 Series Notes 區塊重新讀
    async save(seriesId, notes) {
      await notesStore.save(seriesId, notes);
      notifyPanel({ type: 'notes:changed', seriesId });
    },
  },
  publish(tabId, pages) {
    notifyPanel({ type: 'pages:updated', tabId, pages });
    overlaySync.publish(tabId, pages);
  },
  onJobEvent(event) {
    trace('job', { ...event });
  },
});

/**
 * 能不能翻譯變了（同意、切換翻譯模式、登入，#93）：已啟動的分頁直接翻還沒翻譯的頁，不必再按「翻譯此頁」。
 * 同意與模式在 chrome.storage（onboarding 頁、side panel 都會寫）；登入存在 IndexedDB，由登入的一方廣播 session:changed。
 */
const accessChanged = () => void transcriber.translateUntranslated().catch((e: unknown) => console.warn('translate after access change failed', e));
watchDataConsent(accessChanged);
watchTranslationMode(accessChanged);

/**
 * 安裝與更新（#93）：依 background/install.ts 決定翻譯模式與 onboarding，全新安裝時用新分頁打開 onboarding。
 * listener 要在 SW 一啟動就註冊才收得到事件。e2e build 不自動處理：每個 browser test 都是全新安裝，
 * 只有要測 onboarding 的測試用 freshInstall 叫它處理（test:configure）。
 */
const installed = new Promise<`${chrome.runtime.OnInstalledReason}`>((resolve) => chrome.runtime.onInstalled.addListener(({ reason }) => resolve(reason)));

async function handleInstalled(reason: `${chrome.runtime.OnInstalledReason}`): Promise<void> {
  const [hasKey, migrated] = await Promise.all([apiKeys.has(), isTranslationModeSet()]);
  const plan = installPlan({ reason, hasKey, migrated });
  trace('installed', { reason, hasKey, migrated, plan });
  if (!plan) return;
  await Promise.all([saveTranslationMode(plan.translationMode), saveInstallState(plan)]);
  if (plan.openOnboarding) await chrome.tabs.create({ url: onboardingUrl() });
}

if (!__E2E__) void installed.then(handleInstalled);

const overlaySync = createOverlaySync({
  show({ tabId, anchorId, pageHash, subRect, text }) {
    const message: Message = { type: 'content:showOverlay', anchorId, pageHash, subRect, text };
    chrome.tabs.sendMessage(tabId, message).catch(() => {});
  },
});

let modelStatus: ModelStatus = { state: 'idle' };

if (__E2E__) {
  globalThis.__configureForTest = (config) => {
    pipelineConfig = config.pipeline;
    globalThis.__translateCalls = 0;
    globalThis.__translateInputs = [];
    globalThis.__notesInputs = [];
    fakeTranslator = config.fakeTranslator ? { unreadableTexts: config.unreadableTexts ?? [], notes: config.fakeNotes ?? [] } : undefined;
    requireApiKey = config.requireApiKey ?? false;
    if (config.freshInstall) void installed.then(handleInstalled);
  };
}

/** 頁面可能剛好換頁、content script 不在，或截圖失敗；這次掃描就放棄，等下一次觸發。 */
function scan(tabId: number): void {
  trace('scan', { tabId });
  scanner.scan(tabId).catch((e: unknown) => console.warn('scan failed', e));
}

const backupRepo = indexedDbBackupRepo();
const backup = createBackup({ repo: backupRepo, updateNotes: (seriesId, change) => transcriber.updateNotes(seriesId, change), now: () => Date.now() });

async function notesResponse(tabId: number): Promise<NotesResponse> {
  const seriesId = await activation.getSeriesId(tabId);
  if (seriesId === undefined) return { seriesId, entries: [], suggestions: [] };
  const notes = await notesStore.load(seriesId);
  return { seriesId, entries: notes.entries, suggestions: pendingSuggestions(notes) };
}

/** side panel 改這個 tab 目前 Series 的 Notes（#38）。沒啟動就不動。action＋detail 記進 trace（#40 驗收）。 */
async function changeNotes(tabId: number, action: string, detail: Record<string, unknown>, change: (notes: SeriesNotes) => SeriesNotes): Promise<void> {
  const seriesId = await activation.getSeriesId(tabId);
  if (seriesId === undefined) return;
  await transcriber.updateNotes(seriesId, change);
  trace(action, { tabId, seriesId, ...detail });
}

const seriesCatalog = createSeriesCatalog({ repo: seriesRepo, now: () => new Date(), newId: () => crypto.randomUUID() });

async function seriesResponse(tabId: number): Promise<SeriesResponse> {
  const [current, options] = await Promise.all([activation.getSeriesId(tabId), seriesCatalog.menu()]);
  return { current, options };
}

/** 這個 tab 的 Series 操作（#36）共用的部分：算出新的 Series ID、記下來、通知 panel。回傳新的 ID；沒變（或沒啟動）是 undefined。 */
async function applySeriesChange(
  tabId: number,
  action: string,
  change: (url: string, current: string) => Promise<string>,
): Promise<string | undefined> {
  const [url, current] = await Promise.all([chrome.tabs.get(tabId).then((t) => t.url), activation.getSeriesId(tabId)]);
  if (url === undefined || current === undefined) return undefined;
  const next = await change(url, current);
  // 記住了哪個網址模式記在 series:remember，合併搬了什麼記在 series:merge
  trace(action, { tabId, from: current, seriesId: next });
  await activation.setSeriesId(tabId, next);
  notifyPanel({ type: 'series:changed', tabId });
  return next === current ? undefined : next;
}

/**
 * 選一部（或新增）Series：換成另一個 ID 就重新擷取，快取查詢與翻譯改用新的 ID。
 * #34 的 transcriber 以 pageHash 記住看過的 Page；不先忘掉的話重新擷取會沿用舊 ID 的結果。
 */
async function switchSeries(tabId: number, action: string, choose: (url: string) => Promise<string>): Promise<void> {
  if ((await applySeriesChange(tabId, action, choose)) === undefined) return;
  transcriber.resetPages(tabId);
  scan(tabId);
}

/** 改名（ID 不變）或合併（快取已改到目標 ID、不自動重翻）：不重新擷取，畫面上的 Page 改記在新的 ID 下。 */
async function updateSeries(tabId: number, action: string, change: (url: string, current: string) => Promise<string>): Promise<void> {
  const next = await applySeriesChange(tabId, action, change);
  if (next !== undefined) transcriber.reassignSeries(tabId, next);
}

const activation = createActivation({
  store,
  seriesForUrl: (url) => seriesCatalog.seriesForUrl(url),
  rememberedSeries: (url) => seriesCatalog.rememberedSeries(url),
  onSeriesChanged(tabId) {
    // 跟 side panel 切換 Series 一樣：忘掉畫面上的 Page 重新擷取；Prior Pages 在 Series 換了時自己清空
    notifyPanel({ type: 'series:changed', tabId });
    transcriber.resetPages(tabId);
    scan(tabId);
  },
  getTabUrl: async (tabId) => (await chrome.tabs.get(tabId)).url,
  openSidePanel(tabId) {
    // 不 await setOptions：await 會讓 open() 離開 user gesture。兩個呼叫會依序送到瀏覽器。
    // 用 tab 專屬的路徑帶上 tabId；從 Chrome 內建選單打開的是沒有 tabId 的全域 side panel。
    chrome.sidePanel
      .setOptions({ tabId, path: `sidepanel.html?tabId=${tabId}`, enabled: true })
      .catch((e: unknown) => console.warn('sidePanel.setOptions failed', e));
    return chrome.sidePanel.open({ tabId });
  },
  async injectContentScript(tabId) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  },
  async stopContentScript(tabId) {
    await chrome.tabs.sendMessage(tabId, { type: 'content:stop' } satisfies Message);
  },
  onStatusChanged(tabId, active) {
    trace('status', { tabId, active });
    notifyPanel({ type: 'status:changed', tabId, active });
    if (active) scan(tabId);
    else {
      scanner.clear(tabId);
      transcriber.clear(tabId);
    }
  },
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) void activation.activate(tab.id);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'activate' && tab?.id !== undefined) void activation.activate(tab.id);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // 重新整理或換頁：anchor 都換了，重新查快取（同 origin 會重新注入、繼續啟動）
  if (changeInfo.status === 'loading') transcriber.resetPages(tabId);
  void activation.handleTabUpdated(tabId, changeInfo);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void activation.handleTabRemoved(tabId);
  scanner.clear(tabId);
  transcriber.clear(tabId);
});

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  // __E2E__、__DEBUG__ 是 build 時的常數，正式 build 裡這段會被整段移除。
  // debug build 也有：npm run debug:activate 不靠點圖示啟動（#112）。
  if ((__E2E__ || __DEBUG__) && message.type === 'test:activate') {
    activation.activate(message.tabId).then(() => sendResponse());
    return true;
  }
  switch (message.type) {
    case 'models:status':
      modelStatus = message.status;
      return false;
    case 'session:changed':
      accessChanged();
      return false;
    case 'panel:getModelStatus':
      sendResponse({ status: modelStatus } satisfies ModelStatusResponse);
      return false;
    case 'panel:getStatus':
      activation.isActive(message.tabId).then((active) => sendResponse({ active } satisfies StatusResponse));
      return true;
    case 'panel:stop':
      activation.stop(message.tabId).then(() => sendResponse());
      return true;
    case 'content:pageTurn': {
      const tabId = sender.tab?.id;
      if (tabId !== undefined)
        void activation.isActive(tabId).then((active) => {
          if (active) scan(tabId);
        });
      return false;
    }
    case 'content:overlayShown': {
      const tabId = sender.tab?.id;
      if (tabId !== undefined)
        void activation.isActive(tabId).then((active) => {
          if (active) scanner.recordOverlaid(tabId).catch((e: unknown) => console.warn('record overlaid failed', e));
        });
      return false;
    }
    case 'panel:getAutoTranslate':
      sendResponse({ enabled: transcriber.isAutoTranslate(message.tabId) } satisfies AutoTranslateResponse);
      return false;
    case 'panel:setAutoTranslate':
      void transcriber.setAutoTranslate(message.tabId, message.enabled);
      sendResponse();
      return false;
    case 'panel:getPages':
      sendResponse({ pages: transcriber.get(message.tabId) } satisfies PagesResponse);
      return false;
    case 'panel:translate':
      void transcriber.translate(message.tabId, message.pageHash).finally(() => sendResponse());
      return true;
    case 'panel:getNotes':
      notesResponse(message.tabId).then(sendResponse);
      return true;
    case 'panel:editNote': {
      const { 原文, fields } = message;
      changeNotes(message.tabId, 'panel:editNote', { 原文, fields }, (notes) => ({ ...notes, entries: editEntry(notes.entries, 原文, fields) })).then(() =>
        sendResponse(),
      );
      return true;
    }
    case 'panel:acceptSuggestion':
    case 'panel:ignoreSuggestion': {
      const { suggestion } = message;
      const apply = message.type === 'panel:acceptSuggestion' ? acceptSuggestion : ignoreSuggestion;
      const { 原文, 建議譯文 } = suggestion;
      changeNotes(message.tabId, message.type, { 原文, 建議譯文 }, (notes) => apply(notes, suggestion)).then(() => sendResponse());
      return true;
    }
    case 'panel:clearCache':
      // 畫面上已經顯示的頁不動；之後翻回來就重新翻譯
      activation
        .getSeriesId(message.tabId)
        .then(async (seriesId) => {
          if (seriesId === undefined) return;
          await backupRepo.clearTranslations(seriesId);
          trace('panel:clearCache', { tabId: message.tabId, seriesId });
        })
        .then(() => sendResponse());
      return true;
    case 'panel:export':
      backup
        .exportAll()
        .then((file) => {
          // 筆數就夠核對；檔案內容（含真實頁面的原文、譯文）不進 trace
          const counts = Object.fromEntries(BACKUP_KEYS.map((k) => [k, file[k].length]));
          trace('panel:export', { format: file.format, counts, hasApiKeyPrefix: JSON.stringify(file).includes('sk-ant-') });
          return file;
        })
        .then(sendResponse);
      return true;
    case 'panel:import':
      backup
        .importAll(message.data)
        .then((seriesIds): ImportResponse => {
          for (const seriesId of seriesIds) notifyPanel({ type: 'notes:changed', seriesId });
          trace('panel:import', { ok: true, notesSeriesIds: seriesIds });
          return { ok: true };
        })
        .catch((e: unknown): ImportResponse => {
          trace('panel:import', { ok: false, error: e });
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        })
        .then(sendResponse);
      return true;
    case 'panel:testConnection':
      ensureOffscreenDocument()
        .then(() => chrome.runtime.sendMessage<Message, TestConnectionResponse>({ type: 'offscreen:testConnection' }))
        .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }) satisfies TestConnectionResponse)
        .then(sendResponse);
      return true;
    case 'panel:getSeries':
      seriesResponse(message.tabId).then(sendResponse);
      return true;
    case 'panel:selectSeries': {
      const { seriesId } = message;
      switchSeries(message.tabId, 'panel:selectSeries', (url) => seriesCatalog.select(seriesId, url).then(() => seriesId)).then(() => sendResponse());
      return true;
    }
    case 'panel:createSeries': {
      const { name } = message;
      switchSeries(message.tabId, 'panel:createSeries', async (url) => (await seriesCatalog.create(name, url)).id).then(() => sendResponse());
      return true;
    }
    case 'panel:renameSeries': {
      const { name } = message;
      updateSeries(message.tabId, 'panel:renameSeries', (url, current) => seriesCatalog.rename(current, name, url).then(() => current)).then(() =>
        sendResponse(),
      );
      return true;
    }
    case 'panel:mergeSeries': {
      const { targetId } = message;
      // 來源不是 Provisional Series（或目標不在）時 merge 不動，這個 tab 留在原本的 Series
      updateSeries(message.tabId, 'panel:mergeSeries', async (url, current) => ((await seriesCatalog.merge(current, targetId, url)) ? targetId : current)).then(
        () => sendResponse(),
      );
      return true;
    }
    case 'panel:scan':
      activation.isActive(message.tabId).then((active) => {
        if (active) scan(message.tabId);
        sendResponse();
      });
      return true;
  }
  return false;
});
