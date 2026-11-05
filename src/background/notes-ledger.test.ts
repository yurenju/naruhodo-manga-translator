import { describe, expect, it } from 'vitest';
import { editEntry, type SeriesNotes } from '../shared/series-notes.ts';
import type { NotesChanges, NotesEntry } from '../shared/translator.ts';
import { createNotesLedger, type NotesStore } from './notes-ledger.ts';

const note = (原文: string, 譯文: string, more: Partial<NotesEntry> = {}): NotesEntry => ({
  seriesId: 's',
  原文,
  讀音: '',
  譯文,
  類別: '用語',
  locked: false,
  ...more,
});

const noChanges = (): NotesChanges => ({ added: [], filled: [], suggestions: [] });

/** 記憶體裡的 Notes；每次讀寫都隔一個 tick，像 IndexedDB 一樣會跟別的操作交錯。 */
function memoryStore(initial: NotesEntry[] = []): NotesStore & { state: SeriesNotes; saves: number } {
  const tick = () => new Promise((resolve) => setTimeout(resolve));
  const store = {
    state: { entries: structuredClone(initial), suggestions: [], excluded: [] } as SeriesNotes,
    saves: 0,
    async list() {
      await tick();
      return structuredClone(store.state.entries);
    },
    async load() {
      await tick();
      return structuredClone(store.state);
    },
    async save(_seriesId: string, notes: SeriesNotes) {
      await tick();
      store.saves++;
      store.state = structuredClone(notes);
    },
  };
  return store;
}

const page = { pageHash: 'h1', balloonTexts: ['パンを買いに行く'] };

describe('notes-ledger：人的編輯與 LLM 的變更', () => {
  it('LLM 還在翻的時候人改了條目：編輯不必等 LLM，之後套用的變更不會蓋掉它，只會變成建議', async () => {
    const store = memoryStore([note('パン', '麵包')]);
    const ledger = createNotesLedger({ store });

    const turn = ledger.checkout('s');
    await turn.notes;
    await ledger.update('s', (notes) => ({ ...notes, entries: editEntry(notes.entries, 'パン', { 譯文: '胖', 讀音: '' }) }));
    expect(store.state.entries).toEqual([note('パン', '胖', { locked: true })]);

    await turn.commit(
      { ...noChanges(), filled: [{ 原文: 'パン', fields: { 讀音: 'ぱん' } }], suggestions: [{ 原文: 'パン', 建議譯文: '麵包' }] },
      page,
    );

    expect(store.state.entries).toEqual([note('パン', '胖', { locked: true })]);
    expect(store.state.suggestions).toEqual([{ seriesId: 's', 原文: 'パン', 建議譯文: '麵包', 來源: { pageHash: 'h1' } }]);
  });

  it('同時進行的編輯與套用不會互相蓋掉', async () => {
    const store = memoryStore([note('パン', '麵包'), note('お店', '')]);
    const ledger = createNotesLedger({ store });

    const turn = ledger.checkout('s');
    await Promise.all([
      turn.commit({ ...noChanges(), filled: [{ 原文: 'お店', fields: { 譯文: '店' } }] }, { ...page, balloonTexts: ['お店'] }),
      ledger.update('s', (notes) => ({ ...notes, entries: editEntry(notes.entries, 'パン', { 譯文: '胖' }) })),
    ]);

    expect(store.state.entries).toEqual([note('パン', '胖', { locked: true }), note('お店', '店')]);
  });

  it('同一個建議每頁都再提一次也只存一個', async () => {
    const store = memoryStore([note('パン', '麵包')]);
    const ledger = createNotesLedger({ store });
    const suggest = { ...noChanges(), suggestions: [{ 原文: 'パン', 建議譯文: '胖' }] };

    await ledger.checkout('s').commit(suggest, page);
    await ledger.checkout('s').commit(suggest, { ...page, pageHash: 'h2' });

    expect(store.state.suggestions).toEqual([{ seriesId: 's', 原文: 'パン', 建議譯文: '胖', 來源: { pageHash: 'h1' } }]);
  });

  it('Excluded Term（#214）：LLM 又提到不記的詞也不加回來', async () => {
    const store = memoryStore();
    store.state.excluded = ['パン'];
    const ledger = createNotesLedger({ store });

    await ledger.checkout('s').commit({ ...noChanges(), added: [{ 原文: 'パン', 讀音: 'ぱん', 譯文: '麵包', 類別: '用語' }] }, page);

    expect(store.state.entries).toEqual([]);
  });

  it('作品刪除後（#214）：還在翻的頁回來、人的修改都不寫，不會把刪掉的 Notes 寫回去', async () => {
    const store = memoryStore([note('パン', '麵包')]);
    let exists = true;
    const ledger = createNotesLedger({ store, seriesExists: async () => exists });

    const turn = ledger.checkout('s');
    await turn.notes;
    exists = false;
    await turn.commit({ ...noChanges(), added: [{ 原文: 'お店', 讀音: '', 譯文: '店', 類別: '用語' }] }, { ...page, balloonTexts: ['お店'] });
    await ledger.update('s', (notes) => ({ ...notes, entries: [] }));

    expect(store.saves).toBe(0);
  });
});
