/**
 * 辨識模型下載的提示文字（#169）：onboarding 第 1 步的說明與右下角的進度藥丸；side panel 的下載進度也用同樣的 MB，
 * 兩邊看到的數字一樣。MB 用十進位（WebGPU 那組約 472 MB、wasm 那組約 128 MB）。
 */
import type { ModelStatus } from './messages.ts';

export const megabytes = (bytes: number): number => Math.round(bytes / 1_000_000);

export function downloadNotice(bytes: number): string {
  return `按下「開始設定」之後，會在背景下載辨識日文的模型（約 ${megabytes(bytes)} MB，只需要一次）。`;
}

/**
 * 右下角的藥丸：started＝這個 onboarding 已經觸發過下載。下載中一律顯示（也可能是 side panel 的翻譯在下載）；
 * 下載完只在觸發過時顯示。沒有暫停、取消；中斷或失敗就不顯示（之後第一次翻譯時照常下載）。
 */
export function downloadPill(status: ModelStatus, started: boolean): { text: string; done: boolean } | undefined {
  if (status.state === 'downloading') return { text: `正在下載辨識模型 ${megabytes(status.loaded)} / ${megabytes(status.total)} MB`, done: false };
  if (started && (status.state === 'downloaded' || status.state === 'loading' || status.state === 'ready')) return { text: '✓ 辨識模型已就緒', done: true };
  return undefined;
}
