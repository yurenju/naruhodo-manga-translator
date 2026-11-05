import { describe, expect, it } from 'vitest';
import {
  acceptSuggestion,
  addSuggestions,
  applyNotesChanges,
  editEntry,
  ignoreSuggestion,
  mergeImportedNotes,
  mergeNotes,
  pendingSuggestions,
  staleReason,
  type NotesSuggestion,
} from './series-notes.ts';
import type { NotesEntry } from './translator.ts';

const entry = (seriesId: string, 原文: string, 譯文: string, more: Partial<NotesEntry> = {}): NotesEntry => ({
  seriesId,
  原文,
  讀音: '',
  譯文,
  類別: '人名',
  locked: false,
  ...more,
});

describe('mergeNotes（只能新增）', () => {
  it('目標沒有的條目直接新增，改掛在目標 Series 下', () => {
    const result = mergeNotes([entry('t', '霧島湊', '霧島湊')], [entry('p', '潮見坂', '潮見坂', { 類別: '地名' })], {
      seriesId: 't',
      來源: { mergedFrom: 'p' },
    });

    expect(result.entries).toEqual([entry('t', '霧島湊', '霧島湊'), entry('t', '潮見坂', '潮見坂', { 類別: '地名' })]);
    expect(result.suggestions).toEqual([]);
  });

  it('同一個原文、譯文不同：保留目標的譯文，另一個變成建議修改', () => {
    const result = mergeNotes([entry('t', '相棒', '搭檔')], [entry('p', '相棒', '夥伴')], { seriesId: 't', 來源: { mergedFrom: 'p' } });

    expect(result.entries).toEqual([entry('t', '相棒', '搭檔')]);
    expect(result.suggestions).toEqual([{ seriesId: 't', 原文: '相棒', 建議譯文: '夥伴', 來源: { mergedFrom: 'p' } }]);
  });

  it('同一個原文、譯文相同：不產生建議', () => {
    const result = mergeNotes([entry('t', '相棒', '搭檔')], [entry('p', '相棒', '搭檔')], { seriesId: 't', 來源: { mergedFrom: 'p' } });

    expect(result.suggestions).toEqual([]);
  });

  it('既有條目的空欄位可以補上，有值的欄位不動', () => {
    const result = mergeNotes(
      [entry('t', '兄ちゃん', '哥', { 讀音: '' })],
      [entry('p', '兄ちゃん', '哥', { 讀音: 'にいちゃん', 類別: '用語', 備註: '湊叫哥哥' })],
      { seriesId: 't', 來源: { mergedFrom: 'p' } },
    );

    expect(result.entries).toEqual([entry('t', '兄ちゃん', '哥', { 讀音: 'にいちゃん', 備註: '湊叫哥哥' })]);
  });

  it('既有條目的譯文是空的：直接補上，不變成建議', () => {
    const result = mergeNotes([entry('t', '潮見坂', '', { 類別: '地名' })], [entry('p', '潮見坂', '潮見坂', { 類別: '地名' })], {
      seriesId: 't',
      來源: { mergedFrom: 'p' },
    });

    expect(result.entries).toEqual([entry('t', '潮見坂', '潮見坂', { 類別: '地名' })]);
    expect(result.suggestions).toEqual([]);
  });

  it('人改過（locked）的條目不補欄位，譯文不同仍然變成建議', () => {
    const locked = entry('t', 'ミオ', '美緒', { locked: true });
    const result = mergeNotes([locked], [entry('p', 'ミオ', '米歐', { 讀音: 'みお' })], { seriesId: 't', 來源: { mergedFrom: 'p' } });

    expect(result.entries).toEqual([locked]);
    expect(result.suggestions).toEqual([{ seriesId: 't', 原文: 'ミオ', 建議譯文: '米歐', 來源: { mergedFrom: 'p' } }]);
  });
});

