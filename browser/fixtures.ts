/**
 * 用 launchPersistentContext＋--load-extension 載入 dist/e2e（spec #27 第 12 節）。
 * 用 Playwright 內建的 Chromium（channel: 'chromium'），新版一般 Chrome 已不接受 --load-extension。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';
import type { Message, PagesResponse, PipelineConfig, TestConfig } from '../src/shared/messages.ts';
import { startMockSite, type MockSite } from './mock-site/server.ts';

const EXTENSION_DIR = fileURLToPath(new URL('../dist/e2e', import.meta.url));

/**
 * Windows 上 Chromium 的密碼管理器會用空密碼呼叫 LogonUser，檢查 OS 密碼是不是空的，結果快取在 Local State。
 * 全新設定檔沒有快取，每開一次就記一次登入失敗；e2e 一次開很多個，10 分鐘內滿 10 次就把 Windows 帳號鎖住。
 * 先寫好「不是空密碼、最後變更時間在很久以後」，Chromium 就直接用快取（password_manager_util_win.cc）。
 * 已有 Local State 就不動（重開瀏覽器的設定檔裡已經有 Chromium 自己的快取）。
 */
async function seedLocalState(userDataDir: string): Promise<void> {
  const localState = { password_manager: { os_password_blank: false, os_password_last_changed: '9223372036854775807' } };
  await writeFile(join(userDataDir, 'Local State'), JSON.stringify(localState), { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e;
  });
}

/**
 * userDataDir 給 '' 是每次全新的暫存設定檔（關閉時刪掉）；給同一個目錄就能模擬「重開瀏覽器」。
 * extensionDir 預設是 dist/e2e；smoke test 也用它載入正式 build。
 */
export async function launchWithExtension(
  userDataDir: string,
  realDeviceScaleFactor?: number,
  extensionDir = EXTENSION_DIR,
  scrollbars = false,
): Promise<BrowserContext> {
  const temporary = userDataDir === '';
  if (temporary) userDataDir = await mkdtemp(join(tmpdir(), 'manga-e2e-'));
  await seedLocalState(userDataDir);
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    // headless 預設 --hide-scrollbars：捲軸不占寬度。量「捲軸出現把版面擠窄」的測試要真的捲軸
    ...(scrollbars ? { ignoreDefaultArgs: ['--hide-scrollbars'] } : {}),
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      // 真的視窗大小。用 test.use({ viewport: null }) 的測試靠它；其他測試的 viewport 是模擬的，不受影響。
      '--window-size=1280,1500',
      ...(realDeviceScaleFactor === undefined ? [] : [`--force-device-scale-factor=${realDeviceScaleFactor}`]),
    ],
  });
  // Windows 上瀏覽器剛關時 lockfile 可能還被占用
  if (temporary) context.on('close', () => void rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {}));
  return context;
}

/**
 * 測試的本機流水線設定：模型從 mock site 下載、強制 wasm；Playwright 平行開好幾個瀏覽器，
 * 每個都開滿執行緒會互搶 CPU，讓不相干的測試（截圖、縮圖）逾時，所以限 2 條（仍可驗證多執行緒有開）。
 * fakeOcr：browser test 用 FakeEngine 取代模型（ADR 0007）。
 */
export const E2E_PIPELINE = (site: MockSite, fakeOcr = false, fakeOcrDelayMs = 0): PipelineConfig => ({
  modelBaseUrl: site.modelBaseUrl,
  executionProvider: 'wasm',
  maxThreads: 2,
  fakeOcr,
  fakeOcrDelayMs,
});

/**
 * 取得 SW 並在建立任何 Page 之前設定：模型從 mock site 下載（內容是 repo 外的模型快取）、強制 wasm
 * （spec 第 12 節：自動測試預設跑 wasm），需要時改用 FakeTranslator。
 */
export async function configuredServiceWorker(
  context: BrowserContext,
  site: MockSite,
  fakeTranslator = false,
  translatorOptions: Pick<TestConfig, 'requireApiKey' | 'unreadableTexts' | 'fakeNotes' | 'freshInstall'> = {},
  fakeOcr = false,
  fakeOcrDelayMs = 0,
): Promise<Worker> {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const config: TestConfig = { pipeline: E2E_PIPELINE(site, fakeOcr, fakeOcrDelayMs), fakeTranslator, ...translatorOptions };
  await sw.evaluate((config) => globalThis.__configureForTest!(config), config);
  return sw;
}

/** playwright.config.ts／playwright.e2e.config.ts 的 use 設定的選項。 */
export interface TestOptions {
  fakeOcr: boolean;
}

