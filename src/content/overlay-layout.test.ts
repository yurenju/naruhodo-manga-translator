import { describe, expect, it } from 'vitest';
import { breakLines, estimateFontPx, estimateOriginalLines, fitText, isVertical, layerTransform, layoutText, minLayerFontPx, looseTextRegions, pageSize, separateRegions, textRegions, verticalize, type Box } from './overlay-layout.ts';

describe('verticalize（直書前的文字處理）', () => {
  it('半形 !?~, 換成全形', () => {
    expect(verticalize('欸~好麻煩,真的?')).toEqual([{ text: '欸～好麻煩，真的？', upright: false }]);
  });

  it('... 與連續的 … 換成直書的刪節號', () => {
    expect(verticalize('結果...')).toEqual([{ text: '結果……', upright: false }]);
    expect(verticalize('喂…聽得到嗎')).toEqual([{ text: '喂……聽得到嗎', upright: false }]);
  });

  it('短英數字（1～3 字）與 !? 組合縱中橫', () => {
    expect(verticalize('7點在車站前')).toEqual([
      { text: '7', upright: true },
      { text: '點在車站前', upright: false },
    ]);
    expect(verticalize('你是認真的嗎!?')).toEqual([
      { text: '你是認真的嗎', upright: false },
      { text: '！？', upright: true },
    ]);
    expect(verticalize('OK！')).toEqual([
      { text: 'OK', upright: true },
      { text: '！', upright: false },
    ]);
  });

  it('4 字以上的英數字不縱中橫', () => {
    expect(verticalize('2026年')).toEqual([{ text: '2026年', upright: false }]);
  });
});

describe('isVertical', () => {
  it('預設直書；標橫書而且 Balloon 是寬的才橫書', () => {
    expect(isVertical('vertical', { x: 0, y: 0, w: 300, h: 100 })).toBe(true);
    expect(isVertical('horizontal', { x: 0, y: 0, w: 300, h: 100 })).toBe(false);
    expect(isVertical('horizontal', { x: 0, y: 0, w: 100, h: 300 })).toBe(true);
  });
});

describe('textRegions', () => {
  // Balloon 200×400，文字框在中間 60×200
  const balloon = { x: 100, y: 100, w: 200, h: 400 };
  const text = { x: 170, y: 200, w: 60, h: 200 };

  it('擦除範圍是文字框外擴 3px', () => {
    expect(textRegions(balloon, text).erase).toEqual({ x: 167, y: 197, w: 66, h: 206 });
  });

  it('第 1 階：文字框四邊外擴 Balloon 寬高的 12%，但不超出 Balloon 往內 8%', () => {
    // 左右：170−24=146、230+24=254（都在 116～284 內）；上下：200−48=152、400+48=448（在 132～468 內）
    expect(textRegions(balloon, text).fit1).toEqual({ x: 146, y: 152, w: 108, h: 296 });
    // 文字框貼著 Balloon 邊：夾在往內 8% 的位置
    expect(textRegions(balloon, { x: 105, y: 105, w: 190, h: 390 }).fit1).toEqual({ x: 116, y: 132, w: 168, h: 336 });
  });

  it('第 2 階：Balloon 往內 10%，而且不比第 1 階小', () => {
    expect(textRegions(balloon, text).fit2).toEqual({ x: 120, y: 140, w: 160, h: 320 });
    expect(textRegions(balloon, { x: 105, y: 105, w: 190, h: 390 }).fit2).toEqual({ x: 116, y: 132, w: 168, h: 336 });
  });

  it('有排版矩形（#150）：第 1、2 階都跟它取交集，擦除範圍不變', () => {
    const fit = { x: 160, y: 190, w: 80, h: 400 };

    const regions = textRegions(balloon, text, fit);

    // fit1 146～254 × 152～448、fit2 120～280 × 140～460，各自跟 160～240 × 190～590 取交集
    expect(regions.fit1).toEqual({ x: 160, y: 190, w: 80, h: 258 });
    expect(regions.fit2).toEqual({ x: 160, y: 190, w: 80, h: 270 });
    expect(regions.erase).toEqual({ x: 167, y: 197, w: 66, h: 206 });
  });
});

