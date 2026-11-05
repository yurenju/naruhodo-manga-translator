/**
 * 振り仮名（spec #27 第 8 節、prototype/sidepanel-ui 的 alignRuby）：把整句讀音用「漢字段／假名段」對齊回每段漢字。
 * 讀音是 kuromoji 推測的（ADR 0001），不是頁面上印的ルビ。
 */

export interface RubySegment {
  text: string;
  /** 只有漢字段有。 */
  rt?: string;
}

const KANJI = /[一-鿿々〆ヶ]/;
const SPACE = /\s/;
/** 寬鬆比對時再忽略標點符號（舊快取裡 LLM 給的讀音常把 !? … 拿掉）。只在嚴格比對失敗時用：標點也是段落的分界。 */
const SPACE_OR_PUNCT = /[\s\p{P}\p{S}]/u;

const kata2hira = (c: string) => (/[ァ-ヶ]/.test(c) ? String.fromCharCode(c.charCodeAt(0) - 0x60) : c);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Segment = { text: string; kanji: boolean };

function match(segments: Segment[], reading: string, ignored: RegExp): RubySegment[] | null {
  const strip = (s: string) => [...s].filter((c) => !ignored.test(c));
  // 讀音去掉忽略的字元後逐字（code point）對應原本的字；平假名化只是為了比對
  const kept = strip(reading);
  const nonKanji = segments.map((s) => (s.kanji ? [] : strip(s.text).map(kata2hira)));
  const pattern = segments.map((s, i) => (s.kanji ? '(.+?)' : escape(nonKanji[i]!.join('')))).join('');
  const m = new RegExp(`^${pattern}$`, 'u').exec(kept.map(kata2hira).join(''));
  if (!m) return null;
  let group = 1;
  let cursor = 0;
  return segments.map((s, i) => {
    if (!s.kanji) {
      cursor += nonKanji[i]!.length;
      return { text: s.text };
    }
    const length = [...m[group++]!].length;
    const rt = kept.slice(cursor, cursor + length).join('');
    cursor += length;
    return { text: s.text, rt };
  });
}

/**
 * 對上 → 每段（漢字段帶 rt，保留讀音原本的平假名／片假名）；沒有漢字 → 整句一段、沒有 rt；
 * 對不上（例如數字在讀音裡寫成假名）→ null，呼叫端退回顯示整句讀音。
 */
export function alignRuby(ja: string, reading: string): RubySegment[] | null {
  const segments: Segment[] = [];
  for (const c of ja) {
    const kanji = KANJI.test(c);
    const last = segments.at(-1);
    if (last && last.kanji === kanji) last.text += c;
    else segments.push({ text: c, kanji });
  }
  if (!segments.some((s) => s.kanji)) return [{ text: ja }];
  return match(segments, reading, SPACE) ?? match(segments, reading, SPACE_OR_PUNCT);
}

/** side panel 與頁面 tooltip 怎麼顯示一句：分段（漢字段帶ルビ），或對不上時原文＋整句讀音（fallback）。 */
export type RubyDisplay = { segments: RubySegment[] } | { fallback: string };

/** 沒有讀音＝原文一段、沒有ルビ；對不上＝fallback 整句讀音。 */
export function rubyDisplay(ja: string, reading: string): RubyDisplay {
  if (!reading) return { segments: [{ text: ja }] };
  const segments = alignRuby(ja, reading);
  return segments ? { segments } : { fallback: reading };
}