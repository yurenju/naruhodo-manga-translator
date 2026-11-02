/**
 * SW 回答「目前的模型狀態」（#169）。SW 記在記憶體裡的狀態，在 SW 被回收或模型釋放後是 idle（不知道）；
 * 這時查 Cache Storage 裡會用的那一組模型齊不齊全，齊全就是 downloaded（已下載、還沒載入）。
 */
import type { ModelStatus } from '../shared/messages.ts';

export async function currentModelStatus(known: ModelStatus, isCached: () => Promise<boolean>): Promise<ModelStatus> {
  if (known.state !== 'idle') return known;
  return (await isCached()) ? { state: 'downloaded' } : known;
}
