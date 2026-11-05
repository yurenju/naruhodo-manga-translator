/**
 * Series Notes 累積（#37、spec #27 第 3.4 節、ADR 0005）：每頁送出整理 Notes 的呼叫（②）時拿一份 Notes 快照，
 * 回來後依「② 送出的順序」套用 notes_changes——後送出的先回來也要等前面的套用完（或失敗放掉）。
 * 翻譯（①）不排進這個順序，回來就顯示。套用規則在 shared/series-notes.ts。
 * 同一個 SnapshotGroup 的頁（Spread 的兩頁）拿到同一份快照：後送出的那頁不會看到先送出那頁的變更（spec 第 3.4 節）。
 *
 * 人在 side panel 的修改（#38：編輯條目、接受／忽略建議、匯入）也從這裡寫：每次「讀 → 改 → 寫」互斥，
 * 跟套用 LLM 的變更不會互相蓋掉；但不排進送出順序，不必等還在翻的頁回來。
 */
import { addSuggestions, applyNotesChanges, type NotesPage, type SeriesNotes } from '../shared/series-notes.ts';
import { createTrace } from '../shared/trace.ts';
import type { NotesChanges, NotesEntry } from '../shared/translator.ts';

const trace = createTrace('sw');

/** 套用前後的條目比一比：新增了哪些原文、哪些既有條目補了哪些欄位（trace 用）。 */
function describeChanges(before: readonly NotesEntry[], after: readonly NotesEntry[]) {
  const byOriginal = new Map(before.map((e) => [e.原文, e]));
  const added: string[] = [];
  const filled: { 原文: string; fields: string[] }[] = [];
  for (const entry of after) {
    const old = byOriginal.get(entry.原文);
    if (!old) {
      added.push(entry.原文);
      continue;
    }
    const fields = (Object.keys(entry) as (keyof NotesEntry)[]).filter((key) => entry[key] !== old[key]);
    if (fields.length > 0) filled.push({ 原文: entry.原文, fields });
  }
  return { added, filled };
}

export interface NotesStore {
  /** 這個 Series 的全部條目，每次呼叫順序相同（prompt cache 要逐字一致）。 */
  list(seriesId: string): Promise<NotesEntry[]>;
  /** 這個 Series 的條目與建議修改。 */
  load(seriesId: string): Promise<SeriesNotes>;
  /** 一次寫入：全部條目（以原文為 key 覆寫）與全部建議修改（取代原本的）。 */
  save(seriesId: string, notes: SeriesNotes): Promise<void>;
}

declare const snapshotGroup: unique symbol;

/**
 * 共用一份 Notes 快照的一組頁：同一次排程裡同一個 anchor 切出來的 Page（Spread 的兩頁）。單頁的 anchor 也有一組，
 * 只是組裡只有它。不是 GLOSSARY 的 Spread：判斷依據是 anchor，不是兩頁並排。
 */
export type SnapshotGroup = { readonly [snapshotGroup]: true };

export function newSnapshotGroup(): SnapshotGroup {
  return {} as SnapshotGroup;
}

export interface NotesLedgerDeps {
  store: NotesStore;
  /** 這部 Series 還在不在（#214）：刪除之後不再寫入，還在翻的頁回來也不會把 Notes 寫回去。沒給＝一律在。 */
  seriesExists?(seriesId: string): Promise<boolean>;
}

/** 一頁送出 LLM 時拿到的號碼牌。commit 與 release 只能擇一呼叫一次。 */
export interface NotesTurn {
  /** 送出時的 Notes 快照（送進 prompt）。 */
  notes: Promise<NotesEntry[]>;
  /** 輪到這頁時套用它的變更；回傳套用後的全部條目。寫不進去就回傳快照，不擋翻譯結果。 */
  commit(changes: NotesChanges, page: Omit<NotesPage, 'seriesId'>): Promise<NotesEntry[]>;
  /** 翻譯失敗：不套用，只讓出順序。 */
  release(): void;
}

const EMPTY: SeriesNotes = { entries: [], suggestions: [], excluded: [] };

