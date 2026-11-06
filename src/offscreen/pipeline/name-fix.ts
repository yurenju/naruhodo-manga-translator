/**
 * 用 Series Notes 已有的名字修 OCR 讀成的形近字（#228）：OCR 讀出的一段裡有一段字跟某個名字只差一個漢字，
 * 而且正確的字也是 OCR 那一步的候選，就換成名字。只看「差一個漢字」會把一般詞（例如「今日」）改成名字，
 * 所以候選字的條件不能省（#228 的離線實驗：30 次觸發裡 28 次誤改，加上候選字條件後 0 次）。
 */

/** OCR 解碼某一步的一個候選。 */
export interface Candidate {
  text: string;
  probability: number;
}

/** 修過的一處（字的位置以 code point 算）。 */
export interface NameFix {
  at: number;
  from: string;
  to: string;
  /** 換上的字在那一步的候選機率。 */
  probability: number;
}

/** 修過的一處，加上那段在 PageText 裡的 id（trace 用）。 */
export type SegmentNameFix = NameFix & { id: string };

/** 正確的字要在那一步的前幾名候選裡；OCR 解碼時每一步也只留這麼多名（ort-engine.ts）。 */
export const TOP_CANDIDATES = 3;
/** 正確的字在那一步的機率至少這麼高。 */
const MIN_CANDIDATE_PROBABILITY = 0.05;

const isKanji = (char: string | undefined) => char !== undefined && /\p{Script=Han}/u.test(char);

/** 名字從 at 開始對上 chars 的哪一個位置要換；不符合條件時 undefined。 */
function fixAt(chars: readonly string[], at: number, name: readonly string[], candidates: readonly (readonly Candidate[] | undefined)[]): NameFix | undefined {
  const differ = name.flatMap((char, k) => (chars[at + k] === char ? [] : [k]));
  if (differ.length !== 1) return undefined;
  const j = differ[0]!;
  const from = chars[at + j]!;
  const to = name[j]!;
  if (!isKanji(from) || !isKanji(to)) return undefined;
  // 名字其他位置至少有一個漢字對上，不能只靠假名對上
  if (!name.some((char, k) => k !== j && isKanji(char))) return undefined;
  const candidate = (candidates[at + j] ?? []).slice(0, TOP_CANDIDATES).find((c) => c.text === to);
  if (!candidate || candidate.probability < MIN_CANDIDATE_PROBABILITY) return undefined;
  return { at: at + j, from, to, probability: candidate.probability };
}

/**
 * text 裡跟 names 只差一個漢字、而且候選字也支持的地方換成名字。candidates 跟 text 的 code point 一一對應
 * （沒有候選的字是 undefined）。名字長度 < 2 或沒有漢字的不看。
 */
export function fixNames(text: string, candidates: readonly (readonly Candidate[] | undefined)[], names: readonly string[]): { text: string; fixes: NameFix[] } {
  const chars = [...text];
  const fixes: NameFix[] = [];
  for (const name of names.map((n) => [...n]).filter((n) => n.length >= 2 && n.some(isKanji))) {
    for (let at = 0; at + name.length <= chars.length; at++) {
      const fix = fixAt(chars, at, name, candidates);
      if (!fix) continue;
      chars[fix.at] = fix.to;
      fixes.push(fix);
    }
  }
  return { text: chars.join(''), fixes };
}
