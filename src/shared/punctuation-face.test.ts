import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PUNCTUATION_FAMILY } from './punctuation-face.ts';
import { PUNCTUATION_UNICODE_RANGE } from './punctuation-font.ts';

const SIDE_PANEL_CSS = readFileSync(new URL('../ui/side-panel.css', import.meta.url), 'utf8');

describe('譯文的標點字型', () => {
  it('涵蓋微軟正黑體會偏掉的標點：。，、；：．！？…‥ 與破折號 ―', () => {
    const covered = new Set(PUNCTUATION_UNICODE_RANGE.split(', ').map((u) => String.fromCodePoint(parseInt(u.slice(2), 16))));
    expect([...'。，、；：．！？…‥―'].filter((c) => !covered.has(c))).toEqual([]);
  });

  it('side panel 的譯文排第一個用它（CSS 裡的名稱跟程式載入的一樣）', () => {
    const rule = SIDE_PANEL_CSS.match(/\.translation \{[^}]*\}/)![0];
    expect(rule).toContain(`font-family: '${PUNCTUATION_FAMILY}', var(--naru-font-sans)`);
  });
});
