/**
 * 用 onnxruntime-web 跑 detector（comic-text-and-bubble-detector）與 manga-ocr（spec #27 第 3.3 節）。
 *
 * 沒用 transformers.js：它要 decoder_model_merged.onnx，onnx-community 的 manga-ocr repo 沒有（#7），
 * 所以照 prototype 自己做 greedy decoding（沒有 KV cache；原版 manga-ocr 用 beam 4）。
 *
 * onnxruntime-web 不跟著 esbuild 打包：它的 .mjs 原樣放在外掛的 ort/ 裡、執行時動態 import，
 * 這樣它用 import.meta.url 找 wasm 與開多執行緒 worker 時，指到的都是它自己的檔案。
 */
import type * as Ort from 'onnxruntime-web';
import type { ExecutionProvider } from './models/model-files.ts';
import { DETECTION_LABELS, type Detection, type Engine, type PageImage, type Recognized } from './pipeline/analyze.ts';
import { TOP_CANDIDATES, type Candidate } from './pipeline/name-fix.ts';
import type { PixelBox } from './pipeline/boxes.ts';
import { createTrace } from '../shared/trace.ts';

type OrtModule = typeof Ort;

const trace = createTrace('offscreen');

const CLS = 2n;
const SEP = 3;
/** token id ≤ 4 是特殊 token（PAD／UNK／CLS／SEP／MASK）。 */
const LAST_SPECIAL = 4;
const MAX_TOKENS = 64;

let ortPromise: Promise<OrtModule> | undefined;

export function loadOrt(): Promise<OrtModule> {
  ortPromise ??= (async () => {
    const ort = (await import(chrome.runtime.getURL('ort/ort.webgpu.bundle.min.mjs'))) as OrtModule;
    ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/');
    // 多執行緒要 SharedArrayBuffer，也就是 crossOriginIsolated（manifest 的 COOP／COEP）；沒有就單執行緒。
    ort.env.wasm.numThreads = crossOriginIsolated ? navigator.hardwareConcurrency : 1;
    return ort;
  })();
  return ortPromise;
}

export interface OrtEngine extends Engine {
  executionProvider: ExecutionProvider;
  threads: number;
  release(): Promise<void>;
}

/**
 * 每個模型的 session 用哪個 EP。
 *
 * WebGPU 模式下 detector 還是用 wasm（#196）：detector 只有 int8 版，WebGPU 跑 int8 時有些運算退回 CPU，
 * 資料在 GPU 與 CPU 間來回搬，反而是整頁 OCR 最慢的一段。本機兩部作品 58 頁、跑 2 輪的每頁平均：
 * detector 0.67 s → 0.21 s，整頁 OCR 1.28 s → 0.85 s，每一頁都變快。
 * 代價是兩個 EP 的 int8 捨入不同，框差一點（中位 1 px、p90 2 px），認出的字偶爾不同，
 * 標點符號 wasm 比較常讀歪（「…」變「・・・」之類）；維護者決定接受。
 * encoder／decoder 是 fp32，照樣用 WebGPU。
 */
export function sessionExecutionProviders(ep: ExecutionProvider): Record<'detector' | 'encoder' | 'decoder', ExecutionProvider> {
  return { detector: 'wasm', encoder: ep, decoder: ep };
}

/**
 * 解碼一步的前 TOP_CANDIDATES 名 token（修名字用，#228） 與 softmax 機率（機率高的在前）。logits 從 offset 起是這一步整個字表的值。
 * 第 1 名的機率就是這個字的 OCR 信心（ADR 0009）。
 */
export function topCandidates(logits: Float32Array, offset: number, vocabSize: number): { id: number; probability: number }[] {
  const k = TOP_CANDIDATES;
  const top: { id: number; logit: number }[] = [];
  for (let v = 0; v < vocabSize; v++) {
    const logit = logits[offset + v]!;
    if (top.length === k && logit <= top[k - 1]!.logit) continue;
    let i = Math.min(top.length, k - 1);
    while (i > 0 && top[i - 1]!.logit < logit) i--;
    top.splice(i, 0, { id: v, logit });
    if (top.length > k) top.pop();
  }
  const max = top[0]?.logit ?? 0;
  let sum = 0;
  for (let v = 0; v < vocabSize; v++) sum += Math.exp(logits[offset + v]! - max);
  return top.map(({ id, logit }) => ({ id, probability: Math.exp(logit - max) / sum }));
}

