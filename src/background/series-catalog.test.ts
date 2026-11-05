import { describe, expect, it } from 'vitest';
import type { PageTranslation } from '../shared/page-text.ts';
import type { NotesSuggestion } from '../shared/series-notes.ts';
import type { Series, UrlPattern } from '../shared/series.ts';
import type { NotesEntry } from '../shared/translator.ts';
import { createSeriesCatalog, type SeriesRepo } from './series-catalog.ts';

const EP1 = 'https://manga.example/episode/1';
const EP2 = 'https://manga.example/episode/2';

/** 記憶體版的 IndexedDB。 */
function memoryRepo() {
  const series = new Map<string, Series>();
  const patterns = new Map<string, UrlPattern>();
  let translations: PageTranslation[] = [];
  let notes: NotesEntry[] = [];
  let suggestions: NotesSuggestion[] = [];
  const excluded = new Map<string, string[]>();
  const repo: SeriesRepo = {
    getSeries: async (id) => series.get(id),
    listSeries: async () => [...series.values()],
    putSeries: async (s) => void series.set(s.id, s),
    getPattern: async (p) => patterns.get(p),
    listPatterns: async () => [...patterns.values()],
    putPattern: async (p) => void patterns.set(p.pattern, p),
    listTranslations: async (id) => translations.filter((t) => t.seriesId === id),
    listNotes: async (id) => notes.filter((n) => n.seriesId === id),
    listSuggestions: async (id) => suggestions.filter((s) => s.seriesId === id),
    listExcluded: async (id) => excluded.get(id) ?? [],
    async commitMerge(m) {
      translations = [...translations.filter((t) => t.seriesId !== m.sourceId), ...m.translations];
      notes = [...notes.filter((n) => n.seriesId !== m.sourceId && n.seriesId !== m.targetId), ...m.notes];
      suggestions = [...suggestions.filter((s) => s.seriesId !== m.sourceId), ...m.suggestions];
      excluded.delete(m.sourceId);
      excluded.set(m.targetId, m.excluded);
      series.delete(m.sourceId);
    },
    async deleteSeries(id) {
      translations = translations.filter((t) => t.seriesId !== id);
      notes = notes.filter((n) => n.seriesId !== id);
      suggestions = suggestions.filter((s) => s.seriesId !== id);
      for (const [key, p] of patterns) if (p.seriesId === id) patterns.delete(key);
      excluded.delete(id);
      series.delete(id);
    },
  };
  return {
    repo,
    series,
    patterns,
    excluded,
    seed(t: PageTranslation[], n: NotesEntry[]) {
      translations.push(...t);
      notes.push(...n);
    },
    get translations() {
      return translations;
    },
    get notes() {
      return notes;
    },
    get suggestions() {
      return suggestions;
    },
  };
}

function setup() {
  const db = memoryRepo();
  let clock = 1000;
  let ids = 0;
  const catalog = createSeriesCatalog({ repo: db.repo, now: () => new Date(clock), newId: () => `id-${++ids}` });
  return { db, catalog, tick: () => (clock += 1000) };
}

const translation = (seriesId: string, pageHash: string, 譯文: string): PageTranslation => ({
  seriesId,
  pageHash,
  balloons: [],
  looseText: [{ id: 'l1', order: 1, bbox: { x: 0, y: 0, w: 1, h: 1 }, orientation: 'vertical', 原文: 'ドン', 讀音: 'どん', 讀音來源: 'llm', 譯文, unreadable: false }],
  usedNotes: [],
  model: 'fake',
  promptVersion: '',
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
  latencyMs: 0,
  translatedAt: 0,
});

const note = (seriesId: string, 原文: string, 譯文: string): NotesEntry => ({ seriesId, 原文, 讀音: '', 譯文, 類別: '人名', locked: false });

const EP3 = 'https://manga.example/episode/3';

