/**
 * 認出 Practice Spread（#169）：Worker 只收得到 OCR 出來的文字（ADR 0006、ADR 0009），所以用文字認。
 * fixture 是真的 OCR 在試翻頁上跑出來的原文（practice-spread/ocr.json，wasm 與 WebGPU 各一份），每一頁各自比對。
 */

/** 每種執行環境跑出來的每一頁、每一句原文（依閱讀順序）。 */
export type PracticeSpreadText = Record<string, readonly (readonly string[])[]>;

/** 這一頁送來的句子、與 fixture 那一頁的句子，各要有這麼多對得上。 */
export const PAGE_MATCH_RATIO = 0.8;

/** 兩句正規化後的相似度到這裡就算同一句（OCR 差一兩個字）。 */
const SENTENCE_SIMILARITY = 0.75;

/** 去空白、全形半形統一（NFKC）。 */
const normalize = (text: string) => text.normalize('NFKC').replace(/\s/g, '');

function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const current = [i];
    for (let j = 1; j <= y.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[y.length]!;
}

function similar(a: string, b: string): boolean {
  if (a === b) return true;
  const length = Math.max([...a].length, [...b].length);
  return 1 - editDistance(a, b) / length >= SENTENCE_SIMILARITY;
}

/** 送來的句子幾乎就是 fixture 的這一頁：雙向各 8 成以上對得上（只送少數幾句、或混進太多別的文字都不算）。 */
function matchesPage(sentences: string[], page: readonly string[]): boolean {
  const expected = page.map(normalize).filter(Boolean);
  if (expected.length === 0) return false;
  const matched = sentences.filter((s) => expected.some((e) => similar(s, e))).length;
  const covered = expected.filter((e) => sentences.some((s) => similar(s, e))).length;
  return matched / sentences.length >= PAGE_MATCH_RATIO && covered / expected.length >= PAGE_MATCH_RATIO;
}

/** 一個 Page 的所有原文是不是 Practice Spread 的其中一頁。 */
export function isPracticeSpreadPage(texts: readonly string[], fixture: PracticeSpreadText): boolean {
  const sentences = texts.map(normalize).filter(Boolean);
  if (sentences.length === 0) return false;
  return Object.values(fixture).some((pages) => pages.some((page) => matchesPage(sentences, page)));
}
