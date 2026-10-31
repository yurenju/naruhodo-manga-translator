import { describe, expect, it } from 'vitest';
import { eraseFill } from '../content/overlay-layout.ts';
import type { BalloonText, PageTranslation } from '../shared/page-text.ts';
import type { NotesSuggestion, SeriesNotes } from '../shared/series-notes.ts';
import type { Series, UrlPattern } from '../shared/series.ts';
import type { NotesEntry } from '../shared/translator.ts';
import { createBackup, type BackupData, type BackupRepo } from './backup.ts';

const API_KEY = 'sk-ant-unit-export-must-not-contain-this-key';

/** 記憶體版的 IndexedDB，連 apiKeys store 也有（真的 DB 裡它跟另外五個放在一起）。 */
function memoryDb() {
  const series = new Map<string, Series>();
  const patterns = new Map<string, UrlPattern>();
  let translations: PageTranslation[] = [];
  let notes: NotesEntry[] = [];
  let suggestions: NotesSuggestion[] = [];
  const apiKeys = [API_KEY];
  const repo: BackupRepo = {
    // 刻意把 apiKeys 也讀出來：匯出不能只靠 repo 自己不讀它
    dump: async () => ({ series: [...series.values()], urlPatterns: [...patterns.values()], seriesNotes: notes, notesSuggestions: suggestions, pageTranslations: translations, apiKeys }) as BackupData,
    getSeries: async (id) => series.get(id),
    putSeries: async (s) => void series.set(s.id, s),
    getPattern: async (p) => patterns.get(p),
    putPattern: async (p) => void patterns.set(p.pattern, p),
    listTranslations: async (id) => translations.filter((t) => t.seriesId === id),
    async putTranslations(rows) {
      const key = (t: PageTranslation) => `${t.seriesId}/${t.pageHash}`;
      const incoming = new Set(rows.map(key));
      translations = [...translations.filter((t) => !incoming.has(key(t))), ...rows];
    },
  };
  /** 跟 notes-ledger 一樣：讀出這部 Series 的 Notes、套用改動、整份寫回。 */
  async function updateNotes(seriesId: string, change: (n: SeriesNotes) => SeriesNotes) {
    const next = change({ entries: notes.filter((n) => n.seriesId === seriesId), suggestions: suggestions.filter((s) => s.seriesId === seriesId) });
    notes = [...notes.filter((n) => n.seriesId !== seriesId), ...next.entries];
    suggestions = [...suggestions.filter((s) => s.seriesId !== seriesId), ...next.suggestions];
  }
  const backup = createBackup({ repo, updateNotes, now: () => 1000 });
  return {
    backup,
    seed(data: BackupData) {
      for (const s of data.series) series.set(s.id, s);
      for (const p of data.urlPatterns) patterns.set(p.pattern, p);
      notes = [...data.seriesNotes];
      suggestions = [...data.notesSuggestions];
      translations = [...data.pageTranslations];
    },
    stores: (): BackupData => ({ series: [...series.values()], urlPatterns: [...patterns.values()], seriesNotes: notes, notesSuggestions: suggestions, pageTranslations: translations }),
  };
}

const translation = (seriesId: string, pageHash: string, 譯文: string): PageTranslation => ({
  seriesId,
  pageHash,
  balloons: [],
  looseText: [{ id: 'l1', order: 1, bbox: { x: 0, y: 0, w: 1, h: 1 }, orientation: 'vertical', 原文: 'パン', 讀音: 'ぱん', 讀音來源: 'llm', 譯文, unreadable: false }],
  usedNotes: [{ 原文: 'パン', 譯文: '麵包' }],
  model: 'fake',
  promptVersion: 'v1',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, costUsd: 0.01 },
  latencyMs: 100,
  translatedAt: 500,
});