/** Haiku 猜到這個原名（#186）。 */
const guessed = (原名: string, 中文譯名 = `${原名}（中文）`) => async () => ({ 原名, 中文譯名 });
const cannotGuess = async () => undefined;

describe('seriesForUrl', () => {
  it('沒有網址模式、猜不出原名：建一個未命名的 Provisional Series，不記住網址', async () => {
    const { db, catalog } = setup();

    const { seriesId, by } = await catalog.seriesForUrl(EP1, cannotGuess);

    expect(by).toBe('unnamed');
    expect(db.series.get(seriesId)).toMatchObject({ provisional: true, name: expect.stringMatching(/^未命名・manga\.example・/) });
    expect(db.patterns.size).toBe(0);
  });

  it('選過 Series 的網址（忽略 query 與 hash）直接預選它，不猜原名、不再建 Provisional Series', async () => {
    const { db, catalog } = setup();
    const series = await catalog.create('範例作品', EP1);
    let asked = false;

    const assigned = await catalog.seriesForUrl(`${EP1}?from=top#p3`, async () => {
      asked = true;
      return { 原名: '別的作品', 中文譯名: '' };
    });

    expect(assigned).toEqual({ seriesId: series.id, by: 'urlPattern' });
    expect(asked).toBe(false);
    expect([...db.series.values()]).toEqual([series]);
  });

  it('猜到原名、還沒有這部作品：新建 Provisional Series，名稱用原名，記下原名與中文譯名', async () => {
    const { db, catalog } = setup();

    const { seriesId, by, originalTitle } = await catalog.seriesForUrl(EP1, guessed('星降る町の郵便屋', '星落小鎮的郵差'));

    expect({ by, originalTitle }).toEqual({ by: 'created', originalTitle: '星降る町の郵便屋' });
    expect(db.series.get(seriesId)).toMatchObject({ provisional: true, name: '星降る町の郵便屋', zhTitle: '星落小鎮的郵差', originalTitles: ['星降る町の郵便屋'] });
    expect(db.patterns.size).toBe(0);
  });

  it('下一話猜到同一個原名（全形半形、空白不同也算）：歸到同一部 Provisional Series，不再新建', async () => {
    const { db, catalog } = setup();
    const first = await catalog.seriesForUrl(EP1, guessed('鉄の庭　２'));

    const second = await catalog.seriesForUrl(EP2, guessed('鉄の庭 2'));

    expect(second).toEqual({ seriesId: first.seriesId, by: 'title', originalTitle: '鉄の庭 2' });
    expect(db.series.size).toBe(1);
  });

  it('外傳的原名不同：另外建一部，不併進本傳', async () => {
    const { db, catalog } = setup();
    const main = await catalog.seriesForUrl(EP1, guessed('鉄の庭'));

    const sideStory = await catalog.seriesForUrl(EP2, guessed('鉄の庭 外伝'));

    expect(sideStory.seriesId).not.toBe(main.seriesId);
    expect(db.series.size).toBe(2);
  });
});

describe('seriesForGuess（同分頁換網址後重猜）', () => {
  it('猜到既有作品的原名就是那部；沒有就新建 Provisional Series', async () => {
    const { db, catalog } = setup();
    const existing = await catalog.seriesForUrl(EP1, guessed('鉄の庭'));

    expect(await catalog.seriesForGuess({ 原名: '鉄の庭', 中文譯名: '' })).toEqual({ seriesId: existing.seriesId, by: 'title', originalTitle: '鉄の庭' });
    const other = await catalog.seriesForGuess({ 原名: '海辺のアトリエ', 中文譯名: '海邊的畫室' });
    expect(other.by).toBe('created');
    expect(db.series.get(other.seriesId)).toMatchObject({ provisional: true, name: '海辺のアトリエ' });
  });
});

