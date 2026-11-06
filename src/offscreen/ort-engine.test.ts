import { describe, expect, it } from 'vitest';
import { sessionExecutionProviders, topCandidates } from './ort-engine.ts';

describe('sessionExecutionProviders', () => {
  it('WebGPU 模式下 detector 走 wasm，encoder／decoder 走 WebGPU（#196）', () => {
    expect(sessionExecutionProviders('webgpu')).toEqual({ detector: 'wasm', encoder: 'webgpu', decoder: 'webgpu' });
  });

  it('wasm 模式三個模型都走 wasm', () => {
    expect(sessionExecutionProviders('wasm')).toEqual({ detector: 'wasm', encoder: 'wasm', decoder: 'wasm' });
  });
});

describe('topCandidates：解碼一步的前幾名候選（#228）', () => {
  it('照機率由高到低、最多 3 個；機率是整個字表的 softmax', () => {
    // 第二批（offset 5）的 logits：ln 4、0、ln 2、ln 3、0 → softmax 分母 4+1+2+3+1 = 11
    const logits = Float32Array.from([9, 9, 9, 9, 9, Math.log(4), 0, Math.log(2), Math.log(3), 0]);

    const top = topCandidates(logits, 5, 5);

    expect(top.map((c) => c.id)).toEqual([0, 3, 2]);
    expect(top.map((c) => c.probability)).toEqual([4 / 11, 3 / 11, 2 / 11].map((p) => expect.closeTo(p, 6)));
  });

  it('字表比 3 小時全部列出', () => {
    expect(topCandidates(Float32Array.from([0, 1]), 0, 2).map((c) => c.id)).toEqual([1, 0]);
  });
});
