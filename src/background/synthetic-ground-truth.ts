/**
 * e2e build 的 FakeTranslator 用：合成頁的 ground truth（讀音與參考譯文）。
 * 只在 __E2E__ 分支裡用到；正式 build 時 esbuild 會把整個模組丟掉（scripts/build.test.ts 有檢查）。
 */
import p01 from '../../testdata/synthetic/out/p01-basic.json' with { type: 'json' };
import p02 from '../../testdata/synthetic/out/p02-ruby.json' with { type: 'json' };
import p03 from '../../testdata/synthetic/out/p03-shapes.json' with { type: 'json' };
import p04 from '../../testdata/synthetic/out/p04-outside.json' with { type: 'json' };
import p05 from '../../testdata/synthetic/out/p05-dense.json' with { type: 'json' };
import p06 from '../../testdata/synthetic/out/p06-horizontal.json' with { type: 'json' };
import p07 from '../../testdata/synthetic/out/p07-spread.json' with { type: 'json' };
import p08 from '../../testdata/synthetic/out/p08-action.json' with { type: 'json' };
import p09 from '../../testdata/synthetic/out/p09-erase.json' with { type: 'json' };
import type { GroundTruthText } from '../shared/fake-translator.ts';

export const SYNTHETIC_GROUND_TRUTH: { texts: GroundTruthText[] }[] = [p01, p02, p03, p04, p05, p06, p07, p08, p09];