describe('applyNotesChanges（套用 LLM 的 notes_changes）', () => {
  const page = { seriesId: 's', pageHash: 'h1', balloonTexts: ['ミナちゃん、待って！', '潮見坂まで走るよ'] };
  const none = { added: [], filled: [], suggestions: [] };
  const added = (原文: string, 譯文: string, more: Partial<NotesEntry> = {}) => ({ 原文, 讀音: '', 譯文, 類別: '人名', ...more });

  it('原文出現在這頁某個 Balloon 裡的新條目直接加進 Notes（未 locked）', () => {
    const result = applyNotesChanges([], { ...none, added: [added('ミナ', '美娜')] }, page);

    expect(result.entries).toEqual([entry('s', 'ミナ', '美娜')]);
    expect(result.suggestions).toEqual([]);
  });

  it('原文不在任何 Balloon 裡（例如封面上 OCR 讀錯的標題）不採用', () => {
    const result = applyNotesChanges([], { ...none, added: [added('魔法少女ミチ', '魔法少女美琪', { 類別: '用語' })] }, page);

    expect(result.entries).toEqual([]);
  });

  it('filled 只補既有條目的空欄位；Notes 裡沒有的原文不會因此新增', () => {
    const result = applyNotesChanges(
      [entry('s', 'ミナ', '美娜', { 讀音: '' })],
      { ...none, filled: [{ 原文: 'ミナ', fields: { 讀音: 'みな', 備註: '主角' } }, { 原文: '潮見坂', fields: { 讀音: 'しおみざか' } }] },
      page,
    );

    expect(result.entries).toEqual([entry('s', 'ミナ', '美娜', { 讀音: 'みな', 備註: '主角' })]);
  });

  it('LLM 不填自稱、語氣、稱呼（ADR 0005）：新增與補空欄位裡的這三個欄位都不採用', () => {
    const result = applyNotesChanges(
      [entry('s', 'ミナ', '美娜')],
      {
        ...none,
        added: [added('潮見坂', '潮見坡', { 類別: '地名', 自稱: '僕' })],
        filled: [{ 原文: 'ミナ', fields: { 自稱: 'あたし', 語氣: '活潑', 稱呼: '湊くん', 讀音: 'みな' } }],
      },
      page,
    );

    expect(result.entries).toEqual([entry('s', 'ミナ', '美娜', { 讀音: 'みな' }), entry('s', '潮見坂', '潮見坡', { 類別: '地名' })]);
  });

  it('suggestions 變成帶來源 Page 的建議修改，條目本身不動；Notes 裡沒有的原文或譯文相同的建議不算', () => {
    const notes = [entry('s', 'ミナ', '美娜')];
    const result = applyNotesChanges(
      notes,
      {
        ...none,
        suggestions: [
          { 原文: 'ミナ', 建議譯文: '米娜', 理由: '音較接近' },
          { 原文: 'ミナ', 建議譯文: '美娜' },
          { 原文: '潮見坂', 建議譯文: '潮見坡' },
        ],
      },
      page,
    );

    expect(result.entries).toEqual(notes);
    expect(result.suggestions).toEqual([{ seriesId: 's', 原文: 'ミナ', 建議譯文: '米娜', 理由: '音較接近', 來源: { pageHash: 'h1' } }]);
  });

  it('同一個原文先到先贏：再次新增不同譯文不覆蓋，變成建議修改', () => {
    const result = applyNotesChanges([entry('s', 'ミナ', '美娜')], { ...none, added: [added('ミナ', '米娜')] }, page);

    expect(result.entries).toEqual([entry('s', 'ミナ', '美娜')]);
    expect(result.suggestions).toEqual([{ seriesId: 's', 原文: 'ミナ', 建議譯文: '米娜', 來源: { pageHash: 'h1' } }]);
  });

  it('人改過（locked）的條目：空欄位也不補', () => {
    const locked = entry('s', 'ミナ', '美娜', { locked: true });
    const result = applyNotesChanges(
      [locked],
      { ...none, added: [added('ミナ', '美娜', { 讀音: 'みな' })], filled: [{ 原文: 'ミナ', fields: { 語氣: '活潑' } }] },
      page,
    );

    expect(result.entries).toEqual([locked]);
  });

  it('回報沒採用的新增：原文不在 Balloon 裡（rejected）、同一個 Spread 先套用的頁剛新增而這頁看不到、譯名不同（dropped）', () => {
    const result = applyNotesChanges(
      [entry('s', 'ミナ', '美娜')],
      { ...none, added: [added('ミナ', '米娜'), added('潮見坂', '潮見坡'), added('魔法少女ミチ', '魔法少女美琪')] },
      { ...page, unseen: new Set(['ミナ']) },
    );

    expect(result.rejected).toEqual(['魔法少女ミチ']);
    expect(result.dropped).toEqual([{ 原文: 'ミナ', 譯文: '米娜' }]);
    expect(result.suggestions).toEqual([]);
  });

  it('既有人名加上敬稱（〜ちゃん、〜君…）不當成新條目（#64）', () => {
    const result = applyNotesChanges([entry('s', 'ミナ', '美娜')], { ...none, added: [added('ミナちゃん', '小美娜')] }, page);

    expect(result.entries).toEqual([entry('s', 'ミナ', '美娜')]);
    expect(result.suggestions).toEqual([]);
    expect(result.rejected).toEqual(['ミナちゃん']);
  });

  it('原文只是既有條目的讀音（換成假名寫法）也不當成新條目（#64）', () => {
    const notes = [entry('s', '潮見坂', '潮見坡', { 讀音: 'しおみざか', 類別: '地名' })];
    const result = applyNotesChanges(notes, { ...none, added: [added('しおみざか', '潮見坡', { 類別: '地名' })] }, {
      ...page,
      balloonTexts: ['しおみざかまで走るよ'],
    });

    expect(result.entries).toEqual(notes);
    expect(result.rejected).toEqual(['しおみざか']);
  });

  it('讀音換成片假名寫法也算既有條目（#64）', () => {
    const notes = [entry('s', '潮見坂', '潮見坡', { 讀音: 'しおみざか', 類別: '地名' })];
    const result = applyNotesChanges(notes, { ...none, added: [added('シオミザカ', '潮見坡', { 類別: '地名' })] }, {
      ...page,
      balloonTexts: ['シオミザカまで走るよ'],
    });

    expect(result.entries).toEqual(notes);
  });

  it('同一次回應裡同時新增人名與人名＋敬稱：只採用人名（#64）', () => {
    const result = applyNotesChanges([], { ...none, added: [added('ミナ', '美娜'), added('ミナちゃん', '小美娜')] }, page);

    expect(result.entries).toEqual([entry('s', 'ミナ', '美娜')]);
    expect(result.rejected).toEqual(['ミナちゃん']);
  });

  it('新條目的譯文是空的（或只有空白）不採用：沒有譯名可以讓之後的頁統一（#64）', () => {
    const blank = applyNotesChanges([], { ...none, added: [added('ミナ', '　')] }, page);
    expect(blank.entries).toEqual([]);

    const result = applyNotesChanges([], { ...none, added: [added('潮見坂', '', { 類別: '地名' })] }, page);

    expect(result.entries).toEqual([]);
    expect(result.rejected).toEqual(['潮見坂']);
  });

  it('原文是空字串的條目不採用', () => {
    const result = applyNotesChanges([], { ...none, added: [added('', '某人')] }, page);

    expect(result.entries).toEqual([]);
  });
});