/** 兩部 Series，每個 store 都有東西（含一個 locked 條目與一個待處理的建議）。 */
const SAMPLE: BackupData = {
  series: [
    { id: 's1', name: '範例作品', provisional: false, createdAt: 1 },
    { id: 's2', name: '未命名', provisional: true, createdAt: 2 },
  ],
  urlPatterns: [{ pattern: 'https://manga.example/episode/1', seriesId: 's1', lastUsedAt: 3 }],
  seriesNotes: [
    { seriesId: 's1', 原文: 'パン', 讀音: 'ぱん', 譯文: '麵包', 類別: '用語', locked: true, 自稱: '俺' },
    { seriesId: 's2', 原文: '霧島湊', 讀音: 'きりしまみなと', 譯文: '霧島湊', 類別: '人名', locked: false },
  ],
  notesSuggestions: [{ seriesId: 's1', 原文: 'パン', 建議譯文: '胖', 來源: { pageHash: 'aaaa' } }],
  pageTranslations: [translation('s1', 'aaaa', '麵包'), translation('s2', 'bbbb', '霧島湊')],
};

describe('exportAll', () => {
  it('匯出檔不含 API key，只有五個 store 與檔頭', async () => {
    const db = memoryDb();
    db.seed(SAMPLE);

    const file = await db.backup.exportAll();

    expect(JSON.stringify(file)).not.toContain(API_KEY);
    expect(Object.keys(file).sort()).toEqual(['exportedAt', 'format', 'notesSuggestions', 'pageTranslations', 'series', 'seriesNotes', 'urlPatterns', 'version']);
  });
});

describe('importAll', () => {
  it('匯出再匯入到空的 DB：每個 store 內容都一樣，回傳 Notes 有寫入的 Series', async () => {
    const source = memoryDb();
    source.seed(SAMPLE);
    // 經過 JSON：跟真的下載、選檔一樣
    const file = JSON.parse(JSON.stringify(await source.backup.exportAll()));

    const clean = memoryDb();
    const touched = await clean.backup.importAll(file);

    const sorted = (rows: readonly unknown[]) => rows.map((r) => JSON.stringify(r)).sort();
    const imported = clean.stores();
    for (const key of ['series', 'urlPatterns', 'seriesNotes', 'notesSuggestions', 'pageTranslations'] as const)
      expect(sorted(imported[key]), key).toEqual(sorted(SAMPLE[key]));
    expect(touched.sort()).toEqual(['s1', 's2']);
  });
});

describe('擦除資料只留在本機', () => {
  it('匯出檔不含擦除小圖；匯入後那頁跟舊快取一樣，擦除退回矩形加 eraseLuminance', async () => {
    const balloon: BalloonText = {
      id: 'b1',
      order: 1,
      balloonBbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
      textBbox: { x: 0.15, y: 0.15, w: 0.2, h: 0.2 },
      orientation: 'vertical',
      原文: 'パン',
      讀音: 'ぱん',
      讀音來源: 'llm',
      譯文: '麵包',
      unreadable: false,
      eraseLuminance: 250,
      erase: { box: { x: 0.14, y: 0.14, w: 0.22, h: 0.22 }, image: 'data:image/png;base64,ERASE-IMAGE' },
    };
    const source = memoryDb();
    source.seed({ ...SAMPLE, pageTranslations: [{ ...translation('s1', 'aaaa', '麵包'), balloons: [balloon] }] });

    const file = JSON.parse(JSON.stringify(await source.backup.exportAll()));
    const clean = memoryDb();
    await clean.backup.importAll(file);

    expect(JSON.stringify(file)).not.toContain('ERASE-IMAGE');
    const [restored] = clean.stores().pageTranslations.find((t) => t.pageHash === 'aaaa')!.balloons;
    const { erase: _, ...rest } = balloon;
    expect(restored).toEqual(rest);
    expect(eraseFill(restored!)).toEqual({ kind: 'rect', luminance: 250 });
    // 本機那份不受影響
    expect(source.stores().pageTranslations[0]!.balloons[0]!.erase).toEqual(balloon.erase);
  });

  it('長 Page 的扣頁紀錄不進備份：匯入的那頁之後的截當成新的一頁扣', async () => {
    const long: PageTranslation = { ...translation('s1', 'aaaa', '麵包'), stripes: [{ index: 0, hash: 'ff' }], charge: { usageRecordId: 7, chargedAt: 400 } };
    const source = memoryDb();
    source.seed({ ...SAMPLE, pageTranslations: [long] });

    const file = JSON.parse(JSON.stringify(await source.backup.exportAll()));
    const clean = memoryDb();
    await clean.backup.importAll(file);

    const { charge: _, ...rest } = long;
    expect(clean.stores().pageTranslations).toEqual([rest]);
  });
});
