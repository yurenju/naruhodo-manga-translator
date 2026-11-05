import { describe, expect, it } from 'vitest';
import { sessionExecutionProviders } from './ort-engine.ts';

describe('sessionExecutionProviders', () => {
  it('WebGPU 模式下 detector 走 wasm，encoder／decoder 走 WebGPU（#196）', () => {
    expect(sessionExecutionProviders('webgpu')).toEqual({ detector: 'wasm', encoder: 'webgpu', decoder: 'webgpu' });
  });

  it('wasm 模式三個模型都走 wasm', () => {
    expect(sessionExecutionProviders('wasm')).toEqual({ detector: 'wasm', encoder: 'wasm', decoder: 'wasm' });
  });
});