describe('記住原名：選擇、合併、確認', () => {
  it('讀者選了另一部作品：這次猜到的原名記到那部，下次猜到同一個原名直接歸到那裡', async () => {
    const { db, catalog } = setup();
    const target = await catalog.create('範例作品', EP1);
    const wrong = await catalog.seriesForUrl(EP2, guessed('サンプル作品'));

    await catalog.select(target.id, EP2, 'サンプル作品');

    expect(db.series.get(target.id)?.originalTitles).toEqual(['サンプル作品']);
    expect((await catalog.seriesForUrl(EP3, guessed('サンプル作品'))).seriesId).toBe(target.id);
    // 歸錯的那部 Provisional Series 本身留著（之前的快取與 Notes 不搬），只是不再用這個原名歸類
    expect(db.series.get(wrong.seriesId)).toBeDefined();
  });

  it('一部 Series 可以有多個原名：已經有的不重複記', async () => {
    const { db, catalog } = setup();
    const target = await catalog.create('範例作品', EP1, '範例作品 THE COMIC');

    await catalog.select(target.id, EP2, '範例作品');
    await catalog.select(target.id, EP3, '範例作品');

    expect(db.series.get(target.id)?.originalTitles).toEqual(['範例作品 THE COMIC', '範例作品']);
  });

  it('合併：來源的原名記到目標，之後猜到它就歸到目標', async () => {
    const { db, catalog } = setup();
    const target = await catalog.create('範例作品', EP1);
    const source = await catalog.seriesForUrl(EP2, guessed('サンプル作品'));

    expect(await catalog.merge(source.seriesId, target.id, EP2)).toBe(true);

    expect(db.series.get(target.id)?.originalTitles).toEqual(['サンプル作品']);
    expect((await catalog.seriesForUrl(EP3, guessed('サンプル作品'))).seriesId).toBe(target.id);
  });

  it('「是」＝確認：拿掉 provisional、記住網址模式；之後不能再當合併的來源', async () => {
    const { db, catalog } = setup();
    const target = await catalog.create('範例作品', EP1);
    const auto = await catalog.seriesForUrl(EP2, guessed('サンプル作品'));

    await catalog.confirm(auto.seriesId, EP2);

    expect(db.series.get(auto.seriesId)).toMatchObject({ provisional: false, name: 'サンプル作品' });
    expect((await catalog.seriesForUrl(EP2, cannotGuess)).by).toBe('urlPattern');
    expect(await catalog.merge(auto.seriesId, target.id, EP2)).toBe(false);
  });

  it('改名：讀者的名稱為準，猜的中文譯名不再顯示；原名照樣留著', async () => {
    const { db, catalog } = setup();
    const auto = await catalog.seriesForUrl(EP1, guessed('サンプル作品', '樣本作品'));

    await catalog.rename(auto.seriesId, '我的作品', EP1);

    const series = db.series.get(auto.seriesId);
    expect(series).toMatchObject({ provisional: false, name: '我的作品', originalTitles: ['サンプル作品'] });
    expect(series).not.toHaveProperty('zhTitle');
  });
});

describe('rememberedSeries', () => {
  it('同分頁導航到記住過的網址（忽略 query 與 hash）：回傳那部 Series，並更新最近使用時間', async () => {
    const { db, catalog, tick } = setup();
    const series = await catalog.create('範例作品', EP1);
    tick();

    expect(await catalog.rememberedSeries(`${EP1}?p=2`)).toBe(series.id);
    expect(db.patterns.get(EP1)?.lastUsedAt).toBe(2000);
  });

  it('對不上網址模式：沒有結果，也不建 Provisional Series', async () => {
    const { db, catalog } = setup();
    await catalog.create('範例作品', EP1);

    expect(await catalog.rememberedSeries(EP2)).toBeUndefined();
    expect(db.series.size).toBe(1);
  });

  it('網址模式指到的 Series 已經不在（例如被合併掉）：沒有結果', async () => {
    const { db, catalog } = setup();
    const series = await catalog.create('範例作品', EP1);
    db.series.delete(series.id);

    expect(await catalog.rememberedSeries(EP1)).toBeUndefined();
  });
});

