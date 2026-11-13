import { describe, expect, it } from 'vitest';
import type { LineBox, PageOutlines, PageView } from '../shared/messages.ts';
import { createOutlineSync } from './outline-sync.ts';

const line: LineBox = { id: 'b1', kind: 'balloon', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, order: 1 };
const page = (extra: Partial<PageView> = {}): PageView => ({
  anchorId: 'a1',
  rect: { x: 0, y: 0, width: 400, height: 600 },
  thumbnail: 'data:',
  pageHash: '0'.repeat(64),
  transcript: { state: 'analyzing' },
  ...extra,
});

function setup() {
  const sent: [number, PageOutlines[]][] = [];
  return { sync: createOutlineSync((tabId, pages) => sent.push([tabId, pages])), sent };
}

describe('Page 外圈送到 content script', () => {
  it('沒有外圈、content script 上面也沒有時不送', () => {
    const { sync, sent } = setup();

    sync.publish(1, [page()]);

    expect(sent).toEqual([]);
  });

  it('內容沒變不重送；外圈沒了送一次空的，content script 才會拿掉', () => {
    const { sync, sent } = setup();

    sync.publish(1, [page({ translatingLines: [line] })]);
    sync.publish(1, [page({ translatingLines: [line] })]);
    sync.publish(1, [page()]);
    sync.publish(1, [page()]);

    expect(sent.map(([, pages]) => pages.map((p) => p.translating.length))).toEqual([[1], []]);
  });

  it('重新整理後 content script 是新的：同樣的外圈要重送', () => {
    const { sync, sent } = setup();

    sync.publish(1, [page({ waitingLines: [line] })]);
    sync.reset(1);
    sync.publish(1, [page({ waitingLines: [line] })]);

    expect(sent).toHaveLength(2);
  });
});