export const test = base.extend<{
  /**
   * 真的 DPR（--force-device-scale-factor）。Playwright 的 deviceScaleFactor 只模擬頁面上的
   * devicePixelRatio，captureVisibleTab 的截圖仍是 1×，而且不能跟 viewport: null 一起用。
   */
  realDeviceScaleFactor: number | undefined;
  /** 捲軸占寬度（拿掉 headless 的 --hide-scrollbars）；預設 false。 */
  scrollbars: boolean;
  /** 用 FakeEngine 取代 OCR 模型（ADR 0007）。browser test 的設定檔設成 true，e2e 與 smoke 用預設的 false。 */
  fakeOcr: boolean;
  /** FakeEngine 每頁故意花的時間：測佇列排程的測試需要 OCR 慢到翻頁時還沒做完。 */
  fakeOcrDelayMs: number;
  /** 用 FakeTranslator（合成頁 ground truth 的讀音與譯文）；預設 false＝沒有 API key。 */
  fakeTranslator: boolean;
  /** 跟正式 build 一樣要先在設定區存 API key 才翻譯；預設 false＝FakeTranslator 不需要 key。 */
  requireApiKey: boolean;
  /** FakeTranslator 當成無法辨識的 ground truth 原文。 */
  unreadableTexts: string[];
  /** FakeTranslator 在 Balloon 裡看到就回傳成新增的 Notes 條目（#37）。 */
  fakeNotes: NonNullable<TestConfig['fakeNotes']>;
  /** 當作全新安裝：預設內建翻譯、SW 打開 onboarding（#93）。預設 false＝自備金鑰、設定已完成（#93 以前的狀態）。 */
  freshInstall: boolean;
  context: BrowserContext;
  sw: Worker;
  extensionId: string;
  mockSite: MockSite;
}>({
  realDeviceScaleFactor: [undefined, { option: true }],
  scrollbars: [false, { option: true }],
  context: async ({ realDeviceScaleFactor, scrollbars }, use) => {
    const context = await launchWithExtension('', realDeviceScaleFactor, undefined, scrollbars);
    await use(context);
    await context.close();
  },
  fakeOcr: [false, { option: true }],
  fakeOcrDelayMs: [0, { option: true }],
  fakeTranslator: [false, { option: true }],
  requireApiKey: [false, { option: true }],
  unreadableTexts: [[], { option: true }],
  fakeNotes: [[], { option: true }],
  freshInstall: [false, { option: true }],
  sw: async ({ context, mockSite, fakeOcr, fakeOcrDelayMs, fakeTranslator, requireApiKey, unreadableTexts, fakeNotes, freshInstall }, use) => {
    await use(
      await configuredServiceWorker(context, mockSite, fakeTranslator, { requireApiKey, unreadableTexts, fakeNotes, freshInstall }, fakeOcr, fakeOcrDelayMs),
    );
  },
  extensionId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host);
  },
  mockSite: async ({}, use) => {
    const site = await startMockSite();
    await use(site);
    await site.close();
  },
});

export const expect = test.expect;

/** 打開仿 canvas 網站並等全部 canvas 畫完。url：同網站的另一個網址（預設 site.canvasSiteUrl）。 */
export async function openMockSite(context: BrowserContext, site: MockSite, url = site.canvasSiteUrl): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url);
  await page.locator('body[data-ready="true"]').waitFor();
  return page;
}

export async function tabIdOf(sw: Worker, url: string): Promise<number> {
  const id = await sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id, url);
  if (id === undefined) throw new Error(`no tab with url ${url}`);
  return id;
}

/**
 * 把 side panel 當一般分頁打開。給 tabId 就等同點圖示後打開的 tab 專屬 panel；
 * 不給就等同從 Chrome 內建 side panel 選單打開。
 * 開在自己的視窗：跟頁面同一個視窗的話，頁面切回前景後 panel 是背景分頁，rAF 停掉，
 * Playwright 每次 click 等元素穩定都要約 2 秒。真的 side panel 也跟頁面同時可見。
 */
export async function openSidePanel(context: BrowserContext, extensionId: string, tabId?: number): Promise<Page> {
  const query = tabId === undefined ? '' : `?tabId=${tabId}`;
  const url = `chrome-extension://${extensionId}/sidepanel.html${query}`;
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const [panel] = await Promise.all([
    context.waitForEvent('page'),
    sw.evaluate((url) => chrome.windows.create({ url, focused: false }), url),
  ]);
  await panel.waitForURL(url);
  return panel;
}

/** e2e 測試入口：等同點外掛圖示，SW 會呼叫同一個 activate(tabId)。 */
export async function testActivate(fromExtensionPage: Page, tabId: number): Promise<void> {
  await fromExtensionPage.evaluate(
    (message) => chrome.runtime.sendMessage(message),
    { type: 'test:activate', tabId } satisfies Message,
  );
}