describe('separateRegions（相鄰 Balloon 的譯文範圍不重疊）', () => {
  // 真實的 canvas 網站一頁（822×1200）的偵測結果（#27 除錯 trace）：三個直書 Balloon 疊在一起，
  // 偵測框互相重疊，b7 的譯文「這個……」原本排進了 b6 的框裡
  const px = (r: Box): Box => ({ x: r.x * 822, y: r.y * 1200, w: r.w * 822, h: r.h * 1200 });
  const detected = {
    b5: { balloon: px({ x: 0.85523, y: 0.52083, w: 0.09367, h: 0.10083 }), text: px({ x: 0.87591, y: 0.53333, w: 0.05109, h: 0.0725 }) },
    b6: { balloon: px({ x: 0.73723, y: 0.53167, w: 0.17032, h: 0.19 }), text: px({ x: 0.77007, y: 0.55, w: 0.09976, h: 0.15333 }) },
    b7: { balloon: px({ x: 0.68978, y: 0.63, w: 0.10706, h: 0.1 }), text: px({ x: 0.72263, y: 0.6575, w: 0.05353, h: 0.05667 }) },
  };
  const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const contains = (b: Box, p: { x: number; y: number }) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

  it('重疊的 Balloon 之間，譯文範圍沿著文字框分得比較開的方向從中間切開', () => {
    const items = Object.values(detected).map(({ balloon, text }) => ({ text, ...textRegions(balloon, text) }));
    separateRegions(items);
    for (const [i, a] of items.entries()) {
      for (const b of items.slice(i + 1)) {
        expect(overlaps(a.fit1, b.fit1)).toBe(false);
        expect(overlaps(a.fit2, b.fit2)).toBe(false);
      }
      // 自己的文字框中心仍在範圍內，第 2 階仍不比第 1 階小
      expect(contains(a.fit1, center(a.text))).toBe(true);
      expect(contains(a.fit2, a.fit1) && contains(a.fit2, { x: a.fit1.x + a.fit1.w, y: a.fit1.y + a.fit1.h })).toBe(true);
    }
  });

  it('不重疊的 Balloon 不動', () => {
    const balloon = { x: 100, y: 100, w: 200, h: 400 };
    const text = { x: 170, y: 200, w: 60, h: 200 };
    const far = { x: 1000, y: 100, w: 200, h: 400 };
    const items = [
      { text, ...textRegions(balloon, text) },
      { text: { ...text, x: 1070 }, ...textRegions(far, { ...text, x: 1070 }) },
    ];
    const before = structuredClone(items);
    separateRegions(items);
    expect(items).toEqual(before);
  });
});

describe('looseTextRegions（Loose Text 的排版區是文字框本身，#151）', () => {
  const text = { x: 200, y: 100, w: 60, h: 180 };

  it('擦除範圍是文字框外擴 3px；第 1、2 階都是文字框（沒有泡泡可以往外長）', () => {
    const regions = looseTextRegions(text);

    expect(regions.erase).toEqual({ x: 197, y: 97, w: 66, h: 186 });
    expect(regions.fit1).toEqual(text);
    expect(regions.fit2).toEqual(text);
  });

  it('跟旁邊的 Balloon 一起 separateRegions：兩邊的譯文範圍不重疊，Loose Text 的範圍仍在自己的文字框內', () => {
    const balloonText = { x: 150, y: 120, w: 40, h: 150 };
    const items = [{ text, ...looseTextRegions(text) }, { text: balloonText, ...textRegions({ x: 120, y: 80, w: 100, h: 230 }, balloonText) }];

    separateRegions(items);

    const [loose, balloon] = items;
    for (const key of ['fit1', 'fit2'] as const) {
      expect(loose![key].x + loose![key].w <= balloon![key].x || balloon![key].x + balloon![key].w <= loose![key].x, key).toBe(true);
      expect(loose![key].x).toBeGreaterThanOrEqual(text.x);
      expect(loose![key].x + loose![key].w).toBeLessThanOrEqual(text.x + text.w);
    }
  });
});

