import { describe, expect, it } from 'vitest';
import recordedJson from '../../testdata/synthetic/recorded-ocr.json' with { type: 'json' };
import type { RatioRect } from '../shared/page-text.ts';
import { cropGray, letterbox, readGray, readGroundTruth } from '../testing/synthetic.ts';
import { createPageMatcher, engineFrom, type RecordedOcr } from './fake-engine.ts';
import { analyzePage } from './pipeline/analyze.ts';
import type { GrayImage } from './pipeline/reading-order.ts';
import { cropImage, splitSpread } from './spread.ts';

const recorded = recordedJson as unknown as RecordedOcr[];
const match = createPageMatcher(recorded, (id, rect) => cropGray(readGray(id), rect));

/** 擺放位置跟預期差幾 px 以內（縮放後取整）。 */
const TOLERANCE = 3;

const pageImage = (gray: GrayImage) => ({ width: gray.width, height: gray.height, gray: () => gray, rgb640: () => new Uint8Array(), crop224: () => new Uint8Array() });

function expectNearRect(actual: RatioRect, expected: RatioRect, label: string): void {
  for (const key of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(actual[key] - expected[key]), `${label} ${key}`).toBeLessThan(0.001);
}

describe('FakeEngine 認頁', () => {
  for (const r of recorded) {
    it(`${r.id} [${r.rect.join(', ')}] 縮小後（仿 canvas 網站的 canvas）認得出來，擺滿整張`, () => {
      const { image } = letterbox(cropGray(readGray(r.id), r.rect), { width: Math.round(r.rect[2] * 0.7), height: Math.round(r.rect[3] * 0.7) });
      const result = match(image);
      expect([result.recorded.id, result.recorded.rect]).toEqual([r.id, r.rect]);
      expect(result.at).toEqual([0, 0, image.width, image.height]);
    });
  }

  it('仿電子書閱讀器黑邊的 Spread：去黑邊、切成兩頁後，各自認成 Spread 的那一頁', () => {
    const gt = readGroundTruth('p07-spread');
    const { image } = letterbox(readGray('p07-spread'), { width: 1280, height: 1500 });
    const split = splitSpread(image);
    expect(split).toHaveLength(2);
    split.forEach((rect, i) => {
      const result = match(cropImage(image, rect));
      expect([result.recorded.id, result.recorded.rect]).toEqual(['p07-spread', gt.pages[i]!.bbox]);
    });
  });

  it('白底、沒去邊的單頁：認成等比例縮放置中', () => {
    const { image, content } = letterbox(readGray('p01-basic'), { width: 1280, height: 1500 }, 255);
    const result = match(image);
    expect(result.recorded.id).toBe('p01-basic');
    const [x, y, w, h] = result.at;
    for (const [actual, expected] of [
      [x, content.x],
      [y, content.y],
      [w, content.width],
      [h, content.height],
    ] as const) {
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(TOLERANCE);
    }
  });

  it('跟任何合成頁都不像就 throw', () => {
    const noise = new Uint8Array(400 * 600).map((_, i) => (i * 7919) % 256);
    expect(() => match({ gray: noise, width: 400, height: 600 })).toThrow('FakeEngine 認不出');
  });
});

describe('FakeEngine 重播', () => {
  for (const r of recorded) {
    it(`${r.id} [${r.rect.join(', ')}]：經過 analyzePage 還原出錄下來的 Balloon 與 Loose Text`, async () => {
      const text = await analyzePage(engineFrom(match), pageImage(cropGray(readGray(r.id), r.rect)), () => '');
      expect(text.balloons.map((b) => b.原文)).toEqual(r.balloons.map((b) => b.原文));
      expect(text.looseText.map((l) => l.原文)).toEqual(r.looseText.map((l) => l.原文));
      expect(text.balloons.map((b) => b.ocrConfidence)).toEqual(r.balloons.map((b) => b.ocrConfidence));
      expect(text.looseText.map((l) => l.ocrConfidence)).toEqual(r.looseText.map((l) => l.ocrConfidence));
      text.balloons.forEach((b, i) => {
        expectNearRect(b.balloonBbox, r.balloons[i]!.balloonBbox, `${b.原文} balloonBbox`);
        expectNearRect(b.textBbox, r.balloons[i]!.textBbox, `${b.原文} textBbox`);
      });
      text.looseText.forEach((l, i) => expectNearRect(l.bbox, r.looseText[i]!.bbox, `${l.原文} bbox`));
    });
  }
});
