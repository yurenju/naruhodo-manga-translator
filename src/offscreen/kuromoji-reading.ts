/**
 * 讀音（ADR 0001、#195）：kuromoji.js，有沒有 API key、走哪條翻譯路徑都用它。多音字與助數詞的音便可能讀錯。
 * 字典打包在外掛的 kuromoji/dict/，用 XHR 載入（offscreen 有 XHR，SW 沒有）。
 */
import kuromoji from 'kuromoji';

const toHiragana = (s: string) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

let tokenizer: Promise<kuromoji.Tokenizer<kuromoji.IpadicFeatures>> | undefined;

function loadTokenizer(dicPath: string): Promise<kuromoji.Tokenizer<kuromoji.IpadicFeatures>> {
  tokenizer ??= new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath }).build((err, t) => (err ? reject(err) : resolve(t)));
  });
  tokenizer.catch(() => {
    tokenizer = undefined;
  });
  return tokenizer;
}

/** 回傳「原文 → 整句平假名」的函式。 */
export async function createKuromojiReading(dicPath: string): Promise<(ja: string) => string> {
  const t = await loadTokenizer(dicPath);
  return (ja) =>
    t
      .tokenize(ja)
      .map((token) => (token.reading && token.reading !== '*' ? toHiragana(token.reading) : token.surface_form))
      .join('');
}