describe('estimateFontPx（起始字級跟著原作字級，#80、#81）', () => {
  it('從文字框面積與譯文字數估字級，再乘保守係數', () => {
    // 200×300 裝 6 個字：√(60000÷6)＝100 → 字寬 54 → 字級 60（字寬約 0.9 em）→ 保守係數 0.9 → 54
    const [size] = estimateFontPx([{ text: { x: 0, y: 0, w: 200, h: 300 }, 譯文: '你之前有過嗎' }]);
    expect(size).toBeCloseTo(54);
  });

  it('每框各自估，但夾在整頁中位數 ±25%：喊叫的大字與小框不會差太多', () => {
    // 三個框的 √(面積÷字數)：400×300÷3 → 200、100×400÷4 → 100、50×100÷2 → 50
    // 各自是 108、54、27；中位數 54，夾在 40.5～67.5
    const page = [
      { text: { x: 0, y: 0, w: 400, h: 300 }, 譯文: '欸！？' },
      { text: { x: 0, y: 0, w: 100, h: 400 }, 譯文: '原來如此' },
      { text: { x: 0, y: 0, w: 50, h: 100 }, 譯文: '是的' },
    ];
    const sizes = estimateFontPx(page);
    expect(sizes[0]).toBeCloseTo(67.5);
    expect(sizes[1]).toBeCloseTo(54);
    expect(sizes[2]).toBeCloseTo(40.5);
  });

  it('連續的點（...、・・・ 或 …）算 2 個字（直書「……」佔兩格），空白不算', () => {
    // 都是 4 個字：100×400÷4 → 100 → 54
    const box = { x: 0, y: 0, w: 100, h: 400 };
    for (const 譯文 of ['你... 我', '你…我', '你・・・我', '……你我']) expect(estimateFontPx([{ text: box, 譯文 }])[0]).toBeCloseTo(54);
  });

  it('沒有譯文或文字框沒有面積的框用整頁中位數；整頁都沒得估就用 26px', () => {
    const box = { x: 0, y: 0, w: 200, h: 300 };
    expect(estimateFontPx([{ text: box, 譯文: ' ' }, { text: { ...box, w: 0 }, 譯文: '你' }])).toEqual([26, 26]);
    const sizes = estimateFontPx([{ text: box, 譯文: '' }, { text: box, 譯文: '你之前有過嗎' }]);
    expect(sizes[0]).toBeCloseTo(54);
    expect(sizes[1]).toBeCloseTo(54);
  });
});

describe('estimateOriginalLines（原文排成幾行，#81）', () => {
  // 450×200 裝 9 個字：√(90000÷9)＝100 → 字寬 54 → 原作字距約字寬 1.21 倍 ≈ 65.3
  const text = { x: 0, y: 0, w: 450, h: 200 };

  it('直書：一行沿著文字框的高放 ⌊高 ÷ 字距⌋ 個字', () => {
    // ⌊200 ÷ 65.3⌋＝3 字一行，9 字 → 3 行
    expect(estimateOriginalLines(text, 'あいうえおかきくけ', true)).toBe(3);
  });

  it('橫書：一行沿著文字框的寬', () => {
    // ⌊450 ÷ 65.3⌋＝6 字一行，9 字 → 2 行
    expect(estimateOriginalLines(text, 'あいうえおかきくけ', false)).toBe(2);
  });

  it('沒有原文或文字框沒有面積就當 1 行', () => {
    expect(estimateOriginalLines(text, '', true)).toBe(1);
    expect(estimateOriginalLines({ ...text, w: 0 }, 'あいう', true)).toBe(1);
  });
});

describe('breakLines（譯文斷成幾行，#81）', () => {
  it('只在詞與詞之間斷，各行差不多長；標點與刪節號跟著前面的字', () => {
    expect(breakLines('某個瞬間，力量好像增強了……', 3)).toEqual(['某個瞬間，', '力量好像', '增強了……']);
  });

  it('優先斷在標點後；為了這樣可以比原文少一行或多一行，數字與後面的量詞不拆開', () => {
    // 硬排 3 行會變成「七天後，／你們／四個人」；「四｜個人」不能拆
    expect(breakLines('七天後，你們四個人', 3)).toEqual(['七天後，', '你們四個人']);
  });

  it('兩邊都是單字的地方盡量不斷：多半是斷詞器不認得的詞', () => {
    // 斷詞器把「地城」切成「地｜城」
    expect(breakLines('希望你們能攻略B級地城的第一層到第五層。', 3)).toEqual(['希望你們能攻略B級', '地城的第一層到第五層。']);
  });

  it('單位比行數少就有幾個排幾行；一行時整句不斷', () => {
    expect(breakLines('欸！？', 3)).toEqual(['欸！？']);
    expect(breakLines('你們好嗎', 4)).toEqual(['你們', '好嗎']);
    expect(breakLines('現在……還不能說。', 1)).toEqual(['現在……還不能說。']);
  });

  it('只有整個詞是數字才黏住後面：以數字結尾的詞（統一）照常可以斷', () => {
    expect(breakLines('我們要統一大家的意見', 2)).toEqual(['我們要統一', '大家的意見']);
  });

  it('英文字之間的空白保留', () => {
    expect(breakLines('HP MP都滿了', 1)).toEqual(['HP MP都滿了']);
  });
});