describe('editEntry（人在 side panel 修正條目）', () => {
  it('改過的欄位寫進條目並設成 locked；其他條目不動', () => {
    const notes = [entry('s', 'ミナ', '美娜', { 讀音: 'みな' }), entry('s', '潮見坂', '潮見坂', { 類別: '地名' })];

    const result = editEntry(notes, 'ミナ', { 譯文: '米娜', 讀音: '' });

    expect(result).toEqual([entry('s', 'ミナ', '米娜', { 讀音: '', locked: true }), notes[1]]);
  });
});

describe('建議修改（去重、接受、忽略）', () => {
  const suggestion = (原文: string, 建議譯文: string, more: Partial<NotesSuggestion> = {}): NotesSuggestion => ({
    seriesId: 's',
    原文,
    建議譯文,
    來源: { pageHash: 'h1' },
    ...more,
  });

  it('addSuggestions：同一個原文＋建議譯文已經有了（含忽略過的）就不再加，同一批裡重複的也只留一個', () => {
    const existing = [suggestion('ミナ', '米娜'), suggestion('相棒', '夥伴', { ignored: true })];

    const result = addSuggestions(existing, [
      suggestion('ミナ', '米娜', { 來源: { pageHash: 'h2' } }),
      suggestion('相棒', '夥伴', { 來源: { pageHash: 'h2' } }),
      suggestion('ミナ', '蜜娜', { 來源: { pageHash: 'h2' } }),
      suggestion('ミナ', '蜜娜', { 來源: { pageHash: 'h3' } }),
    ]);

    expect(result).toEqual([...existing, suggestion('ミナ', '蜜娜', { 來源: { pageHash: 'h2' } })]);
  });

  it('pendingSuggestions：只列沒忽略、條目還在、而且跟目前譯文不同的', () => {
    const notes = {
      entries: [entry('s', 'ミナ', '米娜'), entry('s', '相棒', '搭檔')],
      suggestions: [suggestion('ミナ', '米娜'), suggestion('相棒', '夥伴', { ignored: true }), suggestion('潮見坂', '潮見坡'), suggestion('相棒', '拍檔')],
    };

    expect(pendingSuggestions(notes)).toEqual([suggestion('相棒', '拍檔')]);
  });

  it('acceptSuggestion：條目改成建議譯文並 locked，這個建議（含重複的）拿掉，其他留著', () => {
    const notes = {
      entries: [entry('s', '相棒', '搭檔')],
      suggestions: [suggestion('相棒', '夥伴'), suggestion('相棒', '夥伴', { 來源: { pageHash: 'h2' } }), suggestion('相棒', '拍檔')],
    };

    expect(acceptSuggestion(notes, { 原文: '相棒', 建議譯文: '夥伴' })).toEqual({
      entries: [entry('s', '相棒', '夥伴', { locked: true })],
      suggestions: [suggestion('相棒', '拍檔')],
    });
  });

  it('ignoreSuggestion：條目不動，這個建議標成忽略（之後同樣的建議不會再出現）', () => {
    const notes = { entries: [entry('s', '相棒', '搭檔')], suggestions: [suggestion('相棒', '夥伴'), suggestion('相棒', '拍檔')] };

    expect(ignoreSuggestion(notes, { 原文: '相棒', 建議譯文: '夥伴' })).toEqual({
      entries: notes.entries,
      suggestions: [suggestion('相棒', '夥伴', { ignored: true }), suggestion('相棒', '拍檔')],
    });
  });
});

