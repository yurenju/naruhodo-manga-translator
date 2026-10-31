/**
 * e2e 用的 Translator（spec #27 第 12 節）：回傳合成頁 ground truth 的讀音與譯文，不花錢、結果固定、不需要 API key。
 * TranslateInput 沒有座標，所以用原文相似度（1 − 字元編輯距離 / 長度）把 OCR 結果對回 ground truth。
 */
import { normalizeText } from './series-notes.ts';
import type { NotesChanges, NotesInput, NotesOutput, TranslateInput, TranslateOutput, Translator } from './translator.ts';

/** FakeTranslator 的模型與 prompt 版本（寫進快取、過時提示比對用）。 */
export const FAKE_VERSION = { model: 'fake', promptVersion: 'fake' };

/** 找不到對應的 ground truth 時的譯文。 */
export const NO_MATCH = '（FakeTranslator：找不到對應的原文）';

/** 相似度至少這麼高才算同一句。 */
const MIN_SIMILARITY = 0.5;

export interface GroundTruthText {
  ja: string;
  reading: string;
  zh: string;
  /** 合成頁 ground truth 的種類；'sfx' 的回 sfx: true（模擬 LLM 判斷 Sound Effect）。 */
  kind?: string;
}

function levenshtein(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

function similarity(a: string, b: string): number {
  const x = [...normalizeText(a)];
  const y = [...normalizeText(b)];
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length, 1);
}

export interface FakeTranslatorOptions {
  /** 這些 ground truth 原文回傳 unreadable（模擬 Claude 判定 OCR 亂碼）。 */
  unreadableTexts?: readonly string[];
  /** 這些條目在某頁的 Balloon 原文裡出現、而且送來的 Notes 還沒有時，當成那頁新增的條目由 proposeNotes 回傳（#37 的 e2e）。 */
  notes?: NotesChanges['added'];
}

/**
 * 設定的條目出現在這頁的 Balloon 裡時：Notes 還沒有就新增；已經有了就把空欄位補上（filled），
 * 譯文不同就提建議（#38：模擬 LLM 想改人改過的條目）。
 */
function notesChanges(notes: NotesChanges['added'], input: NotesInput): NotesChanges {
  const changes: NotesChanges = { added: [], filled: [], suggestions: [] };
  for (const n of notes) {
    if (!input.items.some((i) => i.kind === 'balloon' && normalizeText(i.原文).includes(normalizeText(n.原文)))) continue;
    const existing = input.seriesNotes.find((e) => e.原文 === n.原文);
    if (!existing) {
      changes.added.push(n);
      continue;
    }
    const fields = Object.fromEntries(Object.entries(n).filter(([key, value]) => key !== '原文' && key !== '譯文' && value && !existing[key as keyof typeof n]));
    if (Object.keys(fields).length > 0) changes.filled.push({ 原文: n.原文, fields });
    if (existing.譯文 && existing.譯文 !== n.譯文) changes.suggestions.push({ 原文: n.原文, 建議譯文: n.譯文 });
  }
  return changes;
}

const NO_COST = { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }, model: FAKE_VERSION.model, latencyMs: 0 };

export function createFakeTranslator(
  pages: readonly { texts: readonly GroundTruthText[] }[],
  { unreadableTexts = [], notes = [] }: FakeTranslatorOptions = {},
): Translator {
  const texts = pages.flatMap((p) => p.texts);
  const unreadable = new Set(unreadableTexts);
  return {
    async translatePage(input: TranslateInput): Promise<TranslateOutput> {
      return {
        items: input.items.map((item) => {
          let best: GroundTruthText | undefined;
          let bestScore = MIN_SIMILARITY;
          for (const text of texts) {
            const score = similarity(item.原文, text.ja);
            if (score >= bestScore) {
              best = text;
              bestScore = score;
            }
          }
          if (best && unreadable.has(best.ja)) return { id: item.id, 讀音: '', 譯文: '', unreadable: true, sfx: false };
          return best
            ? { id: item.id, 讀音: best.reading, 譯文: best.zh, unreadable: false, sfx: best.kind === 'sfx' }
            : { id: item.id, 讀音: '', 譯文: NO_MATCH, unreadable: false, sfx: false };
        }),
        ...NO_COST,
      };
    },
    async proposeNotes(input: NotesInput): Promise<NotesOutput> {
      return { notes_changes: notesChanges(notes, input), ...NO_COST };
    },
  };
}
