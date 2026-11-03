/**
 * 第 4 層（spec #27 第 12 節）：對合成頁 p02、p01 依序呼叫真的 Claude API，記錄延遲、token、費用。
 * 第 1 頁翻譯（①）後整理 Notes（②，ADR 0005），notes_changes 照 SW 的規則套用後（#37）第 2 頁帶著累積的 Notes
 * 與第 1 頁當 Prior Pages 送出，仍吃到 prompt cache（usage.cache_read_input_tokens > 0）：Notes 變了，
 * 固定的指示那段還是逐字相同。
 * `npm run smoke` 才會跑，key 由 op run 從 1Password 放進環境變數（#175）；沒有 key 時跳過並印出「已跳過」（不能算通過）。key 不印出。
 */
import { describe, expect, it } from 'vitest';
import { applyNotesChanges } from '../shared/series-notes.ts';
import type { TranslatedLine, TranslateInput } from '../shared/translator.ts';
import { readGroundTruth } from '../testing/synthetic.ts';
import { readTestApiKey, TEST_API_KEY_ENV } from '../testing/test-api-key.ts';
import { CLAUDE_MODEL, createClaudeTranslator, type ApiUsage } from './claude-translator.ts';

const apiKey = readTestApiKey();
if (!apiKey) console.log(`已跳過：沒有 ${TEST_API_KEY_ENV}（用 npm run smoke 跑）`);

const items = (id: string): TranslateInput['items'] =>
  readGroundTruth(id)
    .texts.sort((a, b) => a.order - b.order)
    .map((t, i) => ({ id: `t${i + 1}`, kind: t.kind === 'balloon' ? 'balloon' : 'loose', 原文: t.ja, orientation: t.orientation }));
/** 第 1 頁有人名與地名（「転校生の霧島湊です」），LLM 應該新增條目；第 2 頁帶著它們送出。 */
const page = items('p02-ruby');
const page2 = items('p01-basic');

describe.skipIf(!apiKey)('真的 Claude API（smoke）', () => {
  it('p02 → p01：Notes 從空的開始；回傳每一句的讀音與譯文；套用第 1 頁 ② 的 notes_changes 後第 2 頁仍吃到 prompt cache', { timeout: 120_000 }, async () => {
    const usages: ApiUsage[] = [];
    const translator = createClaudeTranslator({
      apiKey: apiKey!,
      async fetch(url, init) {
        const response = await fetch(url, init);
        if (response.ok) usages.push(((await response.clone().json()) as { usage: ApiUsage }).usage);
        return response;
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => performance.now(),
    });

    const first = await translator.translatePage({ seriesNotes: [], priorPages: [], items: page });
    const lines: TranslatedLine[] = first.items.flatMap((item, i) => (item.unreadable ? [] : [{ kind: page[i]!.kind, 原文: page[i]!.原文, 譯文: item.譯文 }]));
    const notes = await translator.proposeNotes({ seriesNotes: [], items: lines });
    const balloonTexts = page.filter((i) => i.kind === 'balloon').map((i) => i.原文);
    const accumulated = applyNotesChanges([], notes.notes_changes, { seriesId: 'smoke', pageHash: 'p02', balloonTexts });
    console.log('第 1 頁之後的 Notes', JSON.stringify(accumulated.entries.map(({ 原文, 譯文 }) => `${原文}→${譯文}`)));
    const second = await translator.translatePage({ seriesNotes: accumulated.entries, priorPages: [lines], items: page2 });

    for (const [i, output] of [first, notes, second].entries()) {
      const u = usages[i]!;
      console.log(
        `${['① 第 1 頁', '② 第 1 頁', '① 第 2 頁'][i]}：${output.model}、${(output.latencyMs / 1000).toFixed(2)} s、` +
          `input ${u.input_tokens}＋cache write ${u.cache_creation_input_tokens ?? 0}＋cache read ${u.cache_read_input_tokens ?? 0}、` +
          `output ${u.output_tokens}、$${output.usage.costUsd.toFixed(6)}`,
      );
    }
    console.log(first.items.map((item, i) => `${page[i]!.原文}（${item.讀音}）→ ${item.譯文}${item.unreadable ? ' [unreadable]' : ''}`).join('\n'));
    console.log('notes_changes', JSON.stringify(notes.notes_changes));

    expect(first.model).toBe(CLAUDE_MODEL);
    expect(first.items.map((i) => i.id)).toEqual(page.map((i) => i.id));
    for (const item of first.items) {
      expect(item.unreadable).toBe(false);
      expect(item.譯文).not.toBe('');
      expect(item.讀音).not.toBe('');
    }
    expect(first.usage.costUsd).toBeGreaterThan(0);
    expect(first.usage.costUsd).toBeLessThan(0.01);
    // 第 2 頁的 Notes 跟第 1 頁不同，固定的指示那段仍然 cache read
    expect(accumulated.entries.length).toBeGreaterThan(0);
    expect(usages[0]!.cache_creation_input_tokens! + usages[0]!.cache_read_input_tokens!).toBeGreaterThan(0);
    expect(second.usage.cacheReadTokens).toBeGreaterThan(0);
  });
});