export async function createOrtEngine(
  ep: ExecutionProvider,
  models: { detector: ArrayBuffer; encoder: ArrayBuffer; decoder: ArrayBuffer; vocab: string[] },
  maxThreads?: number,
): Promise<OrtEngine> {
  const ort = await loadOrt();
  if (maxThreads !== undefined) ort.env.wasm.numThreads = Math.min(ort.env.wasm.numThreads ?? 1, maxThreads);
  // wasm 模式在 proxy worker 裡跑：建 session（編譯、最佳化）與推論都不卡 offscreen 的主執行緒，
  // 裁切縮圖等其他訊息才不會被擋住（外掛頁面共用同一個 renderer）。WebGPU 不支援 proxy。
  // 這個設定是全域的、只在第一次初始化前設定有效，所以 WebGPU 模式下 wasm 的 detector 也不走 proxy，
  // 在 offscreen 主執行緒上跑，每頁約卡 0.2 s；#196 的數字就是在這個條件下量的，換整頁 OCR 快約 0.4 s。
  ort.env.wasm.proxy = ep === 'wasm';
  const providers = sessionExecutionProviders(ep);
  // logSeverityLevel 3＝只記 error：「部分節點沒分給 WebGPU」的警告每建一次 session 就印兩行，
  // 擠滿 chrome://extensions 的錯誤頁，而那是 ORT 刻意把 shape 運算放 CPU（#27 除錯）
  const create = (buffer: ArrayBuffer, provider: ExecutionProvider) =>
    ort.InferenceSession.create(new Uint8Array(buffer), { executionProviders: [provider], logSeverityLevel: 3 });
  // detector 最後建：WebGPU 建不起來時要在 wasm 的 session 出現前就失敗，
  // local-pipeline 退回 wasm 重建時 proxy 才還來得及生效。哪個失敗，就把已經建好的放掉。
  const sessions: Ort.InferenceSession[] = [];
  const createTracked = async (buffer: ArrayBuffer, provider: ExecutionProvider) => {
    const session = await create(buffer, provider);
    sessions.push(session);
    return session;
  };
  let encoder: Ort.InferenceSession, decoder: Ort.InferenceSession, detector: Ort.InferenceSession;
  try {
    encoder = await createTracked(models.encoder, providers.encoder);
    decoder = await createTracked(models.decoder, providers.decoder);
    detector = await createTracked(models.detector, providers.detector);
  } catch (error) {
    await Promise.allSettled(sessions.map((session) => session.release()));
    throw error;
  }
  const { vocab } = models;

  /** debug build：每頁各段的推論時間（#196 驗收），recognize 結束時跟 detector 的一起印成 ocr:timing。 */
  let detectorMs = 0;

  async function detect(image: PageImage): Promise<Detection[]> {
    const rgb = image.rgb640();
    const plane = 640 * 640;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) input[c * plane + i] = rgb[i * 3 + c]! / 255;
    const detectStartedAt = performance.now();
    const out = await detector.run({
      images: new ort.Tensor('float32', input, [1, 3, 640, 640]),
      orig_target_sizes: new ort.Tensor('int64', BigInt64Array.from([BigInt(image.width), BigInt(image.height)]), [1, 2]),
    });
    if (__DEBUG__) detectorMs = performance.now() - detectStartedAt;
    const labels = out.labels!.data as BigInt64Array;
    const boxes = out.boxes!.data as Float32Array;
    const scores = out.scores!.data as Float32Array;
    const detections: Detection[] = [];
    for (let i = 0; i < scores.length; i++) {
      const label = DETECTION_LABELS[Number(labels[i])];
      if (!label) continue;
      const [x1, y1, x2, y2] = [boxes[i * 4]!, boxes[i * 4 + 1]!, boxes[i * 4 + 2]!, boxes[i * 4 + 3]!];
      detections.push({ label, score: scores[i]!, box: [x1, y1, x2 - x1, y2 - y1].map(Math.round) as PixelBox });
    }
    return detections;
  }

  async function recognize(image: PageImage, boxes: PixelBox[]): Promise<Recognized[]> {
    if (boxes.length === 0) return [];
    const n = boxes.length;
    const plane = 224 * 224;
    const pixels = new Float32Array(n * 3 * plane);
    boxes.forEach((box, k) => {
      const gray = image.crop224(box);
      for (let i = 0; i < plane; i++) {
        const v = (gray[i]! / 255 - 0.5) / 0.5;
        pixels[k * 3 * plane + i] = v;
        pixels[k * 3 * plane + plane + i] = v;
        pixels[k * 3 * plane + 2 * plane + i] = v;
      }
    });
    // 整頁所有框一個 batch
    const encodeStartedAt = performance.now();
    const { last_hidden_state: hidden } = await encoder.run({ pixel_values: new ort.Tensor('float32', pixels, [n, 3, 224, 224]) });
    const decodeStartedAt = performance.now();
    let decodeSteps = 0;
    const sequences: bigint[][] = Array.from({ length: n }, () => [CLS]);
    /** 每一步選中的 token 的 softmax 機率（OCR 信心，ADR 0009），跟 sequences 去掉 CLS 後一一對應。 */
    const probabilities: number[][] = Array.from({ length: n }, () => []);
    /** 每一步的前 3 名候選（修名字用，#228），跟 probabilities 一一對應。 */
    const stepCandidates: Candidate[][][] = Array.from({ length: n }, () => []);
    const done = new Array<boolean>(n).fill(false);
    const tokenText = (id: number) => (vocab[id] ?? '').replace(/^##/, '');
    for (let step = 0; step < MAX_TOKENS && done.includes(false); step++) {
      decodeSteps++;
      const length = sequences[0]!.length;
      const ids = BigInt64Array.from(sequences.flat());
      const { logits } = await decoder.run({
        input_ids: new ort.Tensor('int64', ids, [n, length]),
        // proxy 模式會把輸入的 ArrayBuffer transfer 給 worker，每一步都要給一份新的
        encoder_hidden_states: new ort.Tensor('float32', (hidden!.data as Float32Array).slice(), hidden!.dims),
      });
      const vocabSize = logits!.dims[2]!;
      const data = logits!.data as Float32Array;
      for (let k = 0; k < n; k++) {
        if (done[k]) {
          sequences[k]!.push(0n);
          probabilities[k]!.push(1);
          stepCandidates[k]!.push([]);
          continue;
        }
        const top = topCandidates(data, (k * length + length - 1) * vocabSize, vocabSize);
        const best = top[0]!.id;
        sequences[k]!.push(BigInt(best));
        probabilities[k]!.push(top[0]!.probability);
        stepCandidates[k]!.push(top.map(({ id, probability }) => ({ text: tokenText(id), probability })));
        if (best === SEP) done[k] = true;
      }
    }
    if (__DEBUG__) {
      trace('ocr:timing', {
        providers,
        detectorMs: Math.round(detectorMs),
        encoderMs: Math.round(decodeStartedAt - encodeStartedAt),
        decoderMs: Math.round(performance.now() - decodeStartedAt),
        boxes: n,
        decodeSteps,
      });
    }
    return sequences.map((seq, k) => {
      const tokens = seq
        .slice(1)
        .map((t, step) => ({ id: Number(t), probability: probabilities[k]![step]!, candidates: stepCandidates[k]![step]! }))
        .filter(({ id }) => id > LAST_SPECIAL)
        .map(({ id, probability, candidates }) => ({ text: tokenText(id), probability, candidates }));
      // 一個 token 可能不只一個字：每個字都用那個 token 的機率與候選
      return {
        text: tokens.map((t) => t.text).join(''),
        confidences: tokens.flatMap((t) => [...t.text].map(() => t.probability)),
        candidates: tokens.flatMap((t) => [...t.text].map(() => t.candidates)),
      };
    });
  }

  return {
    executionProvider: ep,
    threads: ort.env.wasm.numThreads ?? 1,
    detect,
    recognize,
    async release() {
      await Promise.all([detector.release(), encoder.release(), decoder.release()]);
    },
  };
}