describe('fitText（譯文太長的三階段，spec 第 7.4 節）', () => {
  const fit1: Box = { x: 0, y: 0, w: 100, h: 100 };
  const fit2: Box = { x: 0, y: 0, w: 150, h: 150 };

  /** 假的量測：每個範圍放得下的最大字級；套到 DOM 的紀錄。 */
  function target(capacity: Map<Box, number>) {
    const applied: [Box, number][] = [];
    let current: [Box, number] = [fit1, 0];
    return {
      applied,
      apply(region: Box, size: number) {
        current = [region, size];
        applied.push(current);
      },
      overflows: () => current[1] > capacity.get(current[0])!,
    };
  }

  it('放得下就用 26px', () => {
    expect(fitText(target(new Map([[fit1, 40], [fit2, 40]])), { fit1, fit2 }, 0)).toEqual({ stage: 1, size: 26, region: fit1, truncated: false });
  });

  it('有估出原作字級就從那個字級開始（#80）', () => {
    expect(fitText(target(new Map([[fit1, 60], [fit2, 60]])), { fit1, fit2 }, 0, 54)).toEqual({ stage: 1, size: 54, region: fit1, truncated: false });
    expect(fitText(target(new Map([[fit1, 40], [fit2, 40]])), { fit1, fit2 }, 0, 54)).toEqual({ stage: 1, size: 40, region: fit1, truncated: false });
  });

  it('起始字級比該階下限小時，從下限開始', () => {
    const t = target(new Map([[fit1, 40], [fit2, 40]]));
    expect(fitText(t, { fit1, fit2 }, 0, 10)).toEqual({ stage: 1, size: 14, region: fit1, truncated: false });
    expect(t.applied).toEqual([[fit1, 14]]);
  });

  it('第 1 階：在文字框外擴範圍內縮到放得下（最小 14px）', () => {
    expect(fitText(target(new Map([[fit1, 16], [fit2, 40]])), { fit1, fit2 }, 0)).toEqual({ stage: 1, size: 16, region: fit1, truncated: false });
  });

  it('第 2 階：14px 還放不下就擴到 Balloon 往內 10%，最小 12px', () => {
    expect(fitText(target(new Map([[fit1, 13], [fit2, 20]])), { fit1, fit2 }, 0)).toEqual({ stage: 2, size: 20, region: fit2, truncated: false });
    expect(fitText(target(new Map([[fit1, 11], [fit2, 12]])), { fit1, fit2 }, 0)).toEqual({ stage: 2, size: 12, region: fit2, truncated: false });
  });

  it('第 3 階：還放不下就 10px 並截斷', () => {
    const t = target(new Map([[fit1, 5], [fit2, 5]]));
    expect(fitText(t, { fit1, fit2 }, 0)).toEqual({ stage: 3, size: 10, region: fit2, truncated: true });
    expect(t.applied.at(-1)).toEqual([fit2, 10]);
  });

  it('最小字級另外用畫面 px 判斷：每一階都不小於換算回 Page 像素的 9px', () => {
    // 顯示倍率 0.5：畫面 9px＝Page 18px
    const min = minLayerFontPx(0.5);
    expect(min).toBe(18);
    expect(fitText(target(new Map([[fit1, 16], [fit2, 19]])), { fit1, fit2 }, min)).toEqual({ stage: 2, size: 19, region: fit2, truncated: false });
    expect(fitText(target(new Map([[fit1, 16], [fit2, 16]])), { fit1, fit2 }, min)).toEqual({ stage: 3, size: 18, region: fit2, truncated: true });
  });

  it('不是整數的最小字級也會試到', () => {
    const min = minLayerFontPx(0.48); // 18.75
    expect(fitText(target(new Map([[fit1, 18.75], [fit2, 0]])), { fit1, fit2 }, min)).toEqual({ stage: 1, size: 18.75, region: fit1, truncated: false });
  });
});