export function createNotesLedger({ store, seriesExists = async () => true }: NotesLedgerDeps) {
  /** 每個 Series 最後一張號碼牌輪完時 resolve。 */
  const tails = new Map<string, Promise<void>>();
  /**
   * SnapshotGroup → 第一頁送出時拿的快照，與這組裡已套用的頁新增的條目原文（後面的頁看不到它們）。
   * 組不再被引用（那次排程結束）就自動放掉。
   */
  const snapshots = new WeakMap<SnapshotGroup, { notes: Promise<NotesEntry[]>; added: Set<string> }>();
  /** 每個 Series 最後一次「讀 → 改 → 寫」做完時 resolve。 */
  const writes = new Map<string, Promise<unknown>>();

  /** 同一個 Series 的寫入一次只跑一個。 */
  function serialize<T>(seriesId: string, op: () => Promise<T>): Promise<T> {
    const run = (writes.get(seriesId) ?? Promise.resolve()).then(op);
    const settled = run.catch(() => {});
    writes.set(seriesId, settled);
    void settled.then(() => {
      if (writes.get(seriesId) === settled) writes.delete(seriesId);
    });
    return run;
  }

  /**
   * Series 還在才寫（#214）：跟刪除排在同一條序列裡，檢查與寫入之間不會被刪除插進來。刪掉了就不跑，回傳 undefined。
   */
  function whileExists<T>(seriesId: string, write: () => Promise<T>): Promise<T | undefined> {
    return serialize(seriesId, async () => ((await seriesExists(seriesId)) ? write() : undefined));
  }

  /** 讀 → 改 → 寫。Series 已經刪掉就什麼都不寫（#214）。 */
  async function exclusive(seriesId: string, change: (notes: SeriesNotes) => SeriesNotes): Promise<SeriesNotes> {
    const written = await whileExists(seriesId, async () => {
      const next = change(await store.load(seriesId));
      await store.save(seriesId, next);
      return next;
    });
    return written ?? EMPTY;
  }

  /** 這個 Series 目前的條目。讀不到就當沒有：只是少了 Notes 或過時提示，不擋翻譯。 */
  function list(seriesId: string): Promise<NotesEntry[]> {
    return store.list(seriesId).catch((e: unknown) => {
      console.warn('notes lookup failed', e);
      return [];
    });
  }

  return {
    list,

    /**
     * 送出 LLM 的那一刻呼叫（同步拿號碼牌，順序＝送出順序）。group：同一組的頁共用第一頁拿的快照。
     */
    checkout(seriesId: string, group?: SnapshotGroup): NotesTurn {
      const previous = tails.get(seriesId) ?? Promise.resolve();
      let done!: () => void;
      const turn = new Promise<void>((resolve) => (done = resolve));
      tails.set(seriesId, turn);
      void turn.then(() => {
        if (tails.get(seriesId) === turn) tails.delete(seriesId);
      });
      const shared = (group && snapshots.get(group)) ?? { notes: list(seriesId), added: new Set<string>() };
      if (group) snapshots.set(group, shared);
      const { notes } = shared;
      return {
        notes,
        async commit(changes, page) {
          try {
            await previous;
            let report: Record<string, unknown> = {};
            const next = await exclusive(seriesId, (current) => {
              const merged = applyNotesChanges(current.entries, changes, { ...page, seriesId, unseen: new Set(shared.added), excluded: current.excluded });
              const { added, filled } = describeChanges(current.entries, merged.entries);
              for (const 原文 of added) shared.added.add(原文);
              const suggestions = addSuggestions(current.suggestions, merged.suggestions);
              const newSuggestions = suggestions.slice(current.suggestions.length).map(({ 原文, 建議譯文 }) => ({ 原文, 建議譯文 }));
              report = { added, filled, rejected: merged.rejected, dropped: merged.dropped, suggestions: newSuggestions };
              return { ...current, entries: merged.entries, suggestions };
            });
            // 實際採用了什麼（#40 驗收 H2、H5）：LLM 想改的是 translate:response 的 notes_changes
            trace('notes:apply', { seriesId, pageHash: page.pageHash, ...report });
            return next.entries;
          } catch (e) {
            console.warn('notes save failed', e);
            return notes;
          } finally {
            done();
          }
        },
        release() {
          void previous.then(done);
        },
      };
    },

    /** 人在 side panel 的修改：不等送出順序，只跟其他寫入互斥。回傳改完的 Notes。 */
    update: exclusive,

    /** 翻譯快取這類跟 Notes 無關的寫入（#214）：Series 還在才寫，不會在刪除之後寫回去。 */
    whileExists,

    /**
     * 刪除這部 Series 的資料（#214）：排在已經開始的寫入後面，刪完之後的寫入看到 Series 不在就不寫。
     */
    remove: (seriesId: string, remove: () => Promise<void>) => serialize(seriesId, remove),
  };
}

export type NotesLedger = ReturnType<typeof createNotesLedger>;
