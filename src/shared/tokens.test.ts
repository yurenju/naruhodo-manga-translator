import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const TOKENS = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

/** --naru-font-* 的字型清單（去掉引號）。 */
function stack(name: string): string[] {
  const value = TOKENS.match(new RegExp(`--naru-font-${name}:\\s*([^;]+);`))![1]!;
  return value.split(',').map((f) => f.trim().replace(/^'|'$/g, ''));
}

/** 只有某一種語言字形的系統字型：排進另一種語言的清單，那個語言的字就會用錯字形、缺的字再被別的字型補。 */
const CHINESE_FONTS = ['PingFang TC', 'Microsoft JhengHei UI', 'Microsoft JhengHei'];
const JAPANESE_FONTS = ['Hiragino Sans', 'Yu Gothic UI', 'Yu Gothic'];

describe('字型 token（系統字型，不打包）', () => {
  it('中文與日文的清單各自只有自己語言的字型', () => {
    expect(stack('sans').filter((f) => JAPANESE_FONTS.includes(f))).toEqual([]);
    expect(stack('ja').filter((f) => CHINESE_FONTS.includes(f))).toEqual([]);
  });

  it('Windows 與 macOS 的語言字型都排在 system-ui 前面（system-ui 跟著作業系統語系，會把日文接成中文字型）', () => {
    for (const [name, fonts] of [['sans', CHINESE_FONTS], ['ja', JAPANESE_FONTS]] as const) {
      const list = stack(name);
      const systemUi = list.indexOf('system-ui');
      for (const font of fonts) {
        expect(list.indexOf(font), `${name}: ${font}`).toBeGreaterThanOrEqual(0);
        expect(list.indexOf(font), `${name}: ${font}`).toBeLessThan(systemUi);
      }
    }
  });
});