describe('layoutText（行數和字級一起挑，#129）', () => {
  /** 假的直書量測：一行佔 字級 × 1.15 寬、一行的高是字數 × 字級；範圍放不下就溢出。 */
  function verticalTarget() {
    let lines: string[] = [];
    let region: Box = { x: 0, y: 0, w: 0, h: 0 };
    let size = 0;
    return {
      setLines(next: string[]) {
        lines = next;
      },
      apply(next: Box, px: number) {
        region = next;
        size = px;
      },
      overflows: () => lines.length * size * 1.15 > region.w || Math.max(...lines.map((line) => [...line].length)) * size > region.h,
    };
  }

  it('少一行就得縮字時改用原文行數：第一輪作品 B 的旁白框 b2', () => {
    const text: Box = { x: 0, y: 0, w: 122, h: 233 };
    const 譯文 = '日本也新設了「航空宇宙自衛隊」！';
    const [startPx] = estimateFontPx([{ text, 譯文 }]);
    // 扣分只看斷法會選 1 行（16 字擠一行，字級縮到約 14.6）
    expect(breakLines(譯文, 2)).toHaveLength(1);
    const result = layoutText(verticalTarget(), 譯文, 2, { fit1: text, fit2: text }, 0, startPx);
    expect(result.lines).toHaveLength(2);
    expect(result.size).toBe(startPx);
  });

  /** 假的量測：排成幾行時放得下的最大字級（不看範圍）。 */
  function byLineCount(capacity: Record<number, number>) {
    let lines: string[] = [];
    let size = 0;
    return {
      setLines(next: string[]) {
        lines = next;
      },
      apply(_region: Box, px: number) {
        size = px;
      },
      overflows: () => size > (capacity[lines.length] ?? 0),
    };
  }
  const regions = { fit1: { x: 0, y: 0, w: 100, h: 100 }, fit2: { x: 0, y: 0, w: 150, h: 150 } };

  it('幾個候選都能用起始字級排下時，跟只看扣分一樣', () => {
    const result = layoutText(byLineCount({ 2: 40, 3: 40, 4: 40 }), '七天後，你們四個人', 3, regions, 0, 26);
    expect(result).toMatchObject({ lines: ['七天後，', '你們四個人'], size: 26, stage: 1 });
  });

  it('字級差 5% 以內視為一樣大，看扣分；差更多就取字級大的', () => {
    // 扣分最低的是 2 行（斷在「，」後）
    expect(layoutText(byLineCount({ 2: 25, 3: 26 }), '七天後，你們四個人', 3, regions, 0, 26).lines).toEqual(['七天後，', '你們四個人']);
    expect(layoutText(byLineCount({ 2: 24, 3: 26 }), '七天後，你們四個人', 3, regions, 0, 26)).toMatchObject({ lines: ['七天後，', '你們', '四個人'], size: 26 });
  });

  it('截斷的候選排在沒截斷的後面，量完把選中的斷法套回去', () => {
    const target = byLineCount({ 3: 18 });
    const applied: number[][] = [];
    const setLines = target.setLines;
    target.setLines = (lines) => {
      applied.push([lines.length]);
      setLines(lines);
    };
    // 最小字級 18：3 行與截斷的 2 行都是 18px，2 行扣分比較低
    const result = layoutText(target, '七天後，你們四個人', 3, regions, 18, 26);
    expect(result).toMatchObject({ lines: ['七天後，', '你們', '四個人'], size: 18, stage: 1, truncated: false });
    expect(applied.at(-1)).toEqual([3]);
    expect(target.overflows()).toBe(false);
  });
});

describe('Page 層對到 anchor', () => {
  // 仿 canvas 網站：880×1280 的 canvas 顯示成 430 寬，在 offsetParent 裡的 (16, 40)
  const anchor = { offsetLeft: 16, offsetTop: 40, offsetWidth: 430, offsetHeight: 625.45 };
  const whole = { x: 0, y: 0, w: 1, h: 1 };

  it('Page 原始像素取自 anchor 的原圖尺寸 × subRect', () => {
    expect(pageSize({ width: 880, height: 1280 }, whole, anchor)).toEqual({ width: 880, height: 1280 });
    // Spread 的左頁
    expect(pageSize({ width: 1760, height: 1280 }, { x: 0, y: 0, w: 0.5, h: 1 }, anchor)).toEqual({ width: 880, height: 1280 });
  });

  it('不知道原圖尺寸時用畫面大小', () => {
    expect(pageSize({ width: 0, height: 0 }, whole, anchor)).toEqual({ width: 430, height: 625.45 });
  });

  it('translate 到 anchor 的 offset 位置＋subRect，scale 成畫面大小', () => {
    expect(layerTransform(anchor, whole, { width: 880, height: 1280 })).toEqual({ x: 16, y: 40, scaleX: 430 / 880, scaleY: 625.45 / 1280 });
    // Spread 的右頁（subRect x＝0.5）
    expect(layerTransform({ ...anchor, offsetWidth: 860 }, { x: 0.5, y: 0, w: 0.5, h: 1 }, { width: 880, height: 1280 })).toEqual({
      x: 16 + 430,
      y: 40,
      scaleX: 430 / 880,
      scaleY: 625.45 / 1280,
    });
  });
});
