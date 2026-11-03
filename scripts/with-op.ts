/**
 * 用 1Password CLI 提供開發用的 Claude key 跑一個指令（#175）：
 *   node scripts/with-op.ts <指令…>   →   op run --env-file ~/.config/naruhodo/op.env -- <指令…>
 *
 * op run 開始時向 1Password 要一次 key（跳一次授權，開發者因此知道 key 被用了），放進環境變數
 * NARUHODO_ANTHROPIC_KEY 交給整棵子行程，指令結束就沒了；key 不寫進任何檔案。
 * op.env 在 repo 外，只放指向 1Password 的參照（不是 key 本身），開發者自己建立；只找這一個路徑。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnvFile } from './paddle-tunnel.ts';

export const OP_ENV_FILE = join(homedir(), '.config', 'naruhodo', 'op.env');

const FORMAT = `請建立 ${OP_ENV_FILE}，內容是 1Password 裡測試用 Claude key 的參照（不是 key 本身）：
  NARUHODO_ANTHROPIC_KEY=op://<vault>/<item>/<field>`;

/** op.env 的內容（undefined＝檔案不存在）能不能用；不能用時回傳給開發者看的說明。 */
export function opEnvProblem(text: string | undefined): string | undefined {
  if (text === undefined) return `找不到 ${OP_ENV_FILE}。\n${FORMAT}`;
  if (!parseEnvFile(text).NARUHODO_ANTHROPIC_KEY?.startsWith('op://')) return `${OP_ENV_FILE} 裡沒有 NARUHODO_ANTHROPIC_KEY 的 op:// 參照。\n${FORMAT}`;
  return undefined;
}

function main(command: string[]): void {
  if (command.length === 0) {
    console.error('用法：node scripts/with-op.ts <指令…>');
    process.exit(2);
  }
  const problem = opEnvProblem(existsSync(OP_ENV_FILE) ? readFileSync(OP_ENV_FILE, 'utf8') : undefined);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const child = spawn('op', ['run', '--env-file', OP_ENV_FILE, '--', ...command], { stdio: 'inherit' });
  child.on('error', (error: NodeJS.ErrnoException) => {
    console.error(error.code === 'ENOENT' ? '找不到 op（1Password CLI）：https://developer.1password.com/docs/cli/get-started/' : error.message);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
