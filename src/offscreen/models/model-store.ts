/**
 * 模型檔的下載與快取（spec #27 第 3.3 節）：存在外掛 origin 的 Cache Storage，之後離線可用。
 * 下載完先驗證 SHA-256 才存進快取；不符就丟掉並回報錯誤，下次重新下載。
 * 同一組檔案同時只有一個下載（#169）：onboarding 的預先下載進行中時開始翻譯，翻譯接續同一個下載、看到同一份進度。
 * 中斷了不續傳，下次呼叫時重新下載還沒進快取的檔案。
 */
import { HUGGING_FACE, modelUrl, type ModelFile } from './model-files.ts';

/** Cache Storage 裡放模型的 cache 名稱。 */
export const MODEL_CACHE = 'models-v1';

/** Cache 介面裡用得到的部分（測試可以換成記憶體版）。 */
export interface CacheLike {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
}

export interface DownloadProgress {
  loaded: number;
  /** 這次需要下載的總 bytes（已在快取裡的不算）。 */
  total: number;
}

export interface ModelStoreDeps {
  fetch(url: string): Promise<Response>;
  openCache(): Promise<CacheLike>;
  /** 下載來源；預設 Hugging Face。快取的 key 一律是 Hugging Face 的網址，換來源也命中同一份。 */
  baseUrl?: string;
}

export class ModelIntegrityError extends Error {}

/** 進行中的一次下載：之後加入的呼叫也收得到進度。 */
interface Batch {
  done: Promise<void>;
  progress?: DownloadProgress;
  listeners: Set<(progress: DownloadProgress) => void>;
}

export function createModelStore(deps: ModelStoreDeps) {
  const batches = new Map<string, Batch>();

  async function fetchVerified(file: ModelFile, onBytes: (n: number) => void): Promise<ArrayBuffer> {
    const url = modelUrl(file, deps.baseUrl ?? HUGGING_FACE);
    const response = await deps.fetch(url);
    if (!response.ok) throw new Error(`模型下載失敗：${file.path}（HTTP ${response.status}）`);
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
      onBytes(value.byteLength);
    }
    const buffer = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const digest = toHex(await crypto.subtle.digest('SHA-256', buffer));
    if (digest !== file.sha256) {
      throw new ModelIntegrityError(`模型檔 SHA-256 不符，已捨棄：${file.path}（預期 ${file.sha256}，實際 ${digest}）`);
    }
    return buffer.buffer;
  }

  /** 把不在快取裡的檔案依序下載進快取，不留在記憶體裡（預先下載用）。同一組檔案已經在下載就接續它。 */
  function download(files: readonly ModelFile[], onProgress?: (progress: DownloadProgress) => void): Promise<void> {
    const key = files.map((file) => modelUrl(file)).join(' ');
    let batch = batches.get(key);
    if (batch) {
      if (onProgress && batch.progress) onProgress(batch.progress);
    } else {
      const started: Batch = { done: Promise.resolve(), listeners: new Set() };
      const report = (progress: DownloadProgress) => {
        started.progress = progress;
        for (const listener of started.listeners) listener(progress);
      };
      started.done = downloadMissing(files, report).finally(() => batches.delete(key));
      batches.set(key, started);
      batch = started;
    }
    if (onProgress) batch.listeners.add(onProgress);
    return batch.done;
  }

  async function downloadMissing(files: readonly ModelFile[], report: (progress: DownloadProgress) => void): Promise<void> {
    const cache = await deps.openCache();
    const cached = await Promise.all(files.map((file) => cache.match(modelUrl(file))));
    const missing = files.filter((_, i) => !cached[i]);
    const total = missing.reduce((sum, file) => sum + file.size, 0);
    let loaded = 0;
    if (total > 0) report({ loaded, total });
    for (const file of missing) {
      const buffer = await fetchVerified(file, (n) => {
        loaded += n;
        report({ loaded, total });
      });
      await cache.put(modelUrl(file), new Response(buffer));
    }
  }

  /** 依序取得每個檔案的內容；不在快取裡的先下載。 */
  async function load(files: readonly ModelFile[], onProgress?: (progress: DownloadProgress) => void): Promise<ArrayBuffer[]> {
    await download(files, onProgress);
    const cache = await deps.openCache();
    return Promise.all(
      files.map(async (file) => {
        const hit = await cache.match(modelUrl(file));
        if (!hit) throw new Error(`模型檔不在快取裡：${file.path}`);
        return hit.arrayBuffer();
      }),
    );
  }

  return { load, download };
}

/** 每個檔案都已經在快取裡（SW 判斷「已下載、還沒載入」用）。 */
export async function isCached(cache: CacheLike, files: readonly ModelFile[]): Promise<boolean> {
  return (await Promise.all(files.map((file) => cache.match(modelUrl(file))))).every(Boolean);
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
