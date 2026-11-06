/**
 * `npm run prod:connect`：用 op run 取一次唯讀 token（跳一次 1Password 授權），啟動本機唯讀 proxy（ADR 0011）。
 * 在 Terminal panel 跑，看到「連線中 →」就能用 prod:sql／prod:logs／prod:tail。
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseEnvFile } from './paddle-tunnel.ts';
import { READONLY_ENV_FILE, readonlyEnvProblem } from './prod-access.ts';
import { runWithOp } from './with-op.ts';

const problem = readonlyEnvProblem(existsSync(READONLY_ENV_FILE) ? parseEnvFile(readFileSync(READONLY_ENV_FILE, 'utf8')) : undefined);
if (problem) {
  console.error(problem);
  process.exit(1);
}
runWithOp(READONLY_ENV_FILE, [process.execPath, 'scripts/prod-proxy.ts']);
