import { describe, expect, it } from 'vitest';
import recorded from '../../practice-spread/ocr.json' with { type: 'json' };
import { isPracticeSpreadPage, type PracticeSpreadText } from './practice-spread.ts';

/** 兩種 OCR 各跑出兩頁（右頁、左頁），句子跟真的 fixture 一樣是 OCR 原樣的文字。 */
const fixture: PracticeSpreadText = {
  wasm: [
    ['おはよう、湊くん！', '今日は早いね', 'パン屋に行こうよ', 'えっ？', '新しいパンが出たんだって'],
    ['いらっしゃいませ！', 'メロンパンをください', 'はい、二百円です', 'ありがとう！'],
  ],
  webgpu: [
    ['おはよう、湊くん!', '今日は早いね', 'パン屋に行こうよ', 'えっ?', '新しいパンが出たんだって'],
    ['いらっしゃいませ!', 'メロンパンをください', 'はい、二百円です', 'ありがとう!'],
  ],
};

const rightPage = fixture.wasm![0]!;

describe('認出 Practice Spread 的一頁', () => {
  it('跟 fixture 的一頁完全相同', () => {
    expect(isPracticeSpreadPage(rightPage, fixture)).toBe(true);
  });

  it('全形半形、空白不同也算相同', () => {
    expect(isPracticeSpreadPage(['おはよう, 湊くん!', '今日は 早いね', 'パン屋に行こうよ', 'えっ?', '新しいパンが出たんだって'], fixture)).toBe(true);
  });

  it('幾句差一兩個字（OCR 的誤差）仍然算', () => {
    expect(isPracticeSpreadPage(['おはよう、湊くん！', '今日は早いぬ', 'パン屋に行こうよ', 'えっ？', '新しいパソが出たんだって'], fixture)).toBe(true);
  });

  it('句子的順序不同也算（閱讀順序可能不一樣）', () => {
    expect(isPracticeSpreadPage([...rightPage].reverse(), fixture)).toBe(true);
  });

  it('少了一句（OCR 漏掉一個對話框），8 成以上仍對得上就算', () => {
    expect(isPracticeSpreadPage(rightPage.slice(0, 4), fixture)).toBe(true);
  });

  it('多了一句對不上的，8 成以上仍對得上就算', () => {
    expect(isPracticeSpreadPage([...rightPage, 'ドン'], fixture)).toBe(true);
  });

  it('對不上的句子超過 2 成就不算', () => {
    expect(isPracticeSpreadPage([...rightPage, '全然違う文章です', 'これも違う'], fixture)).toBe(false);
  });

  it('只送 fixture 一頁裡的少數句子不算（不能拿幾句就免費翻）', () => {
    expect(isPracticeSpreadPage(['パン屋に行こうよ', '今日は早いね'], fixture)).toBe(false);
  });

  it('兩頁的句子混在一起不算任何一頁', () => {
    expect(isPracticeSpreadPage([...rightPage.slice(0, 3), ...fixture.wasm![1]!.slice(0, 3)], fixture)).toBe(false);
  });

  it('普通漫畫的文字不算', () => {
    expect(isPracticeSpreadPage(['今日の給食はカレーだ！', 'なんだと！？', 'ふざけるな'], fixture)).toBe(false);
  });

  it('沒有文字的頁不算', () => {
    expect(isPracticeSpreadPage([], fixture)).toBe(false);
    expect(isPracticeSpreadPage(['', ' '], fixture)).toBe(false);
  });
});

describe('真的 OCR 結果（practice-spread/ocr.json）', () => {
  // 讀者的螢幕大小與執行環境各不相同：每一種跑法拿掉自己之後，其他跑法錄下的仍認得出它的每一頁
  for (const [key, pages] of Object.entries(recorded)) {
    it(`${key} 的每一頁，用其他跑法的結果認得出來`, () => {
      const others = Object.fromEntries(Object.entries(recorded).filter(([k]) => k !== key));
      for (const page of pages) expect(isPracticeSpreadPage(page, others)).toBe(true);
    });
  }
});
