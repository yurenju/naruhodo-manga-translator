import { describe, expect, it } from 'vitest';
import { overlaidTexts, withoutEraseData, type BalloonText, type LooseText, type PageText } from './page-text.ts';

const rect = { x: 0, y: 0, w: 0.1, h: 0.1 };

const balloon = (id: string, overrides: Partial<BalloonText> = {}): BalloonText => ({
  id,
  order: 1,
  balloonBbox: rect,
  textBbox: rect,
  orientation: 'vertical',
  原文: 'はい',
  讀音: 'はい',
  讀音來源: 'llm',
  譯文: '好',
  unreadable: false,
  ...overrides,
});

const loose = (id: string, overrides: Partial<LooseText> = {}): LooseText => ({
  id,
  order: 9,
  bbox: rect,
  orientation: 'vertical',
  原文: 'あ…',
  讀音: 'あ…',
  讀音來源: 'llm',
  譯文: '啊…',
  unreadable: false,
  sfx: false,
  ...overrides,
});

const ids = ({ balloons, looseText }: PageText) => [...balloons, ...looseText].map((t) => t.id);

describe('overlaidTexts：要原地覆蓋的段', () => {
  it('有譯文的 Balloon 覆蓋；unreadable（LLM 判斷亂碼或 OCR 信心低於門檻）與還沒譯文的不覆蓋', () => {
    const text = { balloons: [balloon('b1'), balloon('b2', { unreadable: true, 譯文: '硬翻的譯文' }), balloon('b3', { 譯文: '' })], looseText: [] };

    expect(ids(overlaidTexts(text))).toEqual(['b1']);
  });

  it('舊快取沒有 ocrConfidence：照 unreadable 判斷，跟以前一樣覆蓋', () => {
    const text = { balloons: [balloon('b1', { ocrConfidence: undefined })], looseText: [] };

    expect(ids(overlaidTexts(text))).toEqual(['b1']);
  });

  it('LLM 標成 Sound Effect 的 Balloon（泡泡裡的ドキドキ）照樣覆蓋', () => {
    const text = { balloons: [balloon('b1', { 原文: 'ドキドキ', sfx: true })], looseText: [] };

    expect(ids(overlaidTexts(text))).toEqual(['b1']);
  });

  it('Loose Text：不是 Sound Effect 的覆蓋（角色自己的感嘆也算台詞）；Sound Effect、unreadable、OCR 信心低於門檻、還沒譯文的不覆蓋', () => {
    const text = {
      balloons: [],
      looseText: [
        loose('l1'),
        loose('l2', { 原文: 'ぱち', 譯文: '啪', sfx: true }),
        loose('l3', { unreadable: true, 譯文: '' }),
        // OCR 最低信心 < 0.25：analyze 已經標成 unreadable，LLM 讀得懂也維持（page-translation 合併時）
        loose('l4', { ocrConfidence: 0.1, unreadable: true }),
        loose('l5', { 譯文: '' }),
      ],
    };

    expect(ids(overlaidTexts(text))).toEqual(['l1']);
  });

  it('舊快取的 Loose Text 沒有 sfx：不覆蓋（維持以前的樣子，等重新翻譯）', () => {
    const text = { balloons: [], looseText: [loose('l1', { sfx: undefined })] };

    expect(ids(overlaidTexts(text))).toEqual([]);
  });
});

describe('withoutEraseData：備份不帶擦除資料', () => {
  it('Balloon 與 Loose Text 的擦除小圖都拿掉，其他欄位留著', () => {
    const erase = { box: rect, image: 'data:image/png;base64,AAAA' };
    const page = { balloons: [balloon('b1', { erase, eraseLuminance: 30 })], looseText: [loose('l1', { erase, eraseLuminance: 200 })] };

    const stripped = withoutEraseData(page);

    expect(stripped.balloons[0]).toEqual(balloon('b1', { eraseLuminance: 30 }));
    expect(stripped.looseText[0]).toEqual(loose('l1', { eraseLuminance: 200 }));
    expect(page.looseText[0]!.erase).toBe(erase);
  });
});
