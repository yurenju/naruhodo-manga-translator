import { describe, expect, it } from 'vitest';
import { readGroundTruth } from '../testing/synthetic.ts';
import { createFakeTranslator, NO_MATCH } from './fake-translator.ts';

const translator = createFakeTranslator([readGroundTruth('p01-basic'), readGroundTruth('p04-outside')]);

describe('FakeTranslator', () => {
  it('依原文找到合成頁 ground truth，回傳它的讀音與譯文，ground truth 的狀聲詞回 sfx；OCR 錯一兩個字也找得到', async () => {
    const output = await translator.translatePage({
      seriesNotes: [],
      priorPages: [],
      items: [
        { id: 'b1', kind: 'balloon', 原文: 'おはよう！今日は早いね', orientation: 'vertical' },
        // OCR 把「行」讀錯、少了「？」
        { id: 'b2', kind: 'balloon', 原文: '一緒に行ってもいい', orientation: 'vertical' },
        { id: 'l1', kind: 'loose', 原文: 'ハァ…ハァ…', orientation: 'vertical' },
        { id: 'l2', kind: 'loose', 原文: 'ドドドド', orientation: 'vertical' },
      ],
    });

    expect(output.items).toEqual([
      { id: 'b1', 讀音: 'おはよう！きょうははやいね', 譯文: '早安！今天好早喔', unreadable: false, sfx: false },
      { id: 'b2', 讀音: 'いっしょにいってもいい？', 譯文: '我可以一起去嗎？', unreadable: false, sfx: false },
      { id: 'l1', 讀音: 'ハァ…ハァ…', 譯文: '（喘氣）哈…哈…', unreadable: false, sfx: false },
      { id: 'l2', 讀音: 'ドドドド', 譯文: '（跑步聲）咚咚咚咚', unreadable: false, sfx: true },
    ]);
  });

  it('找不到對應的原文時回傳固定字串', async () => {
    const output = await translator.translatePage({
      seriesNotes: [],
      priorPages: [],
      items: [{ id: 'x', kind: 'balloon', 原文: '全然関係ない文章です', orientation: 'vertical' }],
    });

    expect(output.items).toEqual([{ id: 'x', 讀音: '', 譯文: NO_MATCH, unreadable: false, sfx: false }]);
  });

  it('設定了 notes：proposeNotes 把 Balloon 原文裡出現、送來的 Notes 還沒有的條目回傳成 notes_changes.added', async () => {
    const パン = { 原文: 'パン', 讀音: 'ぱん', 譯文: '麵包', 類別: '用語' };
    const 朝 = { 原文: '朝', 讀音: 'あさ', 譯文: '早上', 類別: '用語' };
    const withNotes = createFakeTranslator([readGroundTruth('p01-basic')], { notes: [パン, 朝] });
    const items = [
      { kind: 'balloon' as const, 原文: 'うん、パンを買いに行くんだ', 譯文: '嗯，我要去買麵包' },
      { kind: 'loose' as const, 原文: '朝七時', 譯文: '早上七點' },
    ];

    const first = await withNotes.proposeNotes({ seriesNotes: [], items });
    const again = await withNotes.proposeNotes({ seriesNotes: [{ ...パン, seriesId: 's', locked: false }], items });

    expect(first.notes_changes.added).toEqual([パン]);
    expect(again.notes_changes.added).toEqual([]);
  });

  it('設定的條目已經在 Notes 裡：空欄位回傳成 filled，譯文不同回傳成建議修改（#38：模擬 LLM 想改人改過的條目）', async () => {
    const パン = { 原文: 'パン', 讀音: 'ぱん', 譯文: '麵包', 類別: '用語' };
    const withNotes = createFakeTranslator([readGroundTruth('p01-basic')], { notes: [パン] });
    const items = [{ kind: 'balloon' as const, 原文: 'うん、パンを買いに行くんだ', 譯文: '嗯，我要去買胖' }];

    const output = await withNotes.proposeNotes({ seriesNotes: [{ ...パン, 讀音: '', 譯文: '胖', seriesId: 's', locked: true }], items });

    expect(output.notes_changes).toEqual({
      added: [],
      filled: [{ 原文: 'パン', fields: { 讀音: 'ぱん' } }],
      suggestions: [{ 原文: 'パン', 建議譯文: '麵包' }],
    });
  });

  it('不花錢、不改 Series Notes', async () => {
    const output = await translator.translatePage({ seriesNotes: [], priorPages: [], items: [] });
    const notes = await translator.proposeNotes({ seriesNotes: [], items: [] });

    expect(output.usage.costUsd).toBe(0);
    expect(notes.notes_changes).toEqual({ added: [], filled: [], suggestions: [] });
    expect(output.model).toBe('fake');
  });
});

describe('FakeTranslator：模擬無法辨識', () => {
  it('指定的 ground truth 原文回傳 unreadable，讀音與譯文留空', async () => {
    const fake = createFakeTranslator([readGroundTruth('p01-basic')], { unreadableTexts: ['もちろん！'] });

    const output = await fake.translatePage({
      seriesNotes: [],
      priorPages: [],
      items: [
        { id: 'b1', kind: 'balloon', 原文: 'もちろん', orientation: 'vertical' },
        { id: 'b2', kind: 'balloon', 原文: 'いいにおい！', orientation: 'vertical' },
      ],
    });

    expect(output.items).toEqual([
      { id: 'b1', 讀音: '', 譯文: '', unreadable: true, sfx: false },
      { id: 'b2', 讀音: 'いいにおい！', 譯文: '好香！', unreadable: false, sfx: false },
    ]);
  });
});
