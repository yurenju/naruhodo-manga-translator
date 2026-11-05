/**
 * 用法：node scripts/cjk-font.ts
 *   重新產生外掛頁面用的 Noto Sans CJK（src/fonts/）。平常不用跑：產出的 woff2 已經 commit，build 與測試不連網路。
 *
 * 來源是 notofonts/noto-cjk 固定 commit（Sans2.004）的 NotoSansCJKjp-VF.otf：
 *   - CJK 不是 Subset：一個檔案收日文、繁中、簡中、韓文的字形，靠 OpenType 的 locl 跟著 lang 屬性切換
 *     （lang="ja" 是日文字形、lang="zh-Hant" 是繁中字形），日文與中文混排時不會有一邊缺字、改用系統字型補。
 *   - Variable（wght 100–900）：一個檔案涵蓋 side panel 用到的 400、500、700，比打包兩個 static 字重小。
 *   - jp 只是預設字形：沒有 lang 的文字顯示日文字形，所以外掛頁面的 <html> 一律標 lang。
 * OTF 30.8 MB，轉成 woff2 約 13.5 MB（WOFF2 用 Brotli 壓，CFF2 表也重新編過）。
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error wawoff2 沒有型別：compress(Uint8Array) → Promise<Uint8Array>
import { compress } from 'wawoff2';
import { CJK_FONT_FILE, CJK_FONT_SRC } from './build.ts';

const COMMIT = '523d033d6cb47f4a80c58a35753646f5c3608a78'; // tag Sans2.004
const BASE = `https://raw.githubusercontent.com/notofonts/noto-cjk/${COMMIT}`;
const OTF_SHA256 = 'ab2728702f90d2ae900309f299dc3c2b075010888a1a8a67fbd5b4c6aff713a0';

const CJK_FONT_DIR = fileURLToPath(new URL(`../${CJK_FONT_SRC}/`, import.meta.url));

async function download(path: string): Promise<Uint8Array> {
  const response = await fetch(`${BASE}/${path}`);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const otf = await download('Sans/Variable/OTF/NotoSansCJKjp-VF.otf');
  const sha = createHash('sha256').update(otf).digest('hex');
  if (sha !== OTF_SHA256) throw new Error(`NotoSansCJKjp-VF.otf 的 SHA-256 不符：${sha}`);
  const license = await download('LICENSE');
  const woff2: Uint8Array = await compress(otf);
  await mkdir(CJK_FONT_DIR, { recursive: true });
  await writeFile(join(CJK_FONT_DIR, CJK_FONT_FILE), woff2);
  await writeFile(join(CJK_FONT_DIR, 'LICENSE'), license);
  console.log(`${CJK_FONT_FILE}: ${otf.length} → ${woff2.length} bytes`);
}
