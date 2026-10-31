/**
 * 本機段（spec #27 第 3.3、3.4 節）：模型下載／常駐 → 偵測＋OCR＋閱讀順序 → kuromoji 讀音。併發 1。
 * offscreen document 用它；e2e build 的 test-pipeline.html 也用它量 #7 的指標。
 */
import type { ModelStatus, PipelineConfig } from '../shared/messages.ts';
import type { PageText, RatioRect } from '../shared/page-text.ts';
import recordedOcr from '../../testdata/synthetic/recorded-ocr.json' with { type: 'json' };
import { createFakeEngine, type RecordedOcr } from './fake-engine.ts';
import { createKuromojiReading } from './kuromoji-reading.ts';
import { MODEL_SETS, type ExecutionProvider } from './models/model-files.ts';
import { createModelStore, MODEL_CACHE } from './models/model-store.ts';
import { createResident } from './models/resident.ts';
import { createOrtEngine, detectExecutionProvider, type OrtEngine } from './ort-engine.ts';
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

export function createLocalPipeline({ onStatus, idleMs = IDLE_RELEASE_MS }: LocalPipelineDeps) {
  let config: PipelineConfig = {};
  let resident: ReturnType<typeof createResident<OrtEngine>> | undefined;
  let residentKey = '';
  let queue: Promise<unknown> = Promise.resolve();

  async function loadEngine(ep: ExecutionProvider): Promise<OrtEngine> {
    const store = createModelStore({
      fetch: (url) => fetch(url),
      openCache: () => caches.open(MODEL_CACHE),
      baseUrl: config.modelBaseUrl,
    });
    const set = MODEL_SETS[ep];
    onStatus({ state: 'loading' });
    const [detector, encoder, decoder, vocab] = await store.load([set.detector, set.encoder, set.decoder, set.vocab], (p) =>
      onStatus({ state: 'downloading', ...p }),
    );
    return createOrtEngine(ep, {
      detector: detector!,
      encoder: encoder!,
      decoder: decoder!,
      vocab: new TextDecoder().decode(vocab).split(/\r?\n/),
    }, config.maxThreads);
  }

  async function createEngine(): Promise<OrtEngine> {
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
      onStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      throw e;
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
    /** 只有 e2e build 會改：模型下載來源、強制 wasm（spec 第 12 節：自動測試預設跑 wasm）、FakeEngine。 */
    configure(next: PipelineConfig) {
      config = next;
    },
  };
}
