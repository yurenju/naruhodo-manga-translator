/**
 * 本機段（spec #27 第 3.3、3.4 節）：模型下載／常駐 → 偵測＋OCR＋閱讀順序 → kuromoji 讀音。併發 1。
 * offscreen document 用它；e2e build 的 test-pipeline.html 也用它量 #7 的指標。
 */
import type { ModelStatus, PipelineConfig } from '../shared/messages.ts';
import type { PageText, RatioRect } from '../shared/page-text.ts';
import recordedOcr from '../../testdata/synthetic/recorded-ocr.json' with { type: 'json' };
import { createFakeEngine, type RecordedOcr } from './fake-engine.ts';
import { createKuromojiReading } from './kuromoji-reading.ts';
import { detectExecutionProvider, MODEL_SETS, modelSetFiles, type ExecutionProvider } from './models/model-files.ts';
import { createModelStore, MODEL_CACHE } from './models/model-store.ts';
import { createResident } from './models/resident.ts';
import { createOrtEngine, type OrtEngine } from './ort-engine.ts';
import { createPageImage } from './page-image.ts';
import { analyzePage } from './pipeline/analyze.ts';

/**
 * 模型閒置這麼久就釋放（spec 第 13 節第 9 項交給實作決定）：5 分鐘。
 * 讀一頁通常十幾秒到一兩分鐘，5 分鐘夠涵蓋看完一頁、翻頁、短暫離開；
 * 再久就不值得一直佔著 0.9–1.4 GB。釋放後重新載入（從 Cache Storage）約 3–4 s。
 */
export const IDLE_RELEASE_MS = 5 * 60 * 1000;

export interface LocalPipelineDeps {
  onStatus(status: ModelStatus): void;
  idleMs?: number;
}

export function createLocalPipeline({ onStatus: report, idleMs = IDLE_RELEASE_MS }: LocalPipelineDeps) {
  let lastStatus = '';
  /** 連續相同的狀態只回報一次：翻譯接續預先下載時，兩邊都收到同一份進度（model-store.ts）。 */
  function onStatus(status: ModelStatus): void {
    const key = JSON.stringify(status);
    if (key === lastStatus) return;
    lastStatus = key;
    report(status);
  }
  let config: PipelineConfig = {};
  let resident: ReturnType<typeof createResident<OrtEngine>> | undefined;
  let residentKey = '';
  let queue: Promise<unknown> = Promise.resolve();
  /** 模型正在載入或已在記憶體裡：預先下載不再回報 downloaded（會蓋掉 loading／ready）。 */
  let engineActive = false;
  let store: ReturnType<typeof createModelStore> | undefined;
  let storeBaseUrl: string | undefined;

  /** 預先下載與翻譯共用同一個 store，同一組檔案同時只有一個下載（model-store.ts）。 */
  function modelStore() {
    if (!store || storeBaseUrl !== config.modelBaseUrl) {
      storeBaseUrl = config.modelBaseUrl;
      store = createModelStore({ fetch: (url) => fetch(url), openCache: () => caches.open(MODEL_CACHE), baseUrl: config.modelBaseUrl });
    }
    return store;
  }

  async function loadEngine(ep: ExecutionProvider): Promise<OrtEngine> {
    onStatus({ state: 'loading' });
    const [detector, encoder, decoder, vocab] = await modelStore().load(modelSetFiles(MODEL_SETS[ep]), (p) => onStatus({ state: 'downloading', ...p }));
    return createOrtEngine(ep, {
      detector: detector!,
      encoder: encoder!,
      decoder: decoder!,
      vocab: new TextDecoder().decode(vocab).split(/\r?\n/),
    }, config.maxThreads);
  }

  async function createEngine(): Promise<OrtEngine> {
    engineActive = true;
    if (__E2E__ && config.fakeOcr) {
      const engine = await createFakeEngine(recordedOcr as unknown as RecordedOcr[], (id) => chrome.runtime.getURL(`synthetic/${id}.png`), config.fakeOcrDelayMs);
      onStatus({ state: 'ready', executionProvider: engine.executionProvider, threads: engine.threads });
      return engine;
    }
    try {
      const preferred = config.executionProvider ?? (await detectExecutionProvider());
      let engine: OrtEngine;
      try {
        engine = await loadEngine(preferred);
      } catch (e) {
        // WebGPU 建 session 失敗（驅動、op 不支援）就退回 wasm；下載失敗或 SHA-256 不符不退。
        if (preferred !== 'webgpu' || !(e instanceof Error) || /SHA-256|下載/.test(e.message)) throw e;
        console.warn('WebGPU 不可用，改用 wasm', e);
        engine = await loadEngine('wasm');
      }
      onStatus({ state: 'ready', executionProvider: engine.executionProvider, threads: engine.threads });
      return engine;
    } catch (e) {
      engineActive = false;
      onStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  /**
   * onboarding 的預先下載（#169）：照翻譯流程的選法只下載那一組進快取，不建 session、不載入記憶體。
   * 之後 WebGPU 建 session 失敗而退回 wasm 時，照舊在那時補下載。失敗不報錯（之後第一次翻譯時照常下載），狀態回到 idle。
   */
  async function prefetch(): Promise<void> {
    if ((__E2E__ && config.fakeOcr) || engineActive) return;
    const ep = config.executionProvider ?? (await detectExecutionProvider());
    try {
      await modelStore().download(modelSetFiles(MODEL_SETS[ep]), (p) => onStatus({ state: 'downloading', ...p }));
      if (!engineActive) onStatus({ state: 'downloaded' });
    } catch (e) {
      console.warn('預先下載辨識模型失敗，第一次翻譯時再下載', e);
      if (!engineActive) onStatus({ state: 'idle' });
    }
  }

  function getResident() {
    const key = JSON.stringify(config);
    if (!resident || key !== residentKey) {
      residentKey = key;
      resident = createResident({
        create: createEngine,
        dispose: async (engine) => {
          await engine.release();
          engineActive = false;
          // 檔案多半仍在快取裡：SW 回答目前狀態時會查快取，回 downloaded
          onStatus({ state: 'idle' });
        },
        idleMs,
      });
    }
    return resident;
  }

  /** source 是截圖（或原圖），rect 是 Page 在裡面的範圍（像素）；accept 見 analyzePage（長 Page 篩框用）。 */
  function analyze(source: ImageBitmap, rect: { x: number; y: number; width: number; height: number }, accept?: (box: RatioRect) => boolean): Promise<PageText> {
    const task = queue.then(() =>
      getResident().use(async (engine) => {
        const reading = await createKuromojiReading(chrome.runtime.getURL('kuromoji/dict/'));
        return analyzePage(engine, createPageImage(source, rect), reading, accept);
      }),
    );
    queue = task.catch(() => {});
    return task;
  }

  return {
    analyze,
    prefetch,
    /** 只有 e2e build 會改：模型下載來源、強制 wasm（spec 第 12 節：自動測試預設跑 wasm）、FakeEngine。 */
    configure(next: PipelineConfig) {
      config = next;
    },
  };
}
