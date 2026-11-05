/**
 * SW 回答「目前的模型狀態」（#169）。SW 記在記憶體裡的狀態，在 SW 被回收或模型釋放後是 idle（不知道）；
 * 這時查 Cache Storage 裡會用的那一組模型齊不齊全，齊全就是 downloaded（已下載、還沒載入）。
 */
import { MODEL_SETS, modelSetBytes, type ModelSet } from '../offscreen/models/model-files.ts';
import type { ExecutionProvider, ModelStatus, ModelStatusResponse } from '../shared/messages.ts';

export async function currentModelStatus(known: ModelStatus, isCached: () => Promise<boolean>): Promise<ModelStatus> {
  if (known.state !== 'idle') return known;
  return (await isCached()) ? { state: 'downloaded' } : known;
}

export interface ModelStatusDeps {
  /** 這台電腦用哪一組模型；offscreen 還沒準備好時會失敗（#221）。 */
  executionProvider: () => Promise<ExecutionProvider>;
  isCached: (set: ModelSet) => Promise<boolean>;
}

/**
 * 回答 panel:getModelStatus：不知道時查快取裡會用的那一組（照翻譯流程的選法）齊不齊全；也帶上那一組的大小。
 * 問不到用哪一組時不能斷掉 side panel 的請求：回目前知道的狀態、不帶大小，之後 offscreen 的 models:status 廣播會更新它。
 */
export async function modelStatusResponse(known: ModelStatus, deps: ModelStatusDeps): Promise<ModelStatusResponse> {
  let set: ModelSet;
  try {
    set = MODEL_SETS[await deps.executionProvider()];
  } catch (e) {
    console.warn('model status: execution provider unknown', e);
    return { status: known };
  }
  return { status: await currentModelStatus(known, () => deps.isCached(set)), downloadBytes: modelSetBytes(set) };
}
