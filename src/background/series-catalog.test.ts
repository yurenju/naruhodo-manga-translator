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
    async commitMerge(m) {
      translations = [...translations.filter((t) => t.seriesId !== m.sourceId), ...m.translations];
      notes = [...notes.filter((n) => n.seriesId !== m.sourceId && n.seriesId !== m.targetId), ...m.notes];
      suggestions = [...suggestions.filter((s) => s.seriesId !== m.sourceId), ...m.suggestions];
      series.delete(m.sourceId);
    },
  };
  return {
    repo,
    series,
    patterns,
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

describe('seriesForUrl', () => {
  it('沒有網址模式：建一個 Provisional Series，不記住網址', async () => {
    const { db, catalog } = setup();

    const id = await catalog.seriesForUrl(EP1);

    expect(db.series.get(id)).toMatchObject({ provisional: true, name: expect.stringMatching(/^未命名・manga\.example・/) });
    expect(db.patterns.size).toBe(0);
  });

  it('選過 Series 的網址（忽略 query 與 hash）直接預選它，不再建 Provisional Series', async () => {
    const { db, catalog } = setup();
    const series = await catalog.create('範例作品', EP1);

    expect(await catalog.seriesForUrl(`${EP1}?from=top#p3`)).toBe(series.id);
    expect([...db.series.values()]).toEqual([series]);
  });

  it('同網站的另一個網址不預選，建 Provisional Series', async () => {
    const { db, catalog } = setup();
    const series = await catalog.create('範例作品', EP1);

    const id = await catalog.seriesForUrl(EP2);

    expect(id).not.toBe(series.id);
    expect(db.series.get(id)?.provisional).toBe(true);
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
    const provisional = await catalog.seriesForUrl(EP1);

    await catalog.select(provisional, EP1);

    expect(db.patterns.size).toBe(0);
  });
});

describe('rename', () => {
  it('改名拿掉 provisional、ID 不變，並記住網址', async () => {
    const { db, catalog } = setup();
    const id = await catalog.seriesForUrl(EP1);

    await catalog.rename(id, '範例作品', EP1);

    expect(db.series.get(id)).toMatchObject({ id, name: '範例作品', provisional: false });
    expect(await catalog.seriesForUrl(EP1)).toBe(id);
  });
});

describe('merge', () => {
  const A = '0'.repeat(64);
  const nearA = '1' + '0'.repeat(63);
  const B = 'f'.repeat(64);

  it('快取改用目標 ID（同一個 Page 保留目標的）、Notes 衝突變成建議修改、刪掉臨時 Series、記住網址', async () => {
    const { db, catalog } = setup();
    const target = await catalog.create('範例作品', EP1);
    const provisional = await catalog.seriesForUrl(EP2);
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
    expect(await catalog.seriesForUrl(EP2)).toBe(target.id);
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
    expect(await catalog.seriesForUrl(EP2)).toBe(named.id);
  });

  it('合併成功時回傳 true', async () => {
    const { catalog } = setup();
    const target = await catalog.create('A', EP1);
    const provisional = await catalog.seriesForUrl(EP2);

    expect(await catalog.merge(provisional, target.id, EP2)).toBe(true);
  });

  it('臨時 Series 原有的建議修改改掛到目標', async () => {
    const { db, catalog } = setup();
    const target = await catalog.create('A', EP1);
    const provisional = await catalog.seriesForUrl(EP2);
    await db.repo.commitMerge({
      sourceId: 'none',
      targetId: provisional,
      translations: [],
      notes: [],
      suggestions: [{ seriesId: provisional, 原文: 'x', 建議譯文: 'y', 來源: { pageHash: 'h1' } }],
    });

    await catalog.merge(provisional, target.id, EP2);

    expect(db.suggestions).toEqual([{ seriesId: target.id, 原文: 'x', 建議譯文: 'y', 來源: { pageHash: 'h1' } }]);
  });
});