describe('staleReason（過時提示）', () => {
  const page = { usedNotes: [{ 原文: 'パン', 譯文: '麵包' }], model: 'claude-haiku-5-5', promptVersion: 'v2' };
  const current = { model: 'claude-haiku-5-5', promptVersion: 'v2' };

  it('用到的條目都沒改、模型與 prompt 版本相同：不過時', () => {
    expect(staleReason(page, [entry('s', 'パン', '麵包')], current)).toBeUndefined();
  });

  it('只新增條目（就算原文出現在這頁）不算過時', () => {
    expect(staleReason(page, [entry('s', 'パン', '麵包'), entry('s', 'お店', '店')], current)).toBeUndefined();
  });

  it('這頁用到的條目譯文被改了：notes', () => {
    expect(staleReason(page, [entry('s', 'パン', '胖', { locked: true })], current)).toBe('notes');
  });

  it('用到的條目當時譯文是空的、之後 LLM 翻別頁時補上：算新增，不過時', () => {
    const blank = { ...page, usedNotes: [{ 原文: 'パン', 譯文: '' }] };
    expect(staleReason(blank, [entry('s', 'パン', '麵包')], current)).toBeUndefined();
  });

  it('用到的條目當時譯文是空的、之後人補上（locked）：notes', () => {
    const blank = { ...page, usedNotes: [{ 原文: 'パン', 譯文: '' }] };
    expect(staleReason(blank, [entry('s', 'パン', '麵包', { locked: true })], current)).toBe('notes');
  });

  it('只改了用到的條目的其他欄位（譯文沒變）不算過時', () => {
    expect(staleReason(page, [entry('s', 'パン', '麵包', { 讀音: 'ぱん', locked: true })], current)).toBeUndefined();
  });

  it('模型或 prompt 版本不同：version；不知道目前的版本（沒有 API key）就不比', () => {
    const entries = [entry('s', 'パン', '麵包')];
    expect(staleReason(page, entries, { ...current, model: 'claude-sonnet-5-5' })).toBe('version');
    expect(staleReason(page, entries, { ...current, promptVersion: 'v3' })).toBe('version');
    expect(staleReason(page, entries, undefined)).toBeUndefined();
  });

  it('快取的 prompt 版本列在目前版本的相容版本裡（例如只拿掉讀音，#195）：不過時；其他舊版本照樣 version', () => {
    const entries = [entry('s', 'パン', '麵包')];
    const v3 = { ...current, promptVersion: 'v3', compatiblePromptVersions: ['v2'] };
    expect(staleReason(page, entries, v3)).toBeUndefined();
    expect(staleReason({ ...page, promptVersion: 'v1' }, entries, v3)).toBe('version');
  });
});

describe('mergeImportedNotes（匯入，本機優先）', () => {
  it('本機沒有的條目照原樣加進來（含 locked）；譯文衝突保留本機的，匯入的變成建議；匯入檔的建議去重後加進來', () => {
    const local = {
      entries: [entry('s', '相棒', '搭檔')],
      suggestions: [{ seriesId: 's', 原文: '相棒', 建議譯文: '拍檔', 來源: { pageHash: 'h1' } }],
    };
    const incoming = {
      entries: [entry('s', '相棒', '夥伴'), entry('s', 'ミナ', '美娜', { locked: true })],
      suggestions: [
        { seriesId: 's', 原文: '相棒', 建議譯文: '拍檔', 來源: { pageHash: 'h9' } },
        { seriesId: 's', 原文: 'ミナ', 建議譯文: '米娜', 來源: { pageHash: 'h9' }, ignored: true as const },
      ],
    };

    expect(mergeImportedNotes(local, incoming, 's')).toEqual({
      entries: [entry('s', '相棒', '搭檔'), entry('s', 'ミナ', '美娜', { locked: true })],
      suggestions: [
        local.suggestions[0],
        { seriesId: 's', 原文: 'ミナ', 建議譯文: '米娜', 來源: { pageHash: 'h9' }, ignored: true },
        { seriesId: 's', 原文: '相棒', 建議譯文: '夥伴', 來源: { imported: true } },
      ],
    });
  });
});
