import { describe, expect, it } from 'vitest';
import { downloadNotice, downloadPill, megabytes } from './model-download.ts';

describe('辨識模型下載的提示（#169）', () => {
  it('大小用十進位 MB、四捨五入：WebGPU 那組約 472 MB、wasm 那組約 128 MB', () => {
    expect(megabytes(471_967_622)).toBe(472);
    expect(megabytes(127_740_540)).toBe(128);
  });

  it('onboarding 第 1 步的說明帶上會下載的那一組的大小', () => {
    expect(downloadNotice(127_740_540)).toBe('按下「開始設定」之後，會在背景下載辨識日文的模型（約 128 MB，只需要一次）。');
  });

  it('下載中：顯示進度與轉圈', () => {
    expect(downloadPill({ state: 'downloading', loaded: 120_400_000, total: 471_967_622 }, true)).toEqual({ text: '正在下載辨識模型 120 / 472 MB', done: false });
  });

  it('下載完（或已經在載入、已載入）：✓ 辨識模型已就緒', () => {
    for (const status of [{ state: 'downloaded' }, { state: 'loading' }, { state: 'ready', executionProvider: 'webgpu', threads: 1 }] as const)
      expect(downloadPill(status, true)).toEqual({ text: '✓ 辨識模型已就緒', done: true });
  });

  it('還沒按「開始設定」就不顯示；但別處已經在下載（例如 side panel 的翻譯）就顯示進度', () => {
    expect(downloadPill({ state: 'downloaded' }, false)).toBeUndefined();
    expect(downloadPill({ state: 'idle' }, false)).toBeUndefined();
    expect(downloadPill({ state: 'downloading', loaded: 0, total: 1_000_000 }, false)).toEqual({ text: '正在下載辨識模型 0 / 1 MB', done: false });
  });

  it('下載中斷（回到 idle）或出錯就不顯示：之後第一次翻譯時照常下載', () => {
    expect(downloadPill({ state: 'idle' }, true)).toBeUndefined();
    expect(downloadPill({ state: 'error', message: '下載失敗' }, true)).toBeUndefined();
  });
});
