import { describe, expect, it } from 'vitest';
import type { PageTranslation } from '../shared/page-text.ts';
import type { Series } from '../shared/series.ts';
import { mergeTranslations, provisionalSeries, seriesMenu, seriesTitles, urlPattern } from './series.ts';

describe('provisionalSeries', () => {
  it('名稱是「未命名・網站・月/日」，標成 provisional', () => {
    const series = provisionalSeries('https://manga.example/episode/3270375685', new Date(2026, 9, 25, 23, 10), 'id-1');

    expect(series).toEqual({ id: 'id-1', name: '未命名・manga.example・10/25', provisional: true, createdAt: new Date(2026, 9, 25, 23, 10).getTime() });
  });
});

describe('urlPattern', () => {
  it('只留 origin＋path，忽略 query 與 hash', () => {
    expect(urlPattern('https://manga.example/episode/3270375685?from=top#page-3')).toBe('https://manga.example/episode/3270375685');
  });

  it('同網站的另一個網址是不同的網址模式', () => {
    expect(urlPattern('https://manga.example/episode/1')).not.toBe(urlPattern('https://manga.example/episode/2'));
  });
});

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

describe('mergeTranslations', () => {
  const A = '0'.repeat(64);
  const nearA = '1' + '0'.repeat(63); // 距離 1：同一個 Page
  const B = 'f'.repeat(64);

  it('臨時 Series 的快取改用目標 ID', () => {
    expect(mergeTranslations([], [translation('p', A, '咚')], 't')).toEqual([translation('t', A, '咚')]);
  });

  it('同一個 Page 兩邊都有時保留目標原本的（不寫）', () => {
    const toWrite = mergeTranslations([translation('t', A, '目標的')], [translation('p', nearA, '臨時的'), translation('p', B, '另一頁')], 't');

    expect(toWrite).toEqual([translation('t', B, '另一頁')]);
  });
});

describe('seriesMenu', () => {
  const s = (id: string, createdAt: number, provisional = false): Series => ({ id, name: id, provisional, createdAt });

  it('最近用過的 Series 在最上面，沒用過的依建立時間新到舊', () => {
    const series = [s('old', 1), s('used-long-ago', 2), s('new', 3), s('used-recently', 4)];
    const patterns = [
      { pattern: 'https://x/1', seriesId: 'used-long-ago', lastUsedAt: 10 },
      { pattern: 'https://x/2', seriesId: 'used-recently', lastUsedAt: 30 },
      { pattern: 'https://x/3', seriesId: 'used-long-ago', lastUsedAt: 20 },
    ];

    expect(seriesMenu(series, patterns).map((o) => o.id)).toEqual(['used-recently', 'used-long-ago', 'new', 'old']);
  });

  it('選單用名稱：自動建的 Series 名稱就是原名（#186）', () => {
    const [option] = seriesMenu([{ id: 'p', name: '鉄の庭', provisional: true, createdAt: 1, originalTitles: ['鉄の庭'], zhTitle: '鐵之庭' }], []);

    expect(option!.label).toBe('鉄の庭');
  });
});

describe('seriesTitles（作品卡的兩行字，#186）', () => {
  const series: Series = { id: 'p', name: '鉄の庭', provisional: true, createdAt: 1, originalTitles: ['鉄の庭'], zhTitle: '鐵之庭' };

  it('大字是猜的中文譯名、小字是原名', () => {
    expect(seriesTitles(series)).toEqual({ title: '鐵之庭', subtitle: '鉄の庭' });
  });

  it('讀者改過名（沒有中文譯名）：大字是讀者的名稱，小字照樣是原名', () => {
    const { zhTitle: _zh, ...renamed } = series;
    expect(seriesTitles({ ...renamed, name: '我的作品' })).toEqual({ title: '我的作品', subtitle: '鉄の庭' });
  });

  it('猜不出原名的未命名作品只有一行', () => {
    expect(seriesTitles({ id: 'u', name: '未命名・manga.example・10/25', provisional: true, createdAt: 1 })).toEqual({ title: '未命名・manga.example・10/25' });
  });
});