describe('select', () => {
  it('選非 Provisional 的 Series 才記住網址模式，並更新最近使用時間', async () => {
    const { db, catalog, tick } = setup();
    const a = await catalog.create('A', EP1);
    const b = await catalog.create('B', EP2);
    tick();

    await catalog.select(a.id, EP2);

    expect(db.patterns.get(EP2)).toEqual({ pattern: EP2, seriesId: a.id, lastUsedAt: 2000 });
    expect((await catalog.menu()).map((o) => o.id)).toEqual([a.id, b.id]);
  });

  it('選 Provisional Series 不記住網址', async () => {
    const { db, catalog } = setup();
    const provisional = (await catalog.seriesForUrl(EP1, cannotGuess)).seriesId;

    await catalog.select(provisional, EP1);

    expect(db.patterns.size).toBe(0);
  });
});

describe('rename', () => {
  it('改名拿掉 provisional、ID 不變，並記住網址', async () => {
    const { db, catalog } = setup();
    const id = (await catalog.seriesForUrl(EP1, cannotGuess)).seriesId;

    await catalog.rename(id, '範例作品', EP1);

    expect(db.series.get(id)).toMatchObject({ id, name: '範例作品', provisional: false });
    expect((await catalog.seriesForUrl(EP1, cannotGuess)).seriesId).toBe(id);
  });
});

describe('merge', () => {
  const A = '0'.repeat(64);
  const nearA = '1' + '0'.repeat(63);
  const B = 'f'.repeat(64);

  it('快取改用目標 ID（同一個 Page 保留目標的）、Notes 衝突變成建議修改、刪掉臨時 Series、記住網址', async () => {
    const { db, catalog } = setup();
    const target = await catalog.create('範例作品', EP1);
    const provisional = (await catalog.seriesForUrl(EP2, cannotGuess)).seriesId;
    db.seed(
      [translation(target.id, A, '目標的'), translation(provisional, nearA, '臨時的'), translation(provisional, B, '另一頁')],
      [note(target.id, '山田太郎', '太郎'), note(provisional, '山田太郎', '小太'), note(provisional, '鈴木', '阿鈴')],
    );

    await catalog.merge(provisional, target.id, EP2);

    expect(db.translations.map((t) => [t.seriesId, t.pageHash, t.looseText[0]!.譯文])).toEqual([
      [target.id, A, '目標的'],
      [target.id, B, '另一頁'],
    ]);
    expect(db.notes.map((n) => [n.seriesId, n.原文, n.譯文])).toEqual([
      [target.id, '山田太郎', '太郎'],
      [target.id, '鈴木', '阿鈴'],
    ]);
    expect(db.suggestions).toEqual([{ seriesId: target.id, 原文: '山田太郎', 建議譯文: '小太', 來源: { mergedFrom: provisional } }]);
    expect(db.series.has(provisional)).toBe(false);
    expect((await catalog.seriesForUrl(EP2, cannotGuess)).seriesId).toBe(target.id);
  });

  it('來源不是 Provisional Series：不合併，什麼都不動', async () => {
    const { db, catalog } = setup();
    const target = await catalog.create('範例作品', EP1);
    const named = await catalog.create('鬼滅', EP2);
    db.seed([translation(named.id, B, '另一頁')], [note(named.id, '鈴木', '阿鈴')]);

    const merged = await catalog.merge(named.id, target.id, EP2);

    expect(merged).toBe(false);
    expect(db.series.has(named.id)).toBe(true);
    expect(db.translations.map((t) => t.seriesId)).toEqual([named.id]);
    expect(db.notes.map((n) => n.seriesId)).toEqual([named.id]);
    expect((await catalog.seriesForUrl(EP2, cannotGuess)).seriesId).toBe(named.id);
  });

  it('合併成功時回傳 true', async () => {
    const { catalog } = setup();
    const target = await catalog.create('A', EP1);
    const provisional = (await catalog.seriesForUrl(EP2, cannotGuess)).seriesId;

    expect(await catalog.merge(provisional, target.id, EP2)).toBe(true);
  });

  it('臨時 Series 原有的建議修改改掛到目標', async () => {
    const { db, catalog } = setup();
    const target = await catalog.create('A', EP1);
    const provisional = (await catalog.seriesForUrl(EP2, cannotGuess)).seriesId;
    await db.repo.commitMerge({
      sourceId: 'none',
      targetId: provisional,
      translations: [],
      notes: [],
      suggestions: [{ seriesId: provisional, 原文: 'x', 建議譯文: 'y', 來源: { pageHash: 'h1' } }],
      excluded: [],
    });

    await catalog.merge(provisional, target.id, EP2);

    expect(db.suggestions).toEqual([{ seriesId: target.id, 原文: 'x', 建議譯文: 'y', 來源: { pageHash: 'h1' } }]);
  });
});

