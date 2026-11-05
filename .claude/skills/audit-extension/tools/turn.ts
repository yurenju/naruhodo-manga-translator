/**
 * 一部作品連續翻頁：翻頁 → 等這次的頁蓋好 → 截圖，一頁一行回報。node .claude/skills/audit-extension/tools/turn.ts <urlPart> <代號> <起> <迄> [選項]
 *   --key <Key>        用這個鍵翻頁（預設 ArrowLeft：右翻左的日漫 viewer；鍵名同 cdp.ts key）
 *   --wheel <dy>       改用滾輪往下捲 dy CSS px（直式捲動 viewer）；給了就不按鍵
 *   --count <k>        每翻一次要等幾個 overlay:show（跨頁 2，單頁與直式 1；預設 2）
 *   --timeout <s>      每次最多等幾秒（預設 90）
 * 截圖存成 <audit>\shots\<代號>-<頁序兩位數>.png，<audit> 是 %LOCALAPPDATA%\naruhodo\audit\<最新 trace session>。
 * 逾時那一行會附上 debug:summary 從翻頁那行之後的最後幾筆，看停在哪一層。
 * 不翻頁的網站差異（要先點掉的對話框、跨頁裡的廣告頁）都不在這裡處理：迴圈跑完逐頁看截圖。
 */
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const here = import.meta.dirname;
const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const [urlPart, code, from, to] = args;
if (to === undefined) throw new Error(`用法見 ${import.meta.filename} 開頭`);
const wheel = option('--wheel');
const key = option('--key') ?? 'ArrowLeft';
const count = option('--count') ?? '2';
const timeout = option('--timeout') ?? '90';

const node = (file: string, ...rest: string[]) => execFileSync(process.execPath, [join(here, file), ...rest], { encoding: 'utf8' }).trim();
const tool = (file: string, ...rest: string[]): { ok: boolean; out: string } => {
  try {
    return { ok: true, out: node(file, ...rest) };
  } catch (e) {
    return { ok: false, out: String((e as { stdout?: string }).stdout ?? e).trim() };
  }
};

/** trace.ts session 印三行：名稱、資料夾、「n 行」。 */
const [session, sessionDir] = node('trace.ts', 'session').split('\n');
const lines = () => Number(node('trace.ts', 'session').split('\n')[2]!.match(/\d+/)![0]);
const shots = join(dirname(dirname(sessionDir!)), 'audit', session!, 'shots');
mkdirSync(shots, { recursive: true });

for (let page = Number(from); page <= Number(to); page++) {
  const since = lines();
  if (wheel === undefined) node('cdp.ts', 'key', urlPart!, key);
  else node('cdp.ts', 'wheel', urlPart!, wheel);
  const waited = tool('trace.ts', 'wait', 'overlay:show', '--since', String(since), '--count', count, '--timeout', timeout);
  // overlay:show 之後畫面還要一兩個 frame 才畫上
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const shot = join(shots, `${code}-${String(page).padStart(2, '0')}.png`);
  node('cdp.ts', 'shot', urlPart!, shot);
  console.log(`${code}-${page}  since L${since}  ${waited.out.replace(/\n/g, '  ')}  → ${shot}`);
  if (!waited.ok) {
    // Windows 上 npm 是 .cmd，要經過 shell；since 是數字，整行傳不必跳脫
    const summary = execSync(`npm run -s debug:summary -- --since ${since}`, { encoding: 'utf8' });
    console.log(summary.trim().split('\n').slice(-6).map((l) => `    ${l.slice(0, 200)}`).join('\n'));
  }
}