/** 按頂部的 ⚙ 打開設定頁（整個取代 side panel）。 */
export async function openSettings(panel: Page): Promise<void> {
  await panel.getByRole('button', { name: '設定', exact: true }).click();
  await expect(panel.getByRole('region', { name: '設定' })).toBeVisible();
}

/**
 * 在設定頁選翻譯方式。radio 是 controlled：寫進 chrome.storage、watch 回來才勾上，中間 side panel 重新 render
 * （例如畫面上的頁正在辨識）會先把它改回去，所以不用 check()（點完立刻要看到勾上），改成點了等它勾上。
 */
export async function selectTranslationMode(panel: Page, name: '內建翻譯' | '自備金鑰'): Promise<void> {
  const radio = panel.getByRole('region', { name: '設定' }).getByRole('radio', { name });
  await radio.click();
  await expect(radio).toBeChecked();
}

/** e2e 測試入口：等同已啟動時再點一次外掛圖示（停止），但不關掉測試開的 side panel 視窗。 */
export async function testStop(fromExtensionPage: Page, tabId: number): Promise<void> {
  await fromExtensionPage.evaluate((message) => chrome.runtime.sendMessage(message), { type: 'test:stop', tabId } satisfies Message);
}

/**
 * 畫面上的每一頁都單頁重翻（同過時提示的「重新翻譯」送的訊息）。翻好的頁已經沒有常駐的重翻按鈕，
 * 測試要讓已翻好的頁再走一次 Translator（帶新的 Notes、換了翻譯方式）時用。
 */
export async function retranslateVisible(fromExtensionPage: Page, tabId: number): Promise<void> {
  await fromExtensionPage.evaluate(async (tabId) => {
    const { pages } = (await chrome.runtime.sendMessage({ type: 'panel:getPages', tabId })) as PagesResponse;
    await Promise.all(pages.map((p) => chrome.runtime.sendMessage({ type: 'panel:translate', tabId, pageHash: p.pageHash })));
  }, tabId);
}

/** 叫 SW 重新擷取畫面上的 Page（翻頁偵測、模型錯誤的「重試」走的同一條路）；畫面上已經沒有按鈕。 */
export async function rescan(fromExtensionPage: Page, tabId: number): Promise<void> {
  await fromExtensionPage.evaluate((message) => chrome.runtime.sendMessage(message), { type: 'panel:scan', tabId } satisfies Message);
}

/**
 * 打開仿 canvas 網站與它的 side panel，透過測試入口啟動，等 panel 顯示「已啟動」。
 * 啟動前把仿 canvas 網站切到前景，跟真的點圖示時一樣是它視窗裡的作用中 tab，captureVisibleTab 才截得到它
 * （同一個測試開第二個仿 canvas 網站時，兩個在同一個視窗）。
 */
export async function activateOnMockSite(
  {
    context,
    sw,
    extensionId,
    mockSite,
    url = mockSite.canvasSiteUrl,
    beforeActivate,
  }: {
    context: BrowserContext;
    sw: Worker;
    extensionId: string;
    mockSite: MockSite;
    /** 仿 canvas 網站的網址（預設 mockSite.canvasSiteUrl；翻頁版用 mockSite.canvasSitePagedUrl）。 */
    url?: string;
    /** side panel 打開後、啟動前（例如在 panel 裡掛 listener、改頁面標題）。 */
    beforeActivate?: (panel: Page, page: Page) => Promise<void>;
  },
): Promise<{ page: Page; panel: Page; tabId: number }> {
  const page = await openMockSite(context, mockSite, url);
  const tabId = await tabIdOf(sw, url);
  const panel = await openSidePanel(context, extensionId, tabId);
  await beforeActivate?.(panel, page);
  await page.bringToFront();
  await testActivate(panel, tabId);
  await expect(panel.getByText('已啟動')).toBeVisible();
  return { page, panel, tabId };
}

/** 在 content script 的 isolated world 裡看它在不在。 */
export async function isContentScriptInjected(sw: Worker, tabId: number): Promise<boolean> {
  return sw.evaluate(async (tabId) => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__naruhodo?.active === true,
    });
    return result?.result === true;
  }, tabId);
}

/** 在 SW 裡直接讀外掛的 IndexedDB（只讀，不經過外掛的程式）。 */
/** 送進 LLM（FakeTranslator）的每一句原文，也就是 OCR 讀到的字。 */
export function sentOriginals(sw: Worker): Promise<string[]> {
  return sw.evaluate(() => (globalThis.__translateInputs ?? []).flatMap((input) => input.items.map((item) => item.原文)));
}

export function readStore<T>(sw: Worker, store: string): Promise<T[]> {
  return sw.evaluate(
    (store) =>
      new Promise<T[]>((resolve, reject) => {
        const open = indexedDB.open('naruhodo');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const request = open.result.transaction(store).objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result as T[]);
          request.onerror = () => reject(request.error);
        };
      }),
    store,
  );
}