describe('Excluded Term 與合併（#214）', () => {
  it('目標不記的詞：來源的條目與建議都不帶過來；來源不記的詞加到目標（目標已有條目的除外）', async () => {
    const { db, catalog } = setup();
    const target = await catalog.create('範例作品', EP1);
    const provisional = (await catalog.seriesForUrl(EP2, cannotGuess)).seriesId;
    db.seed([], [note(target.id, 'タロウ', '太郎'), note(provisional, 'ドーン', '咚'), note(provisional, 'ミナ', '美娜')]);
    db.excluded.set(target.id, ['ドーン']);
    db.excluded.set(provisional, ['ホンダナ', 'タロウ']);
    await db.repo.commitMerge({
      sourceId: 'none',
      targetId: provisional,
      translations: [],
      notes: db.notes.filter((n) => n.seriesId === provisional),
      suggestions: [{ seriesId: provisional, 原文: 'ドーン', 建議譯文: '轟', 來源: { pageHash: 'h1' } }],
      excluded: ['ホンダナ', 'タロウ'],
    });

    await catalog.merge(provisional, target.id, EP2);

    expect(db.notes.map((n) => n.原文)).toEqual(['タロウ', 'ミナ']);
    expect(db.suggestions).toEqual([]);
    expect(db.excluded.get(target.id)).toEqual(['ドーン', 'ホンダナ']);
  });
});

describe('remove（刪除作品，#214）', () => {
  it('刪掉這部作品與它的快取、條目、建議修改、網址模式、不記的詞；別部作品不動', async () => {
    const { db, catalog } = setup();
    const doomed = await catalog.create('要刪的', EP1);
    const kept = await catalog.create('留著的', EP2);
    db.seed([translation(doomed.id, 'a'.repeat(64), '刪'), translation(kept.id, 'b'.repeat(64), '留')], [note(doomed.id, 'ドーン', '咚'), note(kept.id, 'ミナ', '美娜')]);
    db.excluded.set(doomed.id, ['ホンダナ']);

    expect(await catalog.remove(doomed.id)).toBe(true);

    expect([...db.series.keys()]).toEqual([kept.id]);
    expect(db.translations.map((t) => t.seriesId)).toEqual([kept.id]);
    expect(db.notes.map((n) => n.seriesId)).toEqual([kept.id]);
    expect([...db.patterns.values()].map((p) => p.seriesId)).toEqual([kept.id]);
    expect(db.excluded.has(doomed.id)).toBe(false);
    // 網址模式也不在了：再開同一話會重新歸類
    expect((await catalog.seriesForUrl(EP1, cannotGuess)).by).toBe('unnamed');
  });

  it('不存在的作品：什麼都不動，回傳 false', async () => {
    const { catalog } = setup();
    expect(await catalog.remove('nope')).toBe(false);
  });
});
